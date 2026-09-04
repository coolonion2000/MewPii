/**
 * Session lifecycle, initialization and queue safety regressions.
 * @author coolonion
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
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
    if (child.exitCode !== null)
      throw new Error(`server exited early\n${logs.join("")}`);
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
            reject(
              new Error(
                `websocket message timeout; messages=${JSON.stringify(messages.slice(-10))}`,
              ),
            );
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
    prompt: async () => {
      promptCalls += 1;
    },
  };
  const runtime = {
    session,
    dispose: async () => {
      disposeCalls += 1;
    },
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
    expectedMessage: "missing",
    revision: 1,
  });
  assert.equal(moveResult.ok, false);
  assert.match(moveResult.error, /SDK 队列结构不兼容/);
  assert.deepEqual(
    activeToolsForMode(["read", "bash", "extension_tool", "grep"], "read-only"),
    ["read", "grep"],
  );
  assert.deepEqual(
    activeToolsForMode(["read", "bash", "extension_tool", "grep"], "default"),
    ["read", "bash"],
  );
  assert.deepEqual(
    activeToolsForMode(["read", "bash", "extension_tool", "grep"], "full"),
    ["read", "bash", "extension_tool", "grep"],
  );

  await Promise.all([host.dispose(), host.dispose()]);
  assert.equal(disposeCalls, 1, "runtime disposed more than once");
});

test("detached sessions stay alive until parent and background work finish", async () => {
  const delay = (ms) =>
    new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

  async function verifyRetention({ parentRunning, backgroundRunning }) {
    let disposeCalls = 0;
    let emptyCalls = 0;
    let background = backgroundRunning;
    const session = { isStreaming: parentRunning };
    const runtime = {
      session,
      dispose: async () => {
        disposeCalls += 1;
      },
    };
    const host = new SessionHost(
      "detached-retention",
      runtime,
      {},
      () => {
        emptyCalls += 1;
      },
      undefined,
      () => background,
      10,
      10,
    );

    host.detach({});
    await delay(25);
    assert.equal(disposeCalls, 0, "active detached session was disposed");
    session.isStreaming = false;
    background = false;
    await delay(35);
    assert.equal(disposeCalls, 1, "completed detached session was not disposed");
    assert.equal(emptyCalls, 1, "disposed host was not removed exactly once");
  }

  await verifyRetention({ parentRunning: true, backgroundRunning: false });
  await verifyRetention({ parentRunning: false, backgroundRunning: true });
});

test("detached host is removed and its rejection is contained when dispose fails", async () => {
  let emptyCalls = 0;
  const host = new SessionHost(
    "rejecting-dispose",
    {
      session: { isStreaming: false },
      dispose: async () => {
        throw new Error("dispose failed");
      },
    },
    {},
    () => {
      emptyCalls += 1;
    },
    undefined,
    undefined,
    5,
    5,
  );

  host.detach({});
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  assert.equal(emptyCalls, 1, "failed dispose left the host indexed");
  const result = await host.handleOrdered({ type: "queue_clear" });
  assert.equal(result.ok, false);
  assert.match(result.error, /disposed/);
});

test("SessionHost orders newSession, setModel and prompt across socket callers", async () => {
  const host = new SessionHost(
    "ordered",
    { session: {}, dispose: async () => undefined },
    {},
  );
  const events = [];
  host.handleCommand = async (command) => {
    events.push(`start:${command.type}`);
    await new Promise((resolvePromise) =>
      setTimeout(resolvePromise, command.type === "newSession" ? 20 : 1),
    );
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
    "start:newSession",
    "end:newSession",
    "start:setModel",
    "end:setModel",
    "start:prompt",
    "end:prompt",
  ]);

  let releasePrompt;
  const promptGate = new Promise((resolvePromise) => {
    releasePrompt = resolvePromise;
  });
  host.handleCommand = async (command) => {
    events.push(`bypass:${command.type}`);
    if (command.type === "prompt") await promptGate;
    return { ok: true };
  };
  const pendingPrompt = socketA({ type: "prompt", message: "wait" });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  await socketB({ type: "abort" });
  assert.equal(
    events.at(-1),
    "bypass:abort",
    "abort waited behind prompt mutation",
  );
  releasePrompt();
  await pendingPrompt;
  await host.dispose();
});

test("stop-all cancels every SDK path, drains UI and invalidates queued mutations", async () => {
  const events = [];
  let releaseAbort;
  let releaseMutationLane;
  const abortGate = new Promise((resolvePromise) => {
    releaseAbort = resolvePromise;
  });
  const mutationLane = new Promise((resolvePromise) => {
    releaseMutationLane = resolvePromise;
  });
  const queued = {
    steering: ["steer later"],
    followUp: ["follow later"],
  };
  const agent = {
    steeringQueue: {
      messages: [{ role: "user", content: "steer later" }],
    },
    followUpQueue: {
      messages: [{ role: "user", content: "follow later" }],
    },
    abort() {
      events.push("agent_abort");
    },
  };
  const session = {
    isStreaming: true,
    isCompacting: true,
    isRetrying: true,
    isBashRunning: true,
    _steeringMessages: queued.steering,
    _followUpMessages: queued.followUp,
    _emitQueueUpdate() {},
    agent,
    clearQueue() {
      events.push("clear_queue");
      const result = {
        steering: [...queued.steering],
        followUp: [...queued.followUp],
      };
      queued.steering.length = 0;
      queued.followUp.length = 0;
      agent.steeringQueue.messages.length = 0;
      agent.followUpQueue.messages.length = 0;
      return result;
    },
    abortRetry() {
      events.push("abort_retry");
    },
    abortCompaction() {
      events.push("abort_compaction");
    },
    abortBranchSummary() {
      events.push("abort_branch");
    },
    abortBash() {
      events.push("abort_bash");
    },
    async abort() {
      events.push("abort_wait");
      await abortGate;
      session.isStreaming = false;
      session.isCompacting = false;
      session.isRetrying = false;
      session.isBashRunning = false;
    },
    async followUp() {
      events.push("unexpected_follow_up");
    },
  };
  const host = new SessionHost(
    "stop-all",
    { session, dispose: async () => undefined },
    {},
  );
  host.broadcastSnapshot = () => events.push("snapshot");

  const dialog = host.uiRequest({ kind: "input", title: "blocked tool" });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  host.commandMutationChain = mutationLane;
  const queuedCommand = host.handleOrdered({
    type: "followUp",
    message: "must not run",
  });
  const stopping = host.handleOrdered({ type: "abort" });
  assert.equal(host.isRunning, true);

  const racingCommand = await host.handleOrdered({
    type: "prompt",
    message: "arrived during stop",
  });
  assert.equal(racingCommand.ok, false);
  assert.match(racingCommand.error, /stopping/);

  releaseMutationLane();
  releaseAbort();
  const [stopResult, queuedResult, dialogResult] = await Promise.all([
    stopping,
    queuedCommand,
    dialog,
  ]);
  assert.equal(stopResult.ok, true, stopResult.error);
  assert.deepEqual(stopResult.data, { clearedQueue: 2, closedUi: 1 });
  assert.equal(queuedResult.ok, false);
  assert.match(queuedResult.error, /cancelled by stop/);
  assert.equal(dialogResult, undefined);
  assert.equal(events.includes("unexpected_follow_up"), false);
  assert.deepEqual(events.slice(0, 7), [
    "clear_queue",
    "abort_retry",
    "abort_compaction",
    "abort_branch",
    "abort_bash",
    "agent_abort",
    "abort_wait",
  ]);
  assert.equal(
    events.filter((event) => event === "clear_queue").length,
    3,
    "stop did not perform its post-mutation queue sweep",
  );
  assert.equal(host.isRunning, false);
  await host.dispose();
});

test("stop-all closes an active custom UI component immediately", async () => {
  const frames = [];
  let componentDisposed = 0;
  const session = {
    isStreaming: true,
    clearQueue: () => ({ steering: [], followUp: [] }),
    agent: { abort() {} },
    abortRetry() {},
    abortCompaction() {},
    abortBranchSummary() {},
    abortBash() {},
    async abort() {
      session.isStreaming = false;
    },
  };
  const host = new SessionHost(
    "stop-custom-ui",
    { session, dispose: async () => undefined },
    {},
  );
  host.broadcastSnapshot = () => undefined;
  host.sockets.add({
    OPEN: WebSocket.OPEN,
    readyState: WebSocket.OPEN,
    send: (raw) => frames.push(JSON.parse(String(raw))),
    close() {},
  });
  const custom = host.customUiRequest(() => ({
    render: () => ["waiting"],
    invalidate() {},
    dispose() {
      componentDisposed += 1;
    },
  }));
  await new Promise((resolvePromise) => setImmediate(resolvePromise));

  const stopped = await host.handleOrdered({ type: "abort" });
  assert.equal(stopped.ok, true, stopped.error);
  assert.equal(stopped.data.closedUi, 1);
  assert.equal(await custom, undefined);
  assert.equal(componentDisposed, 1);
  assert.equal(
    frames.some((frame) => frame.type === "custom_ui_close"),
    true,
  );
  await host.dispose();
});

test("a hung SDK abort times out and leaves stop retryable", async () => {
  const never = new Promise(() => undefined);
  let abortCalls = 0;
  const session = {
    isStreaming: true,
    clearQueue: () => ({ steering: [], followUp: [] }),
    agent: { abort() {} },
    abortRetry() {},
    abortCompaction() {},
    abortBranchSummary() {},
    abortBash() {},
    abort() {
      abortCalls += 1;
      return never;
    },
  };
  const host = new SessionHost(
    "hung-stop",
    { session, dispose: async () => undefined },
    {},
    undefined,
    undefined,
    undefined,
    1_000,
    1_000,
    10,
  );
  host.broadcastSnapshot = () => undefined;

  const first = await host.handleOrdered({ type: "abort" });
  assert.equal(first.ok, false);
  assert.match(first.error, /settlement_timeout/);
  const second = await host.handleOrdered({ type: "abort" });
  assert.equal(second.ok, false);
  assert.equal(abortCalls, 2, "timed-out stop remained permanently coalesced");
  await host.dispose();
});

test("stop sweeps a session installed by an in-flight replacement", async () => {
  const events = [];
  const makeSession = (name) => ({
    isStreaming: false,
    isCompacting: false,
    isRetrying: false,
    isBashRunning: false,
    _steeringMessages: [],
    _followUpMessages: [],
    agent: {
      steeringQueue: { messages: [] },
      followUpQueue: { messages: [] },
      abort() {
        events.push(`${name}:agent_abort`);
      },
    },
    clearQueue() {
      events.push(`${name}:clear_queue`);
      return { steering: [], followUp: [] };
    },
    abortRetry() {
      events.push(`${name}:abort_retry`);
    },
    abortCompaction() {
      events.push(`${name}:abort_compaction`);
    },
    abortBranchSummary() {
      events.push(`${name}:abort_branch`);
    },
    abortBash() {
      events.push(`${name}:abort_bash`);
    },
    async abort() {
      events.push(`${name}:abort`);
    },
  });
  let releaseReplacement;
  let replacementStarted;
  const replacementGate = new Promise((resolvePromise) => {
    releaseReplacement = resolvePromise;
  });
  const started = new Promise((resolvePromise) => {
    replacementStarted = resolvePromise;
  });
  const initialSession = makeSession("initial");
  const replacementSession = makeSession("replacement");
  const runtime = {
    session: initialSession,
    async newSession() {
      replacementStarted();
      await replacementGate;
      runtime.session = replacementSession;
      return { cancelled: false };
    },
    dispose: async () => undefined,
  };
  const host = new SessionHost("replacement-stop", runtime, {});
  host.broadcastSnapshot = () => events.push("snapshot");

  const replacing = host.handleOrdered({ type: "newSession" });
  await started;
  const stopping = host.handleOrdered({ type: "abort" });
  releaseReplacement();
  const [replaceResult, stopResult] = await Promise.all([replacing, stopping]);

  assert.equal(replaceResult.ok, false);
  assert.match(replaceResult.error, /completed after stop/);
  assert.equal(stopResult.ok, true, stopResult.error);
  assert.ok(events.includes("initial:abort"));
  assert.ok(
    events.includes("replacement:abort"),
    "replacement session escaped the stop boundary",
  );
  assert.equal(host.isRunning, false);
  await host.dispose();
});

test("a replacement completing after the stop deadline is still quiesced", async () => {
  let releaseReplacement;
  let replacementStarted;
  const replacementGate = new Promise((resolvePromise) => {
    releaseReplacement = resolvePromise;
  });
  const started = new Promise((resolvePromise) => {
    replacementStarted = resolvePromise;
  });
  const initialSession = {
    isStreaming: false,
    isCompacting: false,
    isRetrying: false,
    isBashRunning: false,
    clearQueue: () => ({ steering: [], followUp: [] }),
    agent: { abort() {} },
    abort: async () => undefined,
  };
  let replacementAborts = 0;
  const replacementSession = {
    ...initialSession,
    isStreaming: true,
    agent: {
      abort() {
        replacementSession.isStreaming = false;
      },
    },
    async abort() {
      replacementAborts += 1;
      replacementSession.isStreaming = false;
    },
  };
  const runtime = {
    session: initialSession,
    async newSession() {
      replacementStarted();
      await replacementGate;
      runtime.session = replacementSession;
      return { cancelled: false };
    },
    dispose: async () => undefined,
  };
  const host = new SessionHost(
    "late-replacement-stop",
    runtime,
    {},
    undefined,
    undefined,
    undefined,
    1_000,
    1_000,
    10,
  );
  host.broadcastSnapshot = () => undefined;

  const replacing = host.handleOrdered({ type: "newSession" });
  await started;
  const stopResult = await host.handleOrdered({ type: "abort" });
  assert.equal(stopResult.ok, false);
  assert.match(stopResult.error, /settlement_timeout/);

  releaseReplacement();
  const replaceResult = await replacing;
  assert.equal(replaceResult.ok, false);
  assert.match(replaceResult.error, /completed after stop/);
  assert.equal(runtime.session, replacementSession);
  assert.ok(replacementAborts > 0, "late replacement was never aborted");
  assert.equal(replacementSession.isStreaming, false);
  assert.equal(host.isRunning, false);
  await host.dispose();
});

test("REST import shares the stop-aware session mutation lane", async () => {
  let releaseLane;
  const heldLane = new Promise((resolvePromise) => {
    releaseLane = resolvePromise;
  });
  let imports = 0;
  const session = {
    isStreaming: false,
    isCompacting: false,
    isRetrying: false,
    isBashRunning: false,
    _steeringMessages: [],
    _followUpMessages: [],
    agent: {
      steeringQueue: { messages: [] },
      followUpQueue: { messages: [] },
      abort() {},
    },
    clearQueue: () => ({ steering: [], followUp: [] }),
    abort: async () => undefined,
  };
  const runtime = {
    session,
    async importFromJsonl() {
      imports += 1;
      return { cancelled: false };
    },
    dispose: async () => undefined,
  };
  const host = new SessionHost("import-stop", runtime, {});
  host.commandMutationChain = heldLane;
  host.broadcastSnapshot = () => undefined;

  const importing = host.runtime_import("/tmp/test-import.jsonl");
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  const stopping = host.handleOrdered({ type: "abort" });
  releaseLane();
  const [importResult, stopResult] = await Promise.all([importing, stopping]);

  assert.equal(importResult.ok, false);
  assert.match(importResult.error, /cancelled by stop/);
  assert.equal(imports, 0, "import bypassed the mutation lane");
  assert.equal(stopResult.ok, true, stopResult.error);
  await host.dispose();
});

test("isRunning covers binding, SDK background work and queued mutations", async () => {
  const session = {
    isStreaming: false,
    isCompacting: false,
    isRetrying: false,
    isBashRunning: false,
  };
  const host = new SessionHost(
    "busy-states",
    { session, dispose: async () => undefined },
    {},
  );
  assert.equal(host.isRunning, false);
  session.isCompacting = true;
  assert.equal(host.isRunning, true);
  session.isCompacting = false;
  session.isRetrying = true;
  assert.equal(host.isRunning, true);
  session.isRetrying = false;
  session.isBashRunning = true;
  assert.equal(host.isRunning, true);
  session.isBashRunning = false;
  host.readinessState = "binding";
  assert.equal(host.isRunning, true);
  host.readinessState = "ready";

  let releaseCommand;
  const commandGate = new Promise((resolvePromise) => {
    releaseCommand = resolvePromise;
  });
  host.handleCommand = async () => {
    await commandGate;
    return { ok: true };
  };
  const pending = host.handleOrdered({ type: "setSessionName", name: "busy" });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(host.isRunning, true);
  releaseCommand();
  await pending;
  assert.equal(host.isRunning, false);
  await host.dispose();
});

test("destructive session changes fail closed with multiple viewers", async () => {
  const calls = [];
  const session = {
    isStreaming: false,
    isCompacting: false,
    async navigateTree() {
      calls.push("branch");
      return { cancelled: false };
    },
  };
  const runtime = {
    session,
    async newSession() {
      calls.push("new");
      return { cancelled: false };
    },
    async fork() {
      calls.push("fork");
      return { cancelled: false };
    },
    dispose: async () => undefined,
  };
  const host = new SessionHost("shared-viewers", runtime, {});
  host.broadcastSnapshot = () => undefined;
  const viewerA = { close() {} };
  const viewerB = { close() {} };
  host.sockets.add(viewerA);
  host.sockets.add(viewerB);

  for (const command of [
    { type: "newSession" },
    { type: "fork", entryId: "entry" },
    { type: "branch", entryId: "entry" },
    { type: "slash", raw: "/new" },
  ]) {
    const result = await host.handleOrdered(command);
    assert.equal(result.ok, false);
    assert.match(result.error, /多个窗口/);
  }
  assert.deepEqual(calls, []);

  host.sockets.delete(viewerB);
  const singleViewer = await host.handleOrdered({ type: "newSession" });
  assert.equal(singleViewer.ok, true, singleViewer.error);
  assert.deepEqual(calls, ["new"]);
  host.sockets.clear();
  await host.dispose();
});

test("an open session refreshes models.json after a model lookup miss", async () => {
  let refreshed = 0;
  let selected;
  const model = { provider: "late-provider", id: "late-model", name: "Late" };
  const registry = {
    find(provider, modelId) {
      return refreshed > 0 && provider === model.provider && modelId === model.id
        ? model
        : undefined;
    },
    async refresh(options) {
      assert.equal(options.allowNetwork, false);
      refreshed += 1;
    },
  };
  const session = {
    isStreaming: false,
    isCompacting: false,
    async setModel(next) {
      selected = next;
    },
  };
  const host = new SessionHost(
    "late-model",
    { session, dispose: async () => undefined },
    registry,
  );
  host.broadcastSnapshot = () => undefined;

  const result = await host.handleOrdered({
    type: "setModel",
    provider: model.provider,
    modelId: model.id,
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(refreshed, 1);
  assert.equal(selected, model);
  await host.dispose();
});

test("attach rejects a runtime after disposal has started", async () => {
  let finishDispose;
  const disposeGate = new Promise((resolvePromise) => {
    finishDispose = resolvePromise;
  });
  const host = new SessionHost(
    "attach-dispose-race",
    {
      session: { isStreaming: false },
      dispose: () => disposeGate,
    },
    {},
  );
  const disposing = host.dispose();
  assert.throws(
    () => host.attach({}),
    /disposing or disposed/,
  );
  assert.equal(host.viewerCount, 0);
  finishDispose();
  await disposing;
});

test("prompt admission releases the mutation lane for live queue operations", async () => {
  const events = [];
  let releasePrompt;
  let finishPrompt;
  let promptCompleted = false;
  const promptGate = new Promise((resolvePromise) => {
    releasePrompt = resolvePromise;
  });
  const promptFinished = new Promise((resolvePromise) => {
    finishPrompt = resolvePromise;
  });
  const session = {
    isStreaming: false,
    prompt: async (_message, options) => {
      if (options?.streamingBehavior) {
        events.push(`queued:${options.streamingBehavior}`);
        options.preflightResult?.(true);
        return;
      }
      events.push("prompt:start");
      session.isStreaming = true;
      options?.preflightResult?.(true);
      await promptGate;
      promptCompleted = true;
      session.isStreaming = false;
      events.push("prompt:end");
      finishPrompt();
    },
    followUp: async () => {
      events.push("followUp");
    },
    clearQueue: () => {
      events.push("queue_clear");
    },
  };
  const host = new SessionHost(
    "queue-clear",
    { session, dispose: async () => undefined },
    {},
  );
  host.broadcastSnapshot = () => undefined;

  const accepted = await Promise.race([
    host.handleOrdered({ type: "prompt", message: "held" }),
    new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error("initial prompt was not acknowledged after preflight"),
          ),
        100,
      ),
    ),
  ]);
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.data, { accepted: true, delivery: "run" });

  const queuedPrompt = host.handleOrdered({
    type: "prompt",
    message: "queued from composer",
    streamingBehavior: "followUp",
  });
  const steeredPrompt = host.handleOrdered({
    type: "prompt",
    message: "steered from composer",
    streamingBehavior: "steer",
  });
  const followUp = host.handleOrdered({ type: "followUp", message: "later" });
  const clear = host.handleOrdered({ type: "queue_clear" });
  const [queuedResult, steeredResult] = await Promise.race([
    Promise.all([queuedPrompt, steeredPrompt, followUp, clear]),
    new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(new Error("live queue operations waited for the active run")),
        100,
      ),
    ),
  ]);
  assert.deepEqual(queuedResult.data, { accepted: true, delivery: "followUp" });
  assert.deepEqual(steeredResult.data, { accepted: true, delivery: "steer" });
  assert.equal(promptCompleted, false);
  assert.deepEqual(events, [
    "prompt:start",
    "queued:followUp",
    "queued:steer",
    "followUp",
    "queue_clear",
  ]);

  releasePrompt();
  await promptFinished;
  await host.dispose();
});

test("streaming slash enqueue publishes a settled queue snapshot", async () => {
  const events = [];
  const session = {
    isStreaming: true,
    prompt: async (_text, options) => {
      assert.equal(options.streamingBehavior, "steer");
      events.push("queue-stable");
    },
  };
  const host = new SessionHost(
    "streaming-slash",
    { session, dispose: async () => undefined },
    {},
  );
  host.slashCommands = () => [
    { name: "template", source: "prompt", description: "test" },
  ];
  host.broadcastSnapshot = () => events.push("snapshot");

  const result = await host.runSlash("/template argument");
  assert.equal(result.ok, true);
  assert.deepEqual(events, ["queue-stable", "snapshot"]);
  await host.dispose();
});

test("prompt admission preserves preflight and background error contracts", async () => {
  const frames = [];
  const socket = {
    OPEN: WebSocket.OPEN,
    readyState: WebSocket.OPEN,
    send: (raw) => frames.push(JSON.parse(String(raw))),
    close: () => undefined,
  };
  const session = {
    isStreaming: false,
    prompt: async (message, options) => {
      if (message === "no auth") {
        options?.preflightResult?.(false);
        throw new Error("no auth");
      }
      session.isStreaming = true;
      options?.preflightResult?.(true);
      await new Promise((resolvePromise) => setImmediate(resolvePromise));
      session.isStreaming = false;
      throw new Error("provider disconnected");
    },
  };
  const runtime = {
    session,
    newSession: async () => {
      throw new Error("newSession must not run while streaming");
    },
    dispose: async () => undefined,
  };
  const host = new SessionHost("prompt-errors", runtime, {});
  host.sockets.add(socket);

  const rejected = await host.handleOrdered({
    type: "prompt",
    message: "no auth",
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, "no auth");

  const accepted = await host.handleOrdered({
    type: "prompt",
    message: "background failure",
  });
  assert.equal(accepted.ok, true);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(
    frames.findLast((frame) => frame.type === "toast")?.message,
    "provider disconnected",
  );

  session.isStreaming = true;
  const busyMutation = await host.handleOrdered({ type: "newSession" });
  assert.equal(busyMutation.ok, false);
  assert.match(busyMutation.error, /仍在运行/);
  const busySlash = await host.handleOrdered({ type: "slash", raw: "/new" });
  assert.equal(busySlash.ok, false);
  assert.match(busySlash.error, /仍在运行/);

  session.isStreaming = false;
  await host.dispose();
  const disposed = await host.handleOrdered({ type: "queue_clear" });
  assert.equal(disposed.ok, false);
  assert.match(disposed.error, /disposed/);
});

test("standard UI requests broadcast matching close reasons", async () => {
  const frames = [];
  const socket = {
    OPEN: WebSocket.OPEN,
    readyState: WebSocket.OPEN,
    send: (raw) => frames.push(JSON.parse(String(raw))),
    close: () => undefined,
  };
  const host = new SessionHost(
    "ui",
    { session: { isStreaming: false }, dispose: async () => undefined },
    {},
  );
  host.sockets.add(socket);

  const answered = host.uiRequest({ kind: "input", title: "answer" }, 1000);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  const answerRequest = frames.findLast((frame) => frame.type === "ui_request")
    .request.id;
  assert.equal(
    (
      await host.handleCommand({
        type: "ui_response",
        requestId: answerRequest,
        value: "ok",
      })
    ).ok,
    true,
  );
  assert.equal(await answered, "ok");
  assert.equal(
    frames.findLast((frame) => frame.type === "ui_close").reason,
    "answered",
  );

  const timedOut = host.uiRequest({ kind: "confirm", title: "timeout" }, 5);
  await timedOut;
  assert.equal(
    frames.findLast((frame) => frame.type === "ui_close").reason,
    "timeout",
  );

  const rebound = host.uiRequest({ kind: "select", title: "rebind" }, 1000);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  host.teardownSessionUi("rebind");
  await rebound;
  assert.equal(
    frames.findLast((frame) => frame.type === "ui_close").reason,
    "rebind",
  );

  const disposed = host.uiRequest({ kind: "input", title: "dispose" }, 1000);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  await host.dispose();
  await disposed;
  assert.equal(
    frames.findLast((frame) => frame.type === "ui_close").reason,
    "dispose",
  );
});

test("ui_response bypasses a held prompt through handleOrdered", async () => {
  let releasePrompt;
  let promptCompleted = false;
  const promptGate = new Promise((resolvePromise) => {
    releasePrompt = resolvePromise;
  });
  const frames = [];
  const socket = {
    OPEN: WebSocket.OPEN,
    readyState: WebSocket.OPEN,
    send: (raw) => frames.push(JSON.parse(String(raw))),
    close: () => undefined,
  };
  let finishPrompt;
  const promptFinished = new Promise((resolvePromise) => {
    finishPrompt = resolvePromise;
  });
  const session = {
    isStreaming: false,
    prompt: async (_message, options) => {
      session.isStreaming = true;
      options?.preflightResult?.(true);
      await promptGate;
      promptCompleted = true;
      session.isStreaming = false;
      finishPrompt();
    },
  };
  const host = new SessionHost(
    "ordered-ui",
    { session, dispose: async () => undefined },
    {},
  );
  host.sockets.add(socket);
  const answered = host.uiRequest(
    { kind: "input", title: "answer while held" },
    1000,
  );
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  const requestId = frames.findLast((frame) => frame.type === "ui_request")
    .request.id;
  const heldPrompt = host.handleOrdered({ type: "prompt", message: "held" });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  const response = await Promise.race([
    host.handleOrdered({ type: "ui_response", requestId, value: "ok" }),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("ui_response waited for held prompt")),
        100,
      ),
    ),
  ]);
  assert.equal(response.ok, true);
  assert.equal(await answered, "ok");
  assert.equal(promptCompleted, false);
  releasePrompt();
  await heldPrompt;
  await promptFinished;
  await host.dispose();
});

test("rebind clears delayed snapshot timer", async () => {
  let subscriber;
  let toolEndCalls = 0;
  const session = {
    subscribe: (callback) => {
      subscriber = callback;
      return () => undefined;
    },
  };
  const frames = [];
  const host = new SessionHost(
    "snapshot-timer",
    { session, dispose: async () => undefined },
    {},
  );
  host.onToolExecution = (_toolName, phase) => {
    if (phase === "end") toolEndCalls += 1;
  };
  host.sockets.add({
    OPEN: WebSocket.OPEN,
    readyState: WebSocket.OPEN,
    send: (raw) => frames.push(JSON.parse(String(raw))),
    close: () => undefined,
  });
  host.bindSession();
  subscriber({
    type: "tool_execution_start",
    toolCallId: "old-session-tool",
    toolName: "bash",
    args: {},
  });
  assert.equal(host.activeToolCalls.size, 1);
  subscriber({ type: "agent_end" });
  host.bindSession();
  assert.equal(host.activeToolCalls.size, 0);
  assert.equal(toolEndCalls, 1);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  assert.equal(
    frames.some((frame) => frame.type === "snapshot"),
    false,
  );
  await host.dispose();
});

test("session single-flight, init buffering, rebind index and watcher", {
  timeout: 40_000,
}, async () => {
  const temp = await mkdtemp(join(tmpdir(), "mewpii-session-lifecycle-"));
  const home = join(temp, "home");
  const workspace = join(temp, "workspace");
  const wrongCwd = join(temp, "wrong-cwd");
  const externalDir = join(temp, "external");
  const externalPreview = join(externalDir, "preview.md");
  const unauthorizedPreview = join(externalDir, "unauthorized.md");
  const sessionDir = join(home, ".pi", "agent", "sessions", "test");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(wrongCwd, { recursive: true }),
    mkdir(externalDir, { recursive: true }),
    mkdir(sessionDir, { recursive: true }),
  ]);
  const manager = SessionManager.create(workspace, sessionDir);
  const sessionPath = manager.getSessionFile();
  assert.ok(sessionPath);
  const now = new Date().toISOString();
  await Promise.all([
    writeFile(externalPreview, "# authorized external preview\n"),
    writeFile(unauthorizedPreview, "must stay private\n"),
  ]);
  await writeFile(
    sessionPath,
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: manager.getSessionId(),
        timestamp: now,
        cwd: workspace,
      }),
      JSON.stringify({
        type: "message",
        id: "seed-entry",
        parentId: null,
        timestamp: now,
        message: { role: "user", content: "seed", timestamp: Date.now() },
      }),
      JSON.stringify({
        type: "message",
        id: "preview-tool-call",
        parentId: "seed-entry",
        timestamp: now,
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "preview-read",
              name: "read",
              arguments: { path: externalPreview },
            },
          ],
          timestamp: Date.now(),
        },
      }),
      JSON.stringify({
        type: "message",
        id: "preview-tool-result",
        parentId: "preview-tool-call",
        timestamp: now,
        message: {
          role: "toolResult",
          toolCallId: "preview-read",
          toolName: "read",
          content: [{ type: "text", text: "# authorized external preview" }],
          isError: false,
          timestamp: Date.now(),
        },
      }),
    ].join("\n") + "\n",
  );

  const port = 37_000 + Math.floor(Math.random() * 2_000);
  const logs = [];
  const child = spawn(
    process.execPath,
    ["server/dist/index.js", "--host", "127.0.0.1", "--port", String(port)],
    {
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        PII_PASSWORD: "",
        PII_WORKSPACE_ROOTS: temp,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));

  const sockets = [];
  try {
    await waitForServer(port, child, logs);

    const sessionsBeforeRename = await (
      await fetch(`http://127.0.0.1:${port}/api/sessions`)
    ).json();
    const beforeRename = sessionsBeforeRename.projects
      .flatMap((project) => project.sessions)
      .find((session) => session.path === sessionPath);
    assert.ok(beforeRename, "seed session missing before rename");
    const renameResponse = await fetch(
      `http://127.0.0.1:${port}/api/sessions/rename`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ path: sessionPath, name: "stable-position" }),
      },
    );
    assert.equal(renameResponse.ok, true, await renameResponse.text());
    const sessionsAfterRename = await (
      await fetch(`http://127.0.0.1:${port}/api/sessions`)
    ).json();
    const afterRename = sessionsAfterRename.projects
      .flatMap((project) => project.sessions)
      .find((session) => session.path === sessionPath);
    assert.equal(afterRename.name, "stable-position");
    assert.equal(
      afterRename.modified,
      beforeRename.modified,
      "rename changed activity ordering timestamp",
    );

    const stateMutations = await Promise.all([
      fetch(`http://127.0.0.1:${port}/api/state/favorites`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ cwd: workspace, favorite: true }),
      }),
      fetch(`http://127.0.0.1:${port}/api/state/project-order`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ cwd: workspace, visibleOrder: [workspace] }),
      }),
    ]);
    for (const response of stateMutations)
      assert.equal(
        response.ok,
        true,
        `state mutation failed status=${response.status} body=${await response.text()}`,
      );
    const sidebarState = await (
      await fetch(`http://127.0.0.1:${port}/api/state`)
    ).json();
    assert.deepEqual(sidebarState.favorites, [workspace]);
    assert.deepEqual(sidebarState.projectOrder, [workspace]);
    assert.equal(sidebarState.version, 2);

    const thirdMutation = await fetch(
      `http://127.0.0.1:${port}/api/state/favorites`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ cwd: workspace, favorite: true }),
      },
    );
    assert.equal(thirdMutation.ok, true);
    await writeFile(
      join(home, ".pi", "agent", "pii-web-state.json"),
      "{corrupt",
    );
    const recoveredState = await (
      await fetch(`http://127.0.0.1:${port}/api/state`)
    ).json();
    assert.deepEqual(recoveredState.favorites, [workspace]);
    assert.deepEqual(recoveredState.projectOrder, [workspace]);
    assert.equal(
      recoveredState.version,
      2,
      "backup was not used after primary corruption",
    );

    const recoveryMutation = await fetch(
      `http://127.0.0.1:${port}/api/state/favorites`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ cwd: workspace, favorite: false }),
      },
    );
    assert.equal(recoveryMutation.ok, true);
    const statePath = join(home, ".pi", "agent", "pii-web-state.json");
    const backupPath = `${statePath}.bak`;
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).version, 3);
    assert.equal(JSON.parse(await readFile(backupPath, "utf8")).version, 3);
    await writeFile(statePath, "{corrupt-again");
    const twiceRecovered = await (
      await fetch(`http://127.0.0.1:${port}/api/state`)
    ).json();
    assert.deepEqual(twiceRecovered.favorites, []);
    assert.deepEqual(twiceRecovered.projectOrder, [workspace]);
    assert.equal(
      twiceRecovered.version,
      3,
      "recovered write did not refresh both primary and backup",
    );

    const logoutResponse = await fetch(
      `http://127.0.0.1:${port}/api/auth/provider/logout`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ provider: "missing-provider" }),
      },
    );
    assert.equal(logoutResponse.status, 404);
    assert.match((await logoutResponse.json()).error, /provider not found/);

    const modelsPath = join(home, ".pi", "agent", "models.json");
    const modelsBeforeInvalidProvider = await readFile(modelsPath, "utf8").catch(
      (cause) => {
        if (cause?.code === "ENOENT") return undefined;
        throw cause;
      },
    );
    for (const [api, model, expectedError] of [
      ["openai-completions", { id: "" }, /models\[0\]\.id/],
      [
        "openai-completions",
        { id: "valid-model", contextWindow: "invalid" },
        /contextWindow/,
      ],
      ["unsupported-api", { id: "valid-model" }, /unsupported api/],
    ]) {
      const invalidProvider = await fetch(
        `http://127.0.0.1:${port}/api/providers`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: `http://127.0.0.1:${port}`,
          },
          body: JSON.stringify({
            id: "invalid-provider",
            baseUrl: "http://127.0.0.1:1/v1",
            api,
            models: [model],
          }),
        },
      );
      assert.equal(invalidProvider.status, 400);
      assert.match((await invalidProvider.json()).error, expectedError);
      const modelsAfterInvalidProvider = await readFile(
        modelsPath,
        "utf8",
      ).catch((cause) => {
        if (cause?.code === "ENOENT") return undefined;
        throw cause;
      });
      assert.equal(
        modelsAfterInvalidProvider,
        modelsBeforeInvalidProvider,
        "invalid provider replaced the healthy model configuration",
      );
    }
    const modelsAfterRejectedProvider = await fetch(
      `http://127.0.0.1:${port}/api/models`,
    );
    assert.equal(
      modelsAfterRejectedProvider.status,
      200,
      await modelsAfterRejectedProvider.text(),
    );

    const skillResponse = await fetch(`http://127.0.0.1:${port}/api/skills`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: `http://127.0.0.1:${port}`,
      },
      body: JSON.stringify({
        name: "review-skill",
        description: "persisted",
        content: "body",
      }),
    });
    assert.equal(skillResponse.ok, true);
    const skill = await skillResponse.json();
    assert.equal(
      skill.path,
      join(home, ".pi", "agent", "skills", "review-skill", "SKILL.md"),
    );
    assert.match(await readFile(skill.path, "utf8"), /description: persisted/);

    const roguePath = join(temp, "rogue.jsonl");
    await writeFile(roguePath, await readFile(sessionPath, "utf8"));
    const rogueWs = new WebSocket(
      `ws://127.0.0.1:${port}/ws?cwd=${encodeURIComponent(workspace)}&session=${encodeURIComponent(roguePath)}`,
    );
    sockets.push(rogueWs);
    const [rogueCode] = await new Promise((resolvePromise) =>
      rogueWs.once("close", (...args) => resolvePromise(args)),
    );
    assert.equal(rogueCode, 1011, "unmanaged session path was accepted");

    const outsideWs = new WebSocket(
      `ws://127.0.0.1:${port}/ws?cwd=${encodeURIComponent("/etc")}`,
    );
    sockets.push(outsideWs);
    const [outsideCode] = await new Promise((resolvePromise) =>
      outsideWs.once("close", (...args) => resolvePromise(args)),
    );
    assert.equal(outsideCode, 1011, "new workspace escaped configured roots");

    const newWs = new WebSocket(
      `ws://127.0.0.1:${port}/ws?cwd=${encodeURIComponent(workspace)}`,
    );
    sockets.push(newWs);
    const newInbox = socketInbox(newWs);
    const newSnapshot = await newInbox.waitFor(
      (message) =>
        (message.type === "snapshot" || message.type === "session_ready") &&
        message.snapshot.initializing !== true,
    );
    assert.equal(
      newSnapshot.snapshot.cwd,
      await realpath(workspace),
    );

    const liveResolve = await fetch(
      `http://127.0.0.1:${port}/api/sessions/resolve?id=${encodeURIComponent(newSnapshot.snapshot.sessionId)}`,
    );
    assert.equal(liveResolve.status, 200);
    const liveResolvedSession = await liveResolve.json();
    assert.equal(liveResolvedSession.cwd, await realpath(workspace));
    assert.equal(liveResolvedSession.id, newSnapshot.snapshot.sessionId);
    assert.equal(liveResolvedSession.live, true);

    const resumedNewWs = new WebSocket(
      `ws://127.0.0.1:${port}/ws?cwd=${encodeURIComponent(workspace)}&sessionId=${encodeURIComponent(newSnapshot.snapshot.sessionId)}`,
    );
    sockets.push(resumedNewWs);
    const resumedNewInbox = socketInbox(resumedNewWs);
    assert.equal(
      (
        await resumedNewInbox.waitFor(
          (message) => message.type === "snapshot",
        )
      ).snapshot.sessionId,
      newSnapshot.snapshot.sessionId,
      "refreshing a live new session created a different runtime",
    );

    const mismatchedResumeWs = new WebSocket(
      `ws://127.0.0.1:${port}/ws?cwd=${encodeURIComponent(wrongCwd)}&sessionId=${encodeURIComponent(newSnapshot.snapshot.sessionId)}`,
    );
    sockets.push(mismatchedResumeWs);
    const [mismatchedResumeCode] = await new Promise((resolvePromise) =>
      mismatchedResumeWs.once("close", (...args) => resolvePromise(args)),
    );
    assert.equal(
      mismatchedResumeCode,
      1011,
      "live session resumed from a mismatched workspace",
    );
    resumedNewWs.close();
    newWs.close();

    const url = `ws://127.0.0.1:${port}/ws?cwd=${encodeURIComponent("/etc")}&session=${encodeURIComponent(sessionPath)}`;
    const ws1 = new WebSocket(url);
    const ws2 = new WebSocket(url);
    sockets.push(ws1, ws2);
    const inbox1 = socketInbox(ws1);
    const inbox2 = socketInbox(ws2);
    ws1.on("open", () => {
      ws1.send(
        JSON.stringify({ id: "init-1", type: "setSessionName", name: "first" }),
      );
      ws1.send(
        JSON.stringify({
          id: "init-2",
          type: "setSessionName",
          name: "second",
        }),
      );
    });

    const [firstSnapshot1, firstSnapshot2] = await Promise.all([
      inbox1.waitFor((message) => message.type === "snapshot"),
      inbox2.waitFor((message) => message.type === "snapshot"),
    ]);
    assert.equal(
      [firstSnapshot1, firstSnapshot2].some(
        (message) => message.snapshot.initializing === true,
      ),
      true,
      "single-flight creation did not publish an initializing preview",
    );
    const [snap1, snap2] = await Promise.all([
      inbox1.waitFor(
        (message) =>
          (message.type === "snapshot" || message.type === "session_ready") &&
          message.snapshot.initializing !== true,
      ),
      inbox2.waitFor(
        (message) =>
          (message.type === "snapshot" || message.type === "session_ready") &&
          message.snapshot.initializing !== true,
      ),
    ]);
    assert.equal(
      snap1.snapshot.sessionId,
      snap2.snapshot.sessionId,
      "two runtimes opened the same session",
    );
    assert.equal(
      snap1.snapshot.cwd,
      workspace,
      "client cwd overrode session header cwd",
    );
    assert.equal(snap1.snapshot.queueCapabilities.reorder, true);
    assert.equal(snap1.snapshot.queueCapabilities.remove, true);
    assert.equal(typeof snap1.snapshot.queueCapabilities.revision, "number");
    assert.equal(snap1.snapshot.queueCapabilities.reason, undefined);

    const previewParams = new URLSearchParams({
      cwd: workspace,
      path: externalPreview,
      sessionId: snap1.snapshot.sessionId,
    });
    const externalResponse = await fetch(
      `http://127.0.0.1:${port}/api/file?${previewParams}`,
    );
    const externalBody = await externalResponse.json();
    assert.equal(externalResponse.status, 200, JSON.stringify(externalBody));
    assert.equal(externalBody.content, "# authorized external preview\n");
    previewParams.set("path", unauthorizedPreview);
    const deniedResponse = await fetch(
      `http://127.0.0.1:${port}/api/file?${previewParams}`,
    );
    assert.equal(deniedResponse.status, 403);
    assert.match((await deniedResponse.json()).error, /not authorized/);

    const [init1, init2] = await Promise.all([
      inbox1.waitFor(
        (message) =>
          message.type === "command_result" && message.id === "init-1",
      ),
      inbox1.waitFor(
        (message) =>
          message.type === "command_result" && message.id === "init-2",
      ),
    ]);
    assert.equal(init1.ok, true, init1.error);
    assert.equal(init2.ok, true, init2.error);
    const historySnapshot = await inbox1.waitFor(
      (message) =>
        message.type === "snapshot" && message.snapshot.name === "second",
    );
    ws1.send(
      JSON.stringify({
        id: "history-command",
        type: "history",
        before: 1,
        requestId: "history-request-1",
      }),
    );
    const history = await inbox1.waitFor(
      (message) =>
        message.type === "history" && message.requestId === "history-request-1",
    );
    assert.equal(history.sessionId, historySnapshot.snapshot.sessionId);
    assert.equal(history.branchHeadId, historySnapshot.snapshot.branchHeadId);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    assert.equal(
      inbox2.messages.some(
        (message) =>
          message.type === "history" &&
          message.requestId === "history-request-1",
      ),
      false,
    );

    ws1.send(
      JSON.stringify({
        id: "queue-steer",
        type: "steer",
        message: "queue integration item",
      }),
    );
    const queueSteer = await inbox1.waitFor(
      (message) =>
        message.type === "command_result" && message.id === "queue-steer",
    );
    assert.equal(queueSteer.ok, true, queueSteer.error);
    const stableQueue = await inbox1.waitFor(
      (message) =>
        message.type === "snapshot" &&
        message.snapshot.queue.steering.includes("queue integration item") &&
        message.snapshot.queueCapabilities.reorder,
    );

    ws1.send(
      JSON.stringify({
        id: "queue-move",
        type: "queue_move",
        from: "steering",
        to: "followUp",
        index: 0,
        expectedMessage: "queue integration item",
        revision: stableQueue.snapshot.queueCapabilities.revision,
      }),
    );
    const queueMove = await inbox1.waitFor(
      (message) =>
        message.type === "command_result" && message.id === "queue-move",
    );
    assert.equal(queueMove.ok, true, queueMove.error);
    const movedQueue = await inbox1.waitFor(
      (message) =>
        message.type === "event" &&
        message.event.type === "queue_update" &&
        message.event.followUp.includes("queue integration item"),
    );

    ws1.send(
      JSON.stringify({
        id: "queue-remove",
        type: "queue_remove",
        queue: "followUp",
        index: 0,
        expectedMessage: "queue integration item",
        revision: movedQueue.event.queueCapabilities.revision,
      }),
    );
    const queueRemove = await inbox1.waitFor(
      (message) =>
        message.type === "command_result" && message.id === "queue-remove",
    );
    assert.equal(queueRemove.ok, true, queueRemove.error);
    assert.equal(queueRemove.data.removed, "queue integration item");

    const entryId = firstSnapshot1.snapshot.messages[0]?._entryId;
    assert.ok(entryId, "seed entry missing");
    ws1.send(JSON.stringify({ id: "fork-1", type: "fork", entryId }));
    const sharedFork = await inbox1.waitFor(
      (message) => message.type === "command_result" && message.id === "fork-1",
      15_000,
    );
    assert.equal(sharedFork.ok, false);
    assert.match(sharedFork.error, /多个窗口/);

    await new Promise((resolvePromise) => {
      ws2.once("close", resolvePromise);
      ws2.close();
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    ws1.send(JSON.stringify({ id: "fork-2", type: "fork", entryId }));
    const forkResult = await inbox1.waitFor(
      (message) => message.type === "command_result" && message.id === "fork-2",
      15_000,
    );
    assert.equal(forkResult.ok, true, forkResult.error);
    const forkFile = forkResult.data?.sessionFile;
    assert.ok(forkFile);
    const rebound = await inbox1.waitFor(
      (message) =>
        message.type === "snapshot" &&
        message.snapshot.sessionFile === forkFile,
    );

    const ws3 = new WebSocket(
      `ws://127.0.0.1:${port}/ws?cwd=${encodeURIComponent(wrongCwd)}&session=${encodeURIComponent(forkFile)}`,
    );
    sockets.push(ws3);
    const inbox3 = socketInbox(ws3);
    const snap3 = await inbox3.waitFor(
      (message) => message.type === "snapshot",
    );
    assert.equal(
      snap3.snapshot.sessionId,
      rebound.snapshot.sessionId,
      "forked file was opened by a duplicate runtime",
    );
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
    ws1.send(
      JSON.stringify({
        id: "persist-fork",
        type: "setSessionName",
        name: "fork-persisted",
      }),
    );
    const persisted = await inbox1.waitFor(
      (message) =>
        message.type === "command_result" && message.id === "persist-fork",
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
      (message) =>
        message.type === "snapshot" &&
        message.snapshot.name === "external-watch-name",
      12_000,
    );
    assert.equal(watched.snapshot.cwd, workspace, "watcher rebind changed cwd");

    await new Promise((resolvePromise) => {
      ws3.once("close", resolvePromise);
      ws3.close();
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    ws1.send(JSON.stringify({ id: "ordered-new", type: "newSession" }));
    ws1.send(
      JSON.stringify({
        id: "ordered-name",
        type: "setSessionName",
        name: "ordered-after-new",
      }),
    );
    const orderedNew = await inbox1.waitFor(
      (message) =>
        message.type === "command_result" && message.id === "ordered-new",
      15_000,
    );
    const orderedName = await inbox1.waitFor(
      (message) =>
        message.type === "command_result" && message.id === "ordered-name",
      15_000,
    );
    assert.equal(orderedNew.ok, true, orderedNew.error);
    assert.equal(orderedName.ok, true, orderedName.error);
    await inbox1.waitFor(
      (message) =>
        message.type === "snapshot" &&
        message.snapshot.name === "ordered-after-new",
    );
    const resultIds = inbox1.messages
      .filter((message) => message.type === "command_result")
      .map((message) => message.id);
    assert.ok(
      resultIds.indexOf("ordered-new") < resultIds.indexOf("ordered-name"),
      "normal command arrival order was not preserved",
    );
  } finally {
    for (const ws of sockets) ws.close();
    child.kill("SIGTERM");
    await new Promise((resolvePromise) => child.once("exit", resolvePromise));
    await rm(temp, { recursive: true, force: true });
  }
});
