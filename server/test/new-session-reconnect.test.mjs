/** New-session preview reattachment over an isolated WebSocket server. @author coolonion */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import WebSocket from "ws";

const root = fileURLToPath(new URL("../..", import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, description) {
  for (let attempt = 0; attempt < 600; attempt++) {
    const value = read();
    if (value) return value;
    await delay(25);
  }
  throw new Error(`timed out: ${description}`);
}

function viewer(url) {
  const ws = new WebSocket(url);
  const frames = [];
  let error;
  ws.on("error", (cause) => { error = cause; });
  ws.on("message", (raw) => frames.push(JSON.parse(String(raw))));
  return {
    ws, frames,
    wait: (predicate) => until(() => {
      if (error) throw error;
      return frames.find(predicate);
    }, "websocket frame"),
  };
}
const isPreview = (frame) => frame.type === "snapshot" && frame.snapshot.initializing;
const isReady = (frame) => ["snapshot", "session_ready"].includes(frame.type) && frame.snapshot.initializing === false;

test("nonexistent new-session preview reattaches before initialization and unknown paths fail closed", { timeout: 40_000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "mewpii-new-reconnect-"));
  const home = join(temp, "home");
  const workspace = join(temp, "workspace");
  const otherWorkspace = join(temp, "other-workspace");
  const extensions = join(home, ".pi", "agent", "extensions");
  const gate = join(temp, "release-startup");
  const failGate = join(temp, "fail-startup");
  const failWorkspace = join(temp, "fail-workspace");
  await mkdir(failWorkspace, { recursive: true });
  const preload = join(temp, "fail-creation.mjs");
  // Inject a deterministic factory failure only in this child process; no
  // production test switch and no extension/network dependency for rejection.
  await writeFile(preload, `
import { existsSync } from "node:fs";
import { SessionHost } from ${JSON.stringify(new URL("../dist/session-host.js", import.meta.url).href)};
const create = SessionHost.create;
SessionHost.create = async function (key, opts) {
  if (!opts.cwd.endsWith("/fail-workspace")) return create.call(this, key, opts);
  await opts.onPreview({ cwd: opts.cwd, sessionId: "failed-preview-id", sessionFile: opts.cwd + "/failed.jsonl", initializing: true, messages: [] });
  const deadline = Date.now() + 30000;
  while (!existsSync(${JSON.stringify(failGate)})) {
    if (Date.now() > deadline) throw new Error("test failure gate timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("injected creation failure");
};
`);
  await mkdir(extensions, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(otherWorkspace, { recursive: true });
  // A filesystem latch, not a timing assumption: startup cannot finish until
  // the test has received both reattachment previews and checked rejection.
  await writeFile(join(extensions, "startup-gate.js"), `
import { existsSync } from "node:fs";
const deadline = Date.now() + 30000;
while (!existsSync(${JSON.stringify(gate)})) {
  if (Date.now() > deadline) throw new Error("test startup gate timed out");
  await new Promise((resolve) => setTimeout(resolve, 10));
}
export default function () {}
`);
  const logs = [];
  const child = spawn(process.execPath, ["--import", preload, "server/dist/index.js", "--host", "127.0.0.1", "--port", "0"], {
    cwd: root,
    env: { ...process.env, HOME: home, PII_PASSWORD: "", PII_WORKSPACE_ROOTS: temp },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (data) => logs.push(String(data)));
  child.stderr.on("data", (data) => logs.push(String(data)));
  const viewers = [];
  try {
    const port = await until(() => {
      if (child.exitCode !== null) throw new Error(logs.join(""));
      return logs.join("").match(/MewPii listening on http:\/\/127\.0\.0\.1:(\d+)/)?.[1];
    }, "isolated server startup");
    const base = `ws://127.0.0.1:${port}/ws?snapshotDelta=1&cwd=${encodeURIComponent(workspace)}`;
    const open = (url) => { const result = viewer(url); viewers.push(result); return result; };
    const original = open(base);
    const preview = (await original.wait(isPreview)).snapshot;
    assert.ok(preview.sessionFile);
    assert.equal(existsSync(preview.sessionFile), false, "preview must precede durable session file");
    original.ws.close();
    const resolveSession = (id) => fetch(`http://127.0.0.1:${port}/api/sessions/resolve?id=${encodeURIComponent(id)}`);
    const resolvedResponse = await resolveSession(preview.sessionId);
    assert.equal(resolvedResponse.status, 200);
    const resolved = await resolvedResponse.json();
    assert.deepEqual(resolved, { cwd: preview.cwd, path: preview.sessionFile, id: preview.sessionId, live: true });
    assert.equal((await resolveSession("unknown-preview-id")).status, 404);
    assert.equal((await resolveSession(preview.sessionId.slice(0, 8))).status, 404, "pending IDs match exactly");
    const reconnect = open(`${base}&session=${encodeURIComponent(resolved.path)}`);
    const secondTab = open(`${base}&session=${encodeURIComponent(preview.sessionFile)}`);
    for (const client of [reconnect, secondTab]) {
      assert.equal((await client.wait(isPreview)).snapshot.sessionId, preview.sessionId);
      assert.equal(client.frames.some(isReady), false, "gate must still hold startup");
    }
    const unknown = open(`${base}&session=${encodeURIComponent(join(temp, "unowned.jsonl"))}`);
    const rejected = await unknown.wait((frame) => frame.type === "command_result");
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /session not found/);
    const unownedExistingPath = join(workspace, "unowned-existing.jsonl");
    await writeFile(unownedExistingPath, "{}\n");
    const unownedExisting = open(`${base}&session=${encodeURIComponent(unownedExistingPath)}`);
    assert.match((await unownedExisting.wait((frame) => frame.type === "command_result")).error, /session path is not managed by pi/);
    const wrongCwd = open(`ws://127.0.0.1:${port}/ws?cwd=${encodeURIComponent(otherWorkspace)}&session=${encodeURIComponent(preview.sessionFile)}`);
    assert.match((await wrongCwd.wait((frame) => frame.type === "command_result")).error, /workspace mismatch/);
    await writeFile(gate, "ready");
    for (const client of [reconnect, secondTab]) {
      const ready = (await client.wait(isReady)).snapshot;
      assert.equal(ready.sessionId, preview.sessionId);
      assert.equal(client.frames.some((frame) => frame.type === "command_result" && !frame.ok), false);
      assert.equal(client.ws.readyState, WebSocket.OPEN);
    }
    reconnect.ws.send(JSON.stringify({ id: "rename", type: "setSessionName", name: "same-new-host" }));
    assert.equal((await reconnect.wait((frame) => frame.id === "rename")).ok, true);
    await secondTab.wait((frame) => frame.type === "snapshot" && frame.snapshot.name === "same-new-host");
    // Ready hosts also own unflushed files after pending ownership is cleaned.
    const readyReconnect = open(`${base}&session=${encodeURIComponent(preview.sessionFile)}`);
    assert.equal((await readyReconnect.wait(isReady)).snapshot.sessionId, preview.sessionId);
    const failing = open(`ws://127.0.0.1:${port}/ws?cwd=${encodeURIComponent(failWorkspace)}`);
    const failedPreview = (await failing.wait(isPreview)).snapshot;
    assert.equal((await resolveSession(failedPreview.sessionId)).status, 200);
    const failedReattachUrl = `ws://127.0.0.1:${port}/ws?cwd=${encodeURIComponent(failWorkspace)}&session=${encodeURIComponent(failedPreview.sessionFile)}`;
    const failedReattach = open(failedReattachUrl);
    await failedReattach.wait(isPreview);
    await writeFile(failGate, "fail");
    for (const client of [failing, failedReattach]) {
      const result = await client.wait((frame) => frame.type === "command_result");
      assert.equal(result.ok, false);
      assert.match(result.error, /injected creation failure/);
    }
    assert.equal((await resolveSession(failedPreview.sessionId)).status, 404, "failed preview ID must lose ownership");
    const afterFailure = open(failedReattachUrl);
    assert.match((await afterFailure.wait((frame) => frame.type === "command_result")).error, /session not found/);
    const output = logs.join("");
    assert.equal((output.match(/stage=open .*mode="new"/g) ?? []).length, 1, output);
    assert.match(output, /pending_reattach/);
    assert.match(output, /creation_settled status=ready .*pending=0/);
  } catch (cause) {
    throw new Error(`${cause.stack}\n${logs.join("")}`);
  } finally {
    for (const client of viewers) client.ws.terminate();
    if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
    await rm(temp, { recursive: true, force: true });
  }
});
