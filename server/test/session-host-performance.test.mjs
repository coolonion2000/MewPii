/** SessionHost startup/readiness and bounded snapshot regressions. */
import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import {
  SESSION_HISTORY_MAX_BYTES,
  SESSION_HISTORY_MAX_MESSAGES,
  SessionHost,
} from "../dist/session-host.js";

function socketFrames() {
  const frames = [];
  return {
    frames,
    socket: {
      OPEN: WebSocket.OPEN,
      readyState: WebSocket.OPEN,
      send(raw) {
        frames.push(JSON.parse(String(raw)));
      },
      close() {},
    },
  };
}

function fakeStats() {
  return {
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 0,
    tokens: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      total: 2,
    },
    cost: 0,
    contextUsage: undefined,
  };
}

test("snapshot caches stable branch metadata and bounds both snapshot and history pages", async () => {
  let leaf = "e199";
  let branchReads = 0;
  let statsReads = 0;
  let commandReads = 0;
  const entries = Array.from({ length: 200 }, (_, index) => ({
    type: "message",
    id: `e${index}`,
    message: {
      role: index % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `${index}:${"x".repeat(8_000)}` }],
    },
  }));
  const session = {
    sessionId: "bounded",
    sessionFile: undefined,
    sessionName: undefined,
    isStreaming: false,
    thinkingLevel: "medium",
    model: undefined,
    messages: entries.map((entry) => entry.message),
    sessionManager: {
      getLeafId: () => leaf,
      getBranch: () => {
        branchReads += 1;
        return entries;
      },
    },
    getSessionStats: () => {
      statsReads += 1;
      return fakeStats();
    },
    getAvailableThinkingLevels: () => ["medium"],
    getActiveToolNames: () => ["read"],
    extensionRunner: {
      getRegisteredCommands: () => {
        commandReads += 1;
        return [{ invocationName: "extension-command", description: "test" }];
      },
    },
    promptTemplates: [],
    resourceLoader: {
      getSkills: () => ({ skills: [] }),
    },
  };
  const host = new SessionHost(
    "bounded",
    { session, cwd: "/tmp", dispose: async () => undefined },
    {},
  );

  const first = host.snapshot();
  const second = host.snapshot();
  assert.equal(branchReads, 1, "unchanged branch was normalized twice");
  assert.equal(statsReads, 1, "unchanged stats were recomputed twice");
  assert.equal(commandReads, 1, "unchanged slash commands were enumerated twice");
  assert.equal(first.totalMessages, 200);
  assert.equal(first.messages.length < SESSION_HISTORY_MAX_MESSAGES, true);
  assert.equal(
    Buffer.byteLength(JSON.stringify(first.messages)) <=
      SESSION_HISTORY_MAX_BYTES,
    true,
  );
  assert.deepEqual(second.messages, first.messages);

  entries.push({
    type: "message",
    id: "e200",
    message: { role: "user", content: [{ type: "text", text: "new" }] },
  });
  session.messages.push(entries.at(-1).message);
  leaf = "e200";
  const changed = host.snapshot();
  assert.equal(branchReads, 2);
  assert.equal(statsReads, 2);
  assert.equal(commandReads, 1, "branch changes invalidated command metadata");

  const { socket, frames } = socketFrames();
  host.sendHistory(socket, changed.historyFrom, "older");
  const history = frames.at(-1);
  assert.equal(history.type, "history");
  assert.equal(history.before < changed.historyFrom, true);
  assert.equal(history.messages.length <= SESSION_HISTORY_MAX_MESSAGES, true);
  assert.equal(
    Buffer.byteLength(JSON.stringify(history.messages)) <=
      SESSION_HISTORY_MAX_BYTES,
    true,
  );
  assert.equal(
    history.messages.at(-1)._entryId,
    `e${changed.historyFrom - 1}`,
    "bounded pagination skipped or duplicated the branch boundary",
  );
  await host.dispose();
});

