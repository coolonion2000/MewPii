/** Pending preview ownership regressions. @author coolonion */
import assert from "node:assert/strict";
import test from "node:test";
import { PendingHostCreations } from "../dist/pending-host-creations.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const snapshot = (path = "/sessions/new.jsonl") => ({
  cwd: "/workspace", sessionId: "new", sessionFile: path, initializing: true,
});

test("preview reattachments share one delayed creation and release ownership on success", async () => {
  const pending = new PendingHostCreations();
  const gate = deferred();
  const published = deferred();
  const frames = [];
  let creates = 0;
  const creation = pending.start("new:1", "/workspace", undefined, async (publish) => {
    creates++;
    await publish(snapshot());
    published.resolve();
    return gate.promise;
  }, (frame) => frames.push(frame));
  await published.promise;
  assert.equal(pending.size, 1);
  assert.equal(pending.get("/sessions/unknown.jsonl"), undefined);
  const replay = [];
  const joined = pending.join(pending.get(snapshot().sessionFile), (frame) => replay.push(frame));
  await Promise.resolve();
  assert.deepEqual(replay, frames);
  const host = {};
  gate.resolve(host);
  assert.equal(await creation, host);
  assert.equal(await joined, host);
  assert.equal(creates, 1);
  assert.equal(pending.size, 0);
  assert.equal(pending.get(snapshot().sessionFile), undefined);
});

test("failed creation rejects all viewers, clears preview and initial aliases, and permits retry", async () => {
  const pending = new PendingHostCreations();
  const gate = deferred();
  const published = deferred();
  const initial = "/sessions/original.jsonl";
  const creation = pending.start("file:original", "/workspace", initial, async (publish) => {
    await publish(snapshot());
    published.resolve();
    return gate.promise;
  });
  const failure = assert.rejects(creation, /creation failed/);
  await published.promise;
  const joined = assert.rejects(pending.join(pending.get(snapshot().sessionFile)), /creation failed/);
  gate.reject(new Error("creation failed"));
  await Promise.all([failure, joined]);
  assert.equal(pending.size, 0);
  assert.deepEqual(pending.values(), []);
  assert.equal(pending.get(initial), undefined);
  assert.equal(pending.get(snapshot().sessionFile), undefined);
  assert.equal(await pending.start("file:original", "/workspace", initial, async () => "retry"), "retry");
});

test("pending creations, preview aliases, and disconnected listeners remain bounded", async () => {
  const pending = new PendingHostCreations(1, 1);
  const gate = deferred();
  const published = deferred();
  const controller = new AbortController();
  let publishNext;
  let deliveries = 0;
  const creation = pending.start("new:1", "/workspace", undefined, async (publish) => {
    publishNext = publish;
    await publish(snapshot());
    published.resolve();
    return gate.promise;
  }, () => { deliveries++; }, controller.signal);
  await published.promise;
  assert.throws(() => pending.start("new:2", "/workspace", undefined, async () => ({})), /too many initializing/);
  const entry = pending.get(snapshot().sessionFile);
  await assert.rejects(pending.join(entry, () => {}), /too many session initialization viewers/);
  controller.abort();
  assert.equal(entry.listeners.size, 0);
  const replay = [];
  const joined = pending.join(entry, (frame) => replay.push(frame));
  await Promise.resolve();
  await publishNext(snapshot("/sessions/reconciled.jsonl"));
  assert.equal(pending.get(snapshot().sessionFile), undefined);
  assert.equal(pending.get("/sessions/reconciled.jsonl"), entry);
  assert.equal(deliveries, 1);
  assert.equal(replay.length, 2);
  gate.resolve({});
  await Promise.all([creation, joined]);
  assert.equal(entry.listeners.size, 0);
  assert.equal(pending.get("/sessions/reconciled.jsonl"), undefined);
});
