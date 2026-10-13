import assert from 'node:assert/strict';
import test from 'node:test';
import { DeliveryReceipts } from '../dist/delivery-receipts.js';
import { SessionHost } from '../dist/session-host.js';

const id = 'message-000000000001';

test('concurrent and completed retries share one execution; changed images cannot reuse the ID', async () => {
  const receipts = new DeliveryReceipts();
  let calls = 0;
  let settle;
  const payload = { type: 'prompt', message: 'hello', images: [{ data: 'a', mimeType: 'image/png' }] };
  const operation = async () => { calls++; return new Promise(resolve => { settle = resolve; }); };
  const first = receipts.run(id, payload, operation);
  const duplicate = receipts.run(id, payload, operation);
  assert.equal(first, duplicate);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.deepEqual(receipts.status(id), { state: 'sending' });
  const result = { ok: true, data: { accepted: true, delivery: 'run' } };
  settle(result);
  assert.deepEqual(await first, result);
  assert.deepEqual(await receipts.run(id, payload, operation), result);
  assert.equal(calls, 1);
  assert.equal(receipts.status(id).state, 'accepted');
  const changed = await receipts.run(id, { ...payload, images: [{ data: 'b', mimeType: 'image/png' }] }, operation);
  assert.equal(changed.ok, false);
  assert.match(changed.error, /different message/);
  assert.equal(calls, 1);
});

test('failed results are remembered, capacity rejects rather than evicting in-flight receipts, expiry is unknown', async () => {
  let now = 10;
  const receipts = new DeliveryReceipts(1, 100, () => now);
  const failed = await receipts.run(id, { type: 'prompt' }, async () => { throw new Error('not accepted'); });
  assert.equal(failed.ok, false);
  assert.equal(receipts.status(id).state, 'failed');
  assert.equal((await receipts.run('message-000000000002', {}, async () => ({ ok: true }))).ok, false);
  now = 200;
  assert.deepEqual(receipts.status(id), { state: 'unknown' });
  assert.deepEqual(new DeliveryReceipts().status(id), { state: 'unknown' }, 'a restarted server must not claim rejection');
  let settle;
  const pending = receipts.run('message-000000000002', {}, async () => new Promise(resolve => { settle = resolve; }));
  await Promise.resolve();
  now = 1000;
  assert.equal(receipts.status('message-000000000002').state, 'sending', 'never expire a running mutation');
  settle({ ok: true });
  await pending;
});

test('SessionHost shares receipts across socket request IDs; status bypasses blocked command lane', async () => {
  const host = Object.create(SessionHost.prototype);
  host.commandMutationChain = Promise.resolve();
  host.pendingCommandMutations = 0;
  host.stopEpoch = 0;
  host.key = 'receipt-test';
  let calls = 0;
  let settle;
  host.handleCommand = async () => { calls++; return new Promise(resolve => { settle = resolve; }); };
  const first = host.handleOrdered({ type: 'prompt', message: 'hello', deliveryId: id, id: 'c1' });
  const second = host.handleOrdered({ type: 'prompt', message: 'hello', deliveryId: id, id: 'c2' });
  await new Promise(resolve => setImmediate(resolve));
  const status = await host.handleOrdered({ type: 'delivery_status', deliveryId: id });
  assert.equal(status.data.state, 'sending');
  assert.equal(calls, 1);
  settle({ ok: true, data: { accepted: true } });
  assert.deepEqual(await first, await second);
  assert.equal((await host.handleOrdered({ type: 'delivery_status', deliveryId: id })).data.state, 'accepted');
  assert.equal(calls, 1);
});

test('large outputs are returned once but retained receipts remain bounded', async () => {
  const receipts = new DeliveryReceipts();
  const payload = { type: 'slash', raw: '/large-output' };
  const first = await receipts.run(id, payload, async () => ({ ok: true, data: { output: 'x'.repeat(100_000) } }));
  assert.equal(first.data.output.length, 100_000);
  const repeated = await receipts.run(id, payload, async () => { throw new Error('must not execute twice'); });
  assert.deepEqual(repeated, { ok: true, data: { accepted: true, deliveryResultOmitted: true } });
  assert.ok(JSON.stringify(receipts.status(id)).length < 200);
});