test("an oversized durable message still advances the history cursor", async () => {
  const session = {
    sessionId: "oversized",
    sessionFile: undefined,
    isStreaming: false,
    thinkingLevel: "off",
    messages: [],
  };
  const host = new SessionHost(
    "oversized",
    { session, dispose: async () => undefined },
    {},
  );
  host.lastBranch = [
    {
      role: "user",
      _entryId: "huge",
      content: "x".repeat(SESSION_HISTORY_MAX_BYTES + 1),
    },
  ];
  host.lastBranchBytes = [];
  const { socket, frames } = socketFrames();
  host.sendHistory(socket, 1, "huge-page");
  assert.equal(frames[0].before, 0);
  assert.equal(frames[0].messages.length, 1);
  assert.equal(frames[0].messages[0]._entryId, "huge");
  await host.dispose();
});

test("attach can answer startup UI while ordinary commands remain unavailable", async () => {
  let clearCalls = 0;
  let abortCalls = 0;
  let startupAnswer;
  const session = {
    sessionId: "startup-ui",
    sessionFile: undefined,
    isStreaming: false,
    messages: [],
    resourceLoader: {
      getExtensions: () => ({ extensions: [], errors: [] }),
    },
    async bindExtensions({ uiContext }) {
      startupAnswer = await uiContext.input("Startup input", "value");
    },
    clearQueue() {
      clearCalls += 1;
    },
    async abort() {
      abortCalls += 1;
    },
  };
  const host = new SessionHost(
    "startup-ui",
    { session, dispose: async () => undefined },
    {},
  );
  host.snapshot = () => ({
    sessionId: session.sessionId,
    cwd: "/tmp",
    initializing: !host.isReady,
    isStreaming: false,
    thinkingLevel: "off",
    messages: [],
    totalMessages: 0,
    historyFrom: 0,
    queue: { steering: [], followUp: [] },
    queueCapabilities: { revision: 0, reorder: false, remove: false },
    tools: [],
    slashCommands: [],
  });

  const binding = host.startExtensionBinding(session);
  let readySettled = false;
  host.whenReady().then(() => {
    readySettled = true;
  });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(host.isReady, false);
  assert.equal(readySettled, false);

  const { socket, frames } = socketFrames();
  host.attach(socket);
  assert.equal(frames[0].type, "snapshot");
  assert.equal(frames[0].snapshot.initializing, true);
  const request = frames.find((frame) => frame.type === "ui_request");
  assert.ok(request, "pending startup dialog was not replayed after attach");

  const blocked = await host.handleOrdered({ type: "queue_clear" });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /initializing/);
  assert.equal(clearCalls, 0);

  const aborted = await host.handleOrdered({ type: "abort" });
  assert.equal(aborted.ok, true, "abort should remain available during startup");
  assert.equal(abortCalls, 1);

  const answered = await host.handleOrdered({
    type: "ui_response",
    requestId: request.request.id,
    value: "answered-before-ready",
  });
  assert.equal(answered.ok, true);
  await binding;
  assert.equal(startupAnswer, "answered-before-ready");
  assert.equal(host.isReady, true);
  assert.equal(readySettled, true);
  assert.equal(
    frames.some(
      (frame) =>
        frame.type === "session_ready" && !frame.snapshot.initializing,
    ),
    true,
    "ready metadata delta was not published after startup binding",
  );
  assert.equal(
    frames.filter((frame) => frame.type === "snapshot").length,
    1,
    "unchanged startup transcript was delivered twice",
  );

  const readyCommand = await host.handleOrdered({ type: "queue_clear" });
  assert.equal(readyCommand.ok, true);
  assert.equal(clearCalls, 1);
  await host.dispose();
});

test("extension bind failure is observable but still settles readiness", async () => {
  const session = {
    sessionId: "failed-bind",
    sessionFile: undefined,
    isStreaming: false,
    messages: [],
    resourceLoader: {
      getExtensions: () => ({ extensions: [], errors: [] }),
    },
    async bindExtensions() {
      throw new Error("broken startup extension");
    },
  };
  const host = new SessionHost(
    "failed-bind",
    { session, dispose: async () => undefined },
    {},
  );
  await host.startExtensionBinding(session);
  await host.whenReady();
  assert.equal(host.isReady, true);
  await host.dispose();
});
