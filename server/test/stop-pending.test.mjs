/** @author coolonion */
import assert from "node:assert/strict";
import test from "node:test";
import { SessionHost } from "../dist/session-host.js";

test("failed stop retains tool and clock; successful retry clears them", async () => {
  let settle = false;
  const ended = [];
  const session = {
    isStreaming: true,
    clearQueue: () => ({ steering: [], followUp: [] }),
    agent: { abort() {} },
    abort() {
      if (!settle) return new Promise(() => {});
      this.isStreaming = false;
      return Promise.resolve();
    },
  };
  const host = new SessionHost("stop-pending", { session, dispose: async () => {} }, {},
    undefined, undefined, undefined, 1000, 1000, 20);
  host.broadcastSnapshot = () => {};
  host.onToolExecution = (tool, phase) => ended.push([tool, phase]);
  host.activeToolCalls.set("call-1", { toolName: "ctx_execute" });
  host.runStartedAt = 123;
  try {
    const first = await host.handleOrdered({ type: "abort" });
    assert.equal(first.ok, false);
    assert.match(first.error, /settlement_timeout/);
    assert.equal(host.activeToolCalls.size, 1);
    assert.equal(host.runStartedAt, 123);
    assert.deepEqual(ended, []);
    settle = true;
    const second = await host.handleOrdered({ type: "abort" });
    assert.equal(second.ok, true);
    assert.equal(host.activeToolCalls.size, 0);
    assert.equal(host.runStartedAt, undefined);
    assert.deepEqual(ended, [["ctx_execute", "end"]]);
  } finally {
    await host.dispose();
  }
});

test("late mutation abort failure also retains the actual running tool", async () => {
  const session = { isStreaming: true, clearQueue() {}, abort: async () => { throw new Error("abort failed"); } };
  const host = new SessionHost("late-stop-pending", { session, dispose: async () => {} }, {});
  host.broadcastSnapshot = () => {};
  host.stopEpoch = 1;
  host.activeToolCalls.set("late", { toolName: "ctx_execute" });
  host.runStartedAt = 456;
  try {
    await host.quiesceLateMutation(0);
    assert.equal(host.activeToolCalls.size, 1);
    assert.equal(host.runStartedAt, 456);
  } finally { await host.dispose(); }
});
