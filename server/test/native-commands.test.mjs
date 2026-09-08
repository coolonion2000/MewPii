/** Native command coverage and live extension discovery. @author coolonion */
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import WebSocket from "ws";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { NATIVE_COMMANDS, runNativeCommand } from "../dist/native-commands.js";
import { SessionHost } from "../dist/session-host.js";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("every installed Pi built-in has a Web command (detect SDK upgrades)", async () => {
  const { BUILTIN_SLASH_COMMANDS } = await import(new URL("./core/slash-commands.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
  assert.deepEqual(Object.keys(NATIVE_COMMANDS).sort(), BUILTIN_SLASH_COMMANDS.map(c => c.name).sort());
});

test("compact preserves custom instructions; cancelled replacement stays cancelled", async () => {
  let instructions;
  const host = { session: { compact: async value => { instructions = value; } }, sockets: new Set(),
    runtime: { newSession: async () => ({ cancelled: true }) }, broadcastSnapshot() {} };
  assert.equal((await SessionHost.prototype.runSlash.call(host, "/compact keep the API decisions")).ok, true);
  assert.equal(instructions, "keep the API decisions");
  assert.match((await SessionHost.prototype.runSlash.call(host, "/new")).data.output, /取消/);
});

test("destructive native commands reject multiple viewers and busy sessions", async () => {
  for (const name of ["new", "fork", "clone", "resume", "import", "tree"]) {
    const host = { session: {}, sockets: new Set([1, 2]) };
    assert.equal((await SessionHost.prototype.runSlash.call(host, `/${name}`)).ok, false, name);
  }
  for (const name of ["settings", "model", "thinking", "scoped-models", "fork", "resume", "import", "reload"]) {
    const host = { session: { isStreaming: true }, sockets: new Set() };
    assert.equal((await SessionHost.prototype.runSlash.call(host, `/${name}`)).ok, false, name);
  }
});

test("replacement is rechecked after a dialog; cancelled share never exports", async () => {
  let exported = false;
  const result = await runNativeCommand("share", "", {
    session: { exportToHtml() { exported = true; } }, ui: async () => false,
  });
  assert.match(result.output, /取消/);
  assert.equal(exported, false);
  await assert.rejects(runNativeCommand("clone", "", {
    session: { sessionManager: { getLeafId: () => "leaf" } },
    assertCanReplace() { throw new Error("another viewer attached"); }, runtime: {},
  }), /another viewer/);
});

function inbox(ws) {
  let messages = [];
  ws.on("message", data => {
    const message = JSON.parse(String(data));
    if (message.type === "custom_ui_close") messages = messages.filter(m => m.frame?.requestId !== message.requestId);
    if (message.type === "ui_close") messages = messages.filter(m => m.request?.id !== message.requestId);
    messages.push(message);
  });
  return async (predicate, timeout = 10_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return messages.splice(index, 1)[0];
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`WebSocket timeout: ${JSON.stringify(messages.slice(-5)).slice(0, 4000)}`);
  };
}

test("WebSocket: native settings persist, file/copy dialogs, automatic new plugins and editor bridge", { timeout: 45_000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "mewpii-native-"));
  const home = join(temp, "home");
  const cwd = join(temp, "workspace");
  const agentDir = join(home, ".pi", "agent");
  const extensionDir = join(agentDir, "extensions");
  await mkdir(extensionDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const manager = SessionManager.create(cwd, join(agentDir, "sessions", "--fixture--"));
  manager.appendMessage({ role: "user", content: [{ type: "text", text: "example user" }], timestamp: Date.now() });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "example assistant" }], api: "openai-completions", provider: "fixture", model: "fixture",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
  const port = 38_000 + Math.floor(Math.random() * 5_000);
  const logs = [];
  const child = spawn(process.execPath, ["server/dist/index.js", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: root, env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, PII_PASSWORD: "", PII_WORKSPACE_ROOTS: temp }, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", chunk => logs.push(String(chunk)));
  child.stderr.on("data", chunk => logs.push(String(chunk)));
  let ws;
  try {
    for (let i = 0; i < 150; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch {}
      if (child.exitCode !== null) throw new Error(logs.join(""));
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws?cwd=${encodeURIComponent(cwd)}&session=${encodeURIComponent(manager.getSessionFile())}`);
    const next = inbox(ws);
    const ready = await next(m => (m.type === "snapshot" || m.type === "session_ready") && !m.snapshot.initializing);
    assert.equal(ready.snapshot.slashCommands.filter(c => c.source === "builtin").length, 23);
    let seq = 0;
    const start = raw => { const id = `slash-${++seq}`; ws.send(JSON.stringify({ id, type: "slash", raw })); return id; };
    const result = async id => {
      const message = await next(m => m.type === "command_result" && m.id === id);
      assert.equal(message.ok, true, message.error);
      return message.data;
    };
    const answer = (request, value) => ws.send(JSON.stringify({ type: "ui_response", requestId: request.id, value }));
    const cancelNative = async name => {
      const id = start(`/${name}`);
      const message = await next(m => m.type === "custom_ui_frame" || m.type === "ui_request" || (m.type === "command_result" && m.id === id));
      assert.notEqual(message.type, "command_result", `${name} did not open an interaction: ${JSON.stringify(message)}`);
      if (message.type === "custom_ui_frame") ws.send(JSON.stringify({ type: "custom_ui_cancel", requestId: message.frame.requestId }));
      else answer(message.request, undefined);
      await result(id);
    };

    const settingsId = start("/settings");
    const settings = (await next(m => m.type === "custom_ui_frame")).frame;
    assert.match(settings.lines.join("\n"), /Auto-compact/);
    ws.send(JSON.stringify({ type: "custom_ui_input", requestId: settings.requestId, data: "\r" }));
    await next(m => m.type === "custom_ui_frame" && m.frame.requestId === settings.requestId && m.frame.revision > settings.revision);
    ws.send(JSON.stringify({ type: "custom_ui_input", requestId: settings.requestId, data: "\u001b" }));
    await result(settingsId);
    const saved = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
    assert.equal(saved.compaction.enabled, false, "native settings callback did not persist");

    // Clear stale render frames before the next command by matching request lifetimes.
    for (const command of ["model", "tree", "thinking", "scoped-models", "fork", "resume", "import", "trust", "share", "login"])
      await cancelNative(command);
    const logoutId = start("/logout");
    assert.match((await next(m => m.type === "command_result" && m.id === logoutId)).error, /没有可移除/);
    const copyId = start("/copy");
    const copy = (await next(m => m.type === "ui_request" && m.request.kind === "copy")).request;
    assert.equal(copy.content, "example assistant"); answer(copy, true); await result(copyId);

    const exportId = start("/export");
    answer((await next(m => m.type === "ui_request" && m.request.kind === "select")).request, "JSONL");
    const download = (await next(m => m.type === "ui_request" && m.request.kind === "download")).request;
    assert.match(download.content, /example assistant/); answer(download, true); await result(exportId);
    for (const command of ["name example", "session", "changelog", "hotkeys", "reload"])
      await result(start(`/${command}`));

    // No /reload and no reconnect: installing a new extension updates the existing browser.
    await writeFile(join(extensionDir, "auto-plugin.js"), `export default pi => {
      pi.registerCommand('auto-plugin', { description: 'automatic discovery fixture', handler: async (_args, ctx) => {
        const value = await ctx.ui.editor('Plugin editor', 'prefilled');
        if (value !== undefined) ctx.ui.setEditorText('plugin: ' + value);
      }});
    };`);
    await next(m => (m.type === "snapshot" || m.type === "session_ready") && m.snapshot.slashCommands?.some(c => c.name === "auto-plugin"), 15_000);
    const pluginId = start("/auto-plugin");
    const editor = (await next(m => m.type === "ui_request" && m.request.kind === "editor")).request;
    assert.equal(editor.content, "prefilled"); answer(editor, "edited");
    assert.equal((await next(m => m.type === "editor_text")).text, "plugin: edited");
    await result(pluginId);
    // Native HTML export and import exercise real SDK serializers and runtime replacement.
    const htmlPath = join(temp, "exported.html");
    await result(start(`/export ${htmlPath}`));
    const html = await readFile(htmlPath, "utf8");
    const embedded = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
    assert.ok(embedded, "HTML export has no session data");
    assert.match(Buffer.from(embedded, "base64").toString("utf8"), /example assistant/);
    await result(start(`/import ${manager.getSessionFile()}`));
    await result(start("/clone"));
    await result(start("/new"));
    assert.equal((await result(start("/quit"))).action, "quit");
  } catch (cause) {
    throw new Error(`${cause.stack}\n${logs.join("").slice(-8000)}`);
  } finally {
    ws?.terminate(); child.kill("SIGTERM");
    if (child.exitCode === null) await once(child, "exit");
    await rm(temp, { recursive: true, force: true });
  }
});
