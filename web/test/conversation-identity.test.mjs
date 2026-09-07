/** Runtime identity and transport lifecycle regressions. @author coolonion */
import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { reconcileConversationBinding } from "../src/conversation-identity.ts";
import { appRoutePath, parseAppRoute, parseStoredSelection } from "../src/state-utils.ts";

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};
globalThis.location = { protocol: "http:", host: "127.0.0.1", pathname: "/chat", search: "", assign() {}, reload() {} };
globalThis.window = { fetch: async () => { throw new Error("unexpected fetch"); } };
class Socket {
  static OPEN = 1;
  static instances = [];
  readyState = 1;
  closes = 0;
  constructor(url) { this.url = new URL(url); Socket.instances.push(this); }
  close() { this.closes++; this.readyState = 3; this.onclose?.({ code: 1000 }); }
  receive(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}
globalThis.WebSocket = Socket;
const bundled = await build({
  entryPoints: [fileURLToPath(new URL("../src/api.ts", import.meta.url))],
  bundle: true, format: "esm", platform: "browser", write: false,
});
const { Conversation } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`);

const idA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const idB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const pathFor = (id) => `/sessions/2026-01-01_${id}.jsonl`;
function snapshot(cwd, id = idA, initializing = true) {
  return {
    cwd, sessionId: id, sessionFile: pathFor(id), initializing,
    isStreaming: false, thinkingLevel: "medium", messages: [], totalMessages: 0, historyFrom: 0,
    queue: { steering: [], followUp: [] }, queueCapabilities: { revision: 0, reorder: true, remove: true },
    tools: [], slashCommands: [],
  };
}
const selectionFor = (snap) => ({ cwd: snap.cwd, sessionPath: snap.sessionFile, sessionId: snap.sessionId });

// Exercise App's production reconciliation with real Conversation objects and
// the same commit effect contract (dispose/connect only when owner changes).
function lifecycle() {
  let binding;
  return {
    select(selection, agent) {
      const next = reconcileConversationBinding(binding, selection, agent,
        (target, owner) => new Conversation(target.cwd, target.sessionPath, owner, target.sessionId));
      if (next.conversation !== binding?.conversation) {
        binding?.conversation?.dispose();
        next.conversation?.connect();
      }
      binding = next;
      return binding.conversation;
    },
    dispose() { binding?.conversation?.dispose(); },
  };
}

test("initializing canonicalization retains one socket, pending readiness, and transcript notices", async () => {
  const app = lifecycle();
  const cwd = "/identity-preview";
  const start = Socket.instances.length;
  try {
    const conversation = app.select({ cwd });
    const ws = Socket.instances.at(-1);
    const preview = snapshot(cwd);
    ws.receive({ type: "snapshot", snapshot: preview });
    ws.receive({ type: "toast", message: "startup notice", level: "info" });
    const readiness = conversation.waitUntilReady(1_000);
    const canonical = selectionFor(preview);
    assert.equal(app.select(canonical), conversation);
    assert.equal(app.select({ ...canonical }), conversation, "view-only render must keep owner");
    assert.equal(Socket.instances.length - start, 1);
    assert.equal(ws.closes, 0);
    assert.equal(conversation.transcriptNotices[0].message, "startup notice");
    ws.receive({ type: "session_ready", snapshot: snapshot(cwd, idA, false) });
    await readiness;
    assert.equal(conversation.snapshot.initializing, false);
    assert.equal(conversation.transcriptNotices[0].message, "startup notice");
    const route = appRoutePath({ view: "chat", selection: canonical });
    assert.equal(route, `/chat/${idA}`);
    assert.equal(parseAppRoute(route).pendingSessionId, idA);
    const refreshed = lifecycle();
    try {
      refreshed.select(parseStoredSelection(JSON.stringify(canonical)));
      assert.equal(Socket.instances.at(-1).url.searchParams.get("session"), pathFor(idA));
    } finally { refreshed.dispose(); }
  } finally { app.dispose(); }
});

test("newSession rebind keeps owner, resets notices, reconnects to B, and switching back restores A", () => {
  const app = lifecycle();
  const cwd = "/identity-rebind";
  try {
    const a = snapshot(cwd, idA, false);
    const b = snapshot(cwd, idB, false);
    const conversation = app.select(selectionFor(a), "nas");
    const ws = Socket.instances.at(-1);
    ws.receive({ type: "snapshot", snapshot: a });
    ws.receive({ type: "toast", message: "A only", level: "warning" });
    ws.receive({ type: "snapshot", snapshot: b });
    assert.equal(app.select(selectionFor(b), "nas"), conversation);
    assert.equal(ws.closes, 0);
    assert.deepEqual(conversation.transcriptNotices, []);
    ws.onclose({ code: 1006 });
    conversation.connect(); // deterministically fire the reconnect, without waiting for jitter
    assert.equal(Socket.instances.at(-1).url.searchParams.get("session"), pathFor(idB));
    assert.equal(Socket.instances.at(-1).url.searchParams.get("agent"), "nas");
    const restored = app.select(selectionFor(a), "nas");
    assert.notEqual(restored, conversation);
    assert.equal(Socket.instances.at(-1).url.searchParams.get("session"), pathFor(idA));
    assert.equal(restored.transcriptNotices[0].message, "A only");
  } finally { app.dispose(); }
});

test("user session/workspace/agent switches and a fresh blank selection replace ownership", () => {
  const app = lifecycle();
  const cwd = "/identity-switch";
  try {
    let current = app.select({ cwd });
    Socket.instances.at(-1).receive({ type: "snapshot", snapshot: snapshot(cwd) });
    assert.equal(app.select(selectionFor(snapshot(cwd))), current);
    const canonicalSocket = Socket.instances.at(-1);
    const fresh = app.select({ cwd });
    assert.notEqual(fresh, current, "a new blank selection in the same workspace is not a canonical alias");
    assert.equal(canonicalSocket.closes, 1);
    current = fresh;
    for (const [selection, agent] of [
      [selectionFor(snapshot(cwd, idB)), undefined],
      [selectionFor(snapshot(cwd, idB)), "nas"],
      [{ cwd: "/other-workspace" }, "nas"],
      [{ cwd }, "nas"],
    ]) {
      const ws = Socket.instances.at(-1);
      const next = app.select(selection, agent);
      assert.notEqual(next, current);
      assert.equal(ws.closes, 1);
      current = next;
    }
    assert.equal(Socket.instances.at(-1).url.searchParams.has("session"), false);
    const ws = Socket.instances.at(-1);
    assert.equal(app.select(undefined, "nas"), undefined);
    assert.equal(ws.closes, 1);
  } finally { app.dispose(); }
});

test("an explicit switch to A wins if /new has rebound to B before route canonicalization", () => {
  const app = lifecycle();
  const cwd = "/identity-rebind-before-route";
  const requestedA = selectionFor(snapshot(cwd));
  try {
    const original = app.select(requestedA);
    const ws = Socket.instances.at(-1);
    ws.receive({ type: "snapshot", snapshot: snapshot(cwd, idB, false) });
    assert.equal(app.select(requestedA), original, "the unchanged route must follow the host rebind");
    const selectedA = app.select({ ...requestedA });
    assert.notEqual(selectedA, original, "explicitly selecting the old path is a real user switch");
    assert.equal(ws.closes, 1);
    assert.equal(Socket.instances.at(-1).url.searchParams.get("session"), pathFor(idA));
  } finally { app.dispose(); }
});

test("a dropped new-session preview reconnects using its assigned path, not another blank host", () => {
  const app = lifecycle();
  const cwd = "/identity-preview-reconnect";
  try {
    const conversation = app.select({ cwd }, "nas");
    const ws = Socket.instances.at(-1);
    assert.equal(ws.url.searchParams.has("session"), false);
    ws.receive({ type: "snapshot", snapshot: snapshot(cwd) });
    ws.onclose({ code: 1006 });
    conversation.connect();
    const url = Socket.instances.at(-1).url;
    assert.equal(url.searchParams.get("session"), pathFor(idA));
    assert.equal(url.searchParams.get("agent"), "nas");
  } finally { app.dispose(); }
});

test("a pathless live rebind reconnects by its latest session ID", () => {
  const app = lifecycle();
  const cwd = "/identity-live-rebind";
  try {
    const conversation = app.select(selectionFor(snapshot(cwd)));
    const ws = Socket.instances.at(-1);
    const live = { ...snapshot(cwd, idB, false), sessionFile: undefined };
    ws.receive({ type: "snapshot", snapshot: live });
    assert.equal(app.select({ cwd, sessionId: idB }), conversation);
    ws.onclose({ code: 1006 });
    conversation.connect();
    const url = Socket.instances.at(-1).url;
    assert.equal(url.searchParams.has("session"), false);
    assert.equal(url.searchParams.get("sessionId"), idB);
  } finally { app.dispose(); }
});
