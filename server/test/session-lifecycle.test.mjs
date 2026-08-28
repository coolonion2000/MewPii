/**
 * Session lifecycle, initialization and queue safety regressions.
 * @author coolonion
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import WebSocket from "ws";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionHost, activeToolsForMode } from "../dist/session-host.js";

const root = fileURLToPath(new URL("../..", import.meta.url));

async function waitForServer(port, child, logs) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early\n${logs.join("")}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
    } catch {
      // still starting
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`server did not start\n${logs.join("")}`);
}

function socketInbox(ws) {
  const messages = [];
  const waiters = new Set();
  ws.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(message)) continue;
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });
  return {
    messages,
    waitFor(predicate, timeout = 10_000) {
      const existing = [...messages].reverse().find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolvePromise, reject) => {
        const waiter = {
          predicate,
          resolve: resolvePromise,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error(`websocket message timeout; messages=${JSON.stringify(messages.slice(-10))}`));
          }, timeout),
        };
        waiters.add(waiter);
      });
    },
  };
}

test("SessionHost queue safety and dispose are deterministic", async () => {
  let disposeCalls = 0;
  let promptCalls = 0;
  const session = {
    isStreaming: true,
    prompt: async () => { promptCalls += 1; },
  };
  const runtime = {
    session,
    dispose: async () => { disposeCalls += 1; },
  };
  const host = new SessionHost("fake", runtime, {});

  const imageResult = await host.handleCommand({
    type: "prompt",
    message: "queued image",
    images: [{ data: "AA==", mimeType: "image/png" }],
    streamingBehavior: "steer",
  });
  assert.equal(imageResult.ok, false);
  assert.match(imageResult.error, /图片|image/i);
  assert.equal(promptCalls, 0, "unsafe queued image reached SDK");

  const moveResult = await host.handleCommand({
    type: "queue_move",
    from: "steering",
    to: "followUp",
    index: 0,
  });
  assert.equal(moveResult.ok, false);
  assert.match(moveResult.error, /原子修改 API/);
  assert.deepEqual(activeToolsForMode(["read", "bash", "extension_tool", "grep"], "read-only"), ["read", "grep"]);
  assert.deepEqual(activeToolsForMode(["read", "bash", "extension_tool", "grep"], "default"), ["read", "bash"]);
  assert.deepEqual(activeToolsForMode(["read", "bash", "extension_tool", "grep"], "full"), ["read", "bash", "extension_tool", "grep"]);

  await Promise.all([host.dispose(), host.dispose()]);
  assert.equal(disposeCalls, 1, "runtime disposed more than once");
});

test("SessionHost orders newSession, setModel and prompt across socket callers", async () => {
  const host = new SessionHost("ordered", { session: {}, dispose: async () => undefined }, {});
  const events = [];
  host.handleCommand = async (command) => {
    events.push(`start:${command.type}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, command.type === "newSession" ? 20 : 1));
    events.push(`end:${command.type}`);
    return { ok: true };
  };
  const socketA = (command) => host.handleOrdered(command);
  const socketB = (command) => host.handleOrdered(command);
  await Promise.all([
    socketA({ type: "newSession" }),
    socketB({ type: "setModel", provider: "test", modelId: "model" }),
    socketA({ type: "prompt", message: "ordered" }),
  ]);
  assert.deepEqual(events, [
    "start:newSession", "end:newSession",
    "start:setModel", "end:setModel",
    "start:prompt", "end:prompt",
  ]);

  let releasePrompt;
  const promptGate = new Promise((resolvePromise) => { releasePrompt = resolvePromise; });
  host.handleCommand = async (command) => {
    events.push(`bypass:${command.type}`);
    if (command.type === "prompt") await promptGate;
    return { ok: true };
  };
  const pendingPrompt = socketA({ type: "prompt", message: "wait" });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  await socketB({ type: "abort" });
  assert.equal(events.at(-1), "bypass:abort", "abort waited behind prompt mutation");
  releasePrompt();
  await pendingPrompt;
  await host.dispose();
});

test("queue_clear bypasses a held prompt while preserving followUp queue order", async () => {
  const events = [];
  let releasePrompt;
  let promptCompleted = false;
  const promptGate = new Promise((resolvePromise) => { releasePrompt = resolvePromise; });
  const session = {
    isStreaming: false,
    prompt: async () => {
      events.push("prompt:start");
      await promptGate;
      promptCompleted = true;
      events.push("prompt:end");
    },
    followUp: async () => { events.push("followUp"); },
    clearQueue: () => { events.push("queue_clear"); },
  };
  const host = new SessionHost("queue-clear", { session, dispose: async () => undefined }, {});
  host.broadcastSnapshot = () => undefined;
  const heldPrompt = host.handleOrdered({ type: "prompt", message: "held" });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  const followUp = host.handleOrdered({ type: "followUp", message: "later" });
  const clear = host.handleOrdered({ type: "queue_clear" });
  await Promise.race([
    Promise.all([followUp, clear]),
    new Promise((_, reject) => setTimeout(() => reject(new Error("queue_clear waited for held prompt")), 100)),
  ]);
  assert.equal(promptCompleted, false);
  assert.deepEqual(events, ["prompt:start", "followUp", "queue_clear"]);
  releasePrompt();
  await heldPrompt;
  await host.dispose();
});

test("standard UI requests broadcast matching close reasons", async () => {
  const frames = [];
  const socket = {
    OPEN: WebSocket.OPEN,
    readyState: WebSocket.OPEN,
    send: (raw) => frames.push(JSON.parse(String(raw))),
    close: () => undefined,
  };
  const host = new SessionHost("ui", { session: { isStreaming: false }, dispose: async () => undefined }, {});
  host.sockets.add(socket);

  const answered = host.uiRequest({ kind: "input", title: "answer" }, 1000);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  const answerRequest = frames.findLast((frame) => frame.type === "ui_request").request.id;
  assert.equal((await host.handleCommand({ type: "ui_response", requestId: answerRequest, value: "ok" })).ok, true);
  assert.equal(await answered, "ok");
  assert.equal(frames.findLast((frame) => frame.type === "ui_close").reason, "answered");

  const timedOut = host.uiRequest({ kind: "confirm", title: "timeout" }, 5);
  await timedOut;
  assert.equal(frames.findLast((frame) => frame.type === "ui_close").reason, "timeout");

  const rebound = host.uiRequest({ kind: "select", title: "rebind" }, 1000);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  host.teardownSessionUi("rebind");
  await rebound;
  assert.equal(frames.findLast((frame) => frame.type === "ui_close").reason, "rebind");

  const disposed = host.uiRequest({ kind: "input", title: "dispose" }, 1000);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  await host.dispose();
  await disposed;
  assert.equal(frames.findLast((frame) => frame.type === "ui_close").reason, "dispose");
});

test("ui_response bypasses a held prompt through handleOrdered", async () => {
  let releasePrompt;
  let promptCompleted = false;
  const promptGate = new Promise((resolvePromise) => { releasePrompt = resolvePromise; });
  const frames = [];
  const socket = {
    OPEN: WebSocket.OPEN,
    readyState: WebSocket.OPEN,
    send: (raw) => frames.push(JSON.parse(String(raw))),
    close: () => undefined,
  };
  const session = {
    isStreaming: false,
    prompt: async () => {
      await promptGate;
      promptCompleted = true;
    },
  };
  const host = new SessionHost("ordered-ui", { session, dispose: async () => undefined }, {});
  host.sockets.add(socket);
  const answered = host.uiRequest({ kind: "input", title: "answer while held" }, 1000);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  const requestId = frames.findLast((frame) => frame.type === "ui_request").request.id;
  const heldPrompt = host.handleOrdered({ type: "prompt", message: "held" });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  const response = await Promise.race([
    host.handleOrdered({ type: "ui_response", requestId, value: "ok" }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("ui_response waited for held prompt")), 100)),
  ]);
  assert.equal(response.ok, true);
  assert.equal(await answered, "ok");
  assert.equal(promptCompleted, false);
  releasePrompt();
  await heldPrompt;
  await host.dispose();
});

test("rebind clears delayed snapshot timer", async () => {
  let subscriber;
  const session = {
    subscribe: (callback) => {
      subscriber = callback;
      return () => undefined;
    },
  };
  const frames = [];
  const host = new SessionHost("snapshot-timer", { session, dispose: async () => undefined }, {});
  host.sockets.add({ OPEN: WebSocket.OPEN, readyState: WebSocket.OPEN, send: (raw) => frames.push(JSON.parse(String(raw))), close: () => undefined });
  host.bindSession();
  subscriber({ type: "agent_end" });
  host.bindSession();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  assert.equal(frames.some((frame) => frame.type === "snapshot"), false);
  await host.dispose();
});

test("session single-flight, init buffering, rebind index and watcher", { timeout: 40_000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "mewpii-session-lifecycle-"));
  const home = join(temp, "home");
  const workspace = join(temp, "workspace");
  const wrongCwd = join(temp, "wrong-cwd");
  const sessionDir = join(home, ".pi", "agent", "sessions", "test");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(wrongCwd, { recursive: true }),
    mkdir(sessionDir, { recursive: true }),
  ]);
  const manager = SessionManager.create(workspace, sessionDir);
  const sessionPath = manager.getSessionFile();
  assert.ok(sessionPath);
  const now = new Date().toISOString();
  await writeFile(
    sessionPath,
    [
      JSON.stringify({ type: "session", version: 3, id: manager.getSessionId(), timestamp: now, cwd: workspace }),
      JSON.stringify({
        type: "message",
        id: "seed-entry",
        parentId: null,
        timestamp: now,
        message: { role: "user", content: "seed", timestamp: Date.now() },
      }),
    ].join("\n") + "\n",
  );

  const port = 37_000 + Math.floor(Math.random() * 2_000);
  const logs = [];
  const child = spawn(process.execPath, ["server/dist/index.js", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: root,
    env: { ...process.env, HOME: home, PII_PASSWORD: "", PII_WORKSPACE_ROOTS: temp },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));

  const sockets = [];
  try {
    await waitForServer(port, child, logs);
    const stateMutations = await Promise.all([
      fetch(`http://127.0.0.1:${port}/api/state/favorites`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
        body: JSON.stringify({ cwd: workspace, favorite: true }),
      }),
      fetch(`http://127.0.0.1:${port}/api/state/project-order`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
        body: JSON.stringify({ cwd: workspace, visibleOrder: [workspace] }),
      }),
    ]);
    for (const response of stateMutations)
      assert.equal(response.ok, true, `state mutation failed status=${response.status} body=${await response.text()}`);
    const sidebarState = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    assert.deepEqual(sidebarState.favorites, [workspace]);
    assert.deepEqual(sidebarState.projectOrder, [workspace]);
    assert.equal(sidebarState.version, 2);

    const thirdMutation = await fetch(`http://127.0.0.1:${port}/api/state/favorites`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ cwd: workspace, favorite: true }),
    });
    assert.equal(thirdMutation.ok, true);
    await writeFile(join(home, ".pi", "agent", "pii-web-state.json"), "{corrupt");
    const recoveredState = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    assert.deepEqual(recoveredState.favorites, [workspace]);
    assert.deepEqual(recoveredState.projectOrder, [workspace]);
    assert.equal(recoveredState.version, 2, "backup was not used after primary corruption");

    const recoveryMutation = await fetch(`http://127.0.0.1:${port}/api/state/favorites`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ cwd: workspace, favorite: false }),
    });
    assert.equal(recoveryMutation.ok, true);
    const statePath = join(home, ".pi", "agent", "pii-web-state.json");
    const backupPath = `${statePath}.bak`;
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).version, 3);
    assert.equal(JSON.parse(await readFile(backupPath, "utf8")).version, 3);
    await writeFile(statePath, "{corrupt-again");
    const twiceRecovered = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    assert.deepEqual(twiceRecovered.favorites, []);
    assert.deepEqual(twiceRecovered.projectOrder, [workspace]);
    assert.equal(twiceRecovered.version, 3, "recovered write did not refresh both primary and backup");

    const logoutResponse = await fetch(`http://127.0.0.1:${port}/api/auth/provider/logout`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ provider: "missing-provider" }),
    });
    assert.equal(logoutResponse.status, 404);
    assert.match((await logoutResponse.json()).error, /provider not found/);

    const skillResponse = await fetch(`http://127.0.0.1:${port}/api/skills`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ name: "review-skill", description: "persisted", content: "body" }),
    });
    assert.equal(skillResponse.ok, true);
    const skill = await skillResponse.json();
    assert.equal(skill.path, join(home, ".pi", "agent", "skills", "review-skill", "SKILL.md"));
    assert.match(await readFile(skill.path, "utf8"), /description: persisted/);

    const roguePath = join(temp, "rogue.jsonl");
    await writeFile(roguePath, await readFile(sessionPath, "utf8"));
    const rogueWs = new WebSocket(`ws://127.0.0.1:${port}/ws?cwd=${encodeURIComponent(workspace)}&session=${encodeURIComponent(roguePath)}`);
    sockets.push(rogueWs);
    const [rogueCode] = await new Promise((resolvePromise) => rogueWs.once("close", (...args) => resolvePromise(args)));
    assert.equal(rogueCode, 1011, "unmanaged session path was accepted");

    const outsideWs = new WebSocket(`ws://127.0.0.1:${port}/ws?cwd=${encodeURIComponent("/etc")}`);
    sockets.push(outsideWs);
    const [outsideCode] = await new Promise((resolvePromise) => outsideWs.once("close", (...args) => resolvePromise(args)));
    assert.equal(outsideCode, 1011, "new workspace escaped configured roots");

    const newWs = new WebSocket(`ws://127.0.0.1:${port}/ws?cwd=${encodeURIComponent(workspace)}`);
    sockets.push(newWs);
    const newInbox = socketInbox(newWs);
    assert.equal((await newInbox.waitFor((message) => message.type === "snapshot")).snapshot.cwd, await realpath(workspace));
    newWs.close();

    const url = `ws://127.0.0.1:${port}/ws?cwd=${encodeURIComponent("/etc")}&session=${encodeURIComponent(sessionPath)}`;
    const ws1 = new WebSocket(url);
    const ws2 = new WebSocket(url);
    sockets.push(ws1, ws2);
    const inbox1 = socketInbox(ws1);
    const inbox2 = socketInbox(ws2);
    ws1.on("open", () => {
      ws1.send(JSON.stringify({ id: "init-1", type: "setSessionName", name: "first" }));
      ws1.send(JSON.stringify({ id: "init-2", type: "setSessionName", name: "second" }));
    });

    const [snap1, snap2] = await Promise.all([
      inbox1.waitFor((message) => message.type === "snapshot"),
      inbox2.waitFor((message) => message.type === "snapshot"),
    ]);
    assert.equal(snap1.snapshot.sessionId, snap2.snapshot.sessionId, "two runtimes opened the same session");
    assert.equal(snap1.snapshot.cwd, workspace, "client cwd overrode session header cwd");
    assert.equal(snap1.snapshot.queueCapabilities.reorder, false);
    assert.equal(snap1.snapshot.queueCapabilities.remove, false);
    assert.match(snap1.snapshot.queueCapabilities.reason, /SDK/);

    const [init1, init2] = await Promise.all([
      inbox1.waitFor((message) => message.type === "command_result" && message.id === "init-1"),
      inbox1.waitFor((message) => message.type === "command_result" && message.id === "init-2"),
    ]);
    assert.equal(init1.ok, true, init1.error);
    assert.equal(init2.ok, true, init2.error);
    const historySnapshot = await inbox1.waitFor(
      (message) => message.type === "snapshot" && message.snapshot.name === "second",
    );
    ws1.send(JSON.stringify({ id: "history-command", type: "history", before: 1, requestId: "history-request-1" }));
    const history = await inbox1.waitFor((message) => message.type === "history" && message.requestId === "history-request-1");
    assert.equal(history.sessionId, historySnapshot.snapshot.sessionId);
    assert.equal(history.branchHeadId, historySnapshot.snapshot.branchHeadId);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    assert.equal(inbox2.messages.some((message) => message.type === "history" && message.requestId === "history-request-1"), false);

    ws1.send(JSON.stringify({ id: "queue-move", type: "queue_move", from: "steering", to: "followUp", index: 0 }));
    const queueMove = await inbox1.waitFor((message) => message.type === "command_result" && message.id === "queue-move");
    assert.equal(queueMove.ok, false);
    assert.match(queueMove.error, /原子修改 API/);

    const entryId = snap1.snapshot.messages[0]?._entryId;
    assert.ok(entryId, "seed entry missing");
    ws1.send(JSON.stringify({ id: "fork-1", type: "fork", entryId }));
    const forkResult = await inbox1.waitFor((message) => message.type === "command_result" && message.id === "fork-1", 15_000);
    assert.equal(forkResult.ok, true, forkResult.error);
    const forkFile = forkResult.data?.sessionFile;
    assert.ok(forkFile);
    const rebound = await inbox1.waitFor((message) => message.type === "snapshot" && message.snapshot.sessionFile === forkFile);

    const ws3 = new WebSocket(`ws://127.0.0.1:${port}/ws?cwd=${encodeURIComponent(wrongCwd)}&session=${encodeURIComponent(forkFile)}`);
    sockets.push(ws3);
    const inbox3 = socketInbox(ws3);
    const snap3 = await inbox3.waitFor((message) => message.type === "snapshot");
    assert.equal(snap3.snapshot.sessionId, rebound.snapshot.sessionId, "forked file was opened by a duplicate runtime");
    assert.equal(snap3.snapshot.cwd, workspace);

    const forkNow = new Date().toISOString();
    await writeFile(
      forkFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: rebound.snapshot.sessionId,
          timestamp: forkNow,
          cwd: workspace,
        }),
        JSON.stringify({
          type: "message",
          id: "seed-entry",
          parentId: null,
          timestamp: forkNow,
          message: { role: "user", content: "seed", timestamp: Date.now() },
        }),
      ].join("\n") + "\n",
    );
    ws1.send(JSON.stringify({ id: "persist-fork", type: "setSessionName", name: "fork-persisted" }));
    const persisted = await inbox1.waitFor(
      (message) => message.type === "command_result" && message.id === "persist-fork",
    );
    assert.equal(persisted.ok, true, persisted.error);
    const forkLines = (await readFile(forkFile, "utf8")).trim().split("\n");
    const lastEntry = JSON.parse(forkLines[forkLines.length - 1]);
    await appendFile(
      forkFile,
      JSON.stringify({
        type: "session_info",
        id: "external-info",
        parentId: lastEntry.id ?? null,
        timestamp: new Date().toISOString(),
        name: "external-watch-name",
      }) + "\n",
    );
    const watched = await inbox1.waitFor(
      (message) => message.type === "snapshot" && message.snapshot.name === "external-watch-name",
      12_000,
    );
    assert.equal(watched.snapshot.cwd, workspace, "watcher rebind changed cwd");

    ws1.send(JSON.stringify({ id: "ordered-new", type: "newSession" }));
    ws1.send(JSON.stringify({ id: "ordered-name", type: "setSessionName", name: "ordered-after-new" }));
    const orderedNew = await inbox1.waitFor((message) => message.type === "command_result" && message.id === "ordered-new", 15_000);
    const orderedName = await inbox1.waitFor((message) => message.type === "command_result" && message.id === "ordered-name", 15_000);
    assert.equal(orderedNew.ok, true, orderedNew.error);
    assert.equal(orderedName.ok, true, orderedName.error);
    await inbox1.waitFor((message) => message.type === "snapshot" && message.snapshot.name === "ordered-after-new");
    const resultIds = inbox1.messages.filter((message) => message.type === "command_result").map((message) => message.id);
    assert.ok(resultIds.indexOf("ordered-new") < resultIds.indexOf("ordered-name"), "normal command arrival order was not preserved");
  } finally {
    for (const ws of sockets) ws.close();
    child.kill("SIGTERM");
    await new Promise((resolvePromise) => child.once("exit", resolvePromise));
    await rm(temp, { recursive: true, force: true });
  }
});
