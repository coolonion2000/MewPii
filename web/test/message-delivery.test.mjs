import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { canRecordDelivery, deliveryFingerprint, deliveryFingerprintAsync, readDeliveries, writeDeliveries } from '../src/delivery-store.ts';

globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
const persisted = new Map();
globalThis.sessionStorage = { getItem(key) { return persisted.get(key) ?? null; }, setItem(key, value) { persisted.set(key, value); } };
globalThis.location = { protocol: 'http:', host: '127.0.0.1', pathname: '/chat', search: '', assign() {}, reload() {} };
globalThis.window = { fetch: async () => ({ ok: true }) };
class Socket {
  static OPEN = 1;
  static instances = [];
  readyState = 1;
  sent = [];
  constructor() { Socket.instances.push(this); }
  send(wire) { this.sent.push(JSON.parse(wire)); }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
  receive(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  result(command, data, ok = true, error) { this.receive({ type: 'command_result', id: command.id, ok, data, error }); }
}
globalThis.WebSocket = Socket;
const bundled = await build({ entryPoints: [fileURLToPath(new URL('../src/api.ts', import.meta.url))], bundle: true, format: 'esm', platform: 'browser', write: false });
const { Conversation, DeliveryUnknownError, DeliveryNotSentError } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString('base64')}`);
const sessionId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const snapshot = { cwd: '/delivery-test', sessionId, sessionFile: '/delivery-test/session.jsonl', initializing: false,
  isStreaming: false, messages: [], thinkingLevel: 'medium', totalMessages: 0, historyFrom: 0,
  queue: { steering: [], followUp: [] }, tools: [], slashCommands: [] };
function ready(conv) {
  conv.connect();
  const ws = Socket.instances.at(-1);
  ws.onopen();
  ws.receive({ type: 'snapshot', snapshot });
  return ws;
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('lost acknowledgement becomes unknown and reconnect checks original receipt without replaying prompt', async () => {
  const conv = new Conversation(snapshot.cwd);
  try {
    const first = ready(conv);
    assert.equal(conv.transportOpen, true);
    const send = conv.send({ type: 'prompt', message: 'continue' });
    const prompt = first.sent.at(-1);
    assert.equal(conv.delivery.state, 'sending');
    first.close(1006);
    await assert.rejects(send, cause => cause instanceof DeliveryUnknownError && cause.deliveryId === prompt.deliveryId);
    assert.equal(conv.delivery.state, 'unknown');
    assert.equal(conv.transportOpen, false);
    const restored = ready(conv);
    const query = restored.sent.at(-1);
    assert.equal(query.type, 'delivery_status');
    assert.equal(query.deliveryId, prompt.deliveryId);
    restored.result(query, { state: 'accepted', result: { ok: true, data: { accepted: true, delivery: 'run' } } });
    await tick();
    assert.equal(conv.delivery.state, 'accepted');
    assert.equal(restored.sent.filter(command => command.type === 'prompt').length, 0);
    assert.equal(conv.error, undefined);
  } finally { conv.dispose(); }
});

test('unknown receipt never blindly resends same payload, while different images are a different message', async () => {
  const conv = new Conversation(snapshot.cwd);
  try {
    const first = ready(conv);
    const message = { type: 'prompt', message: 'look', images: [{ data: 'a', mimeType: 'image/png' }] };
    const pending = conv.send(message);
    const originalId = first.sent.at(-1).deliveryId;
    first.close(1006);
    await assert.rejects(pending, DeliveryUnknownError);
    const restored = ready(conv);
    restored.result(restored.sent.at(-1), { state: 'unknown' });
    await tick();
    const retry = conv.send(message);
    assert.equal(restored.sent.at(-1).type, 'delivery_status');
    assert.equal(restored.sent.at(-1).deliveryId, originalId);
    restored.result(restored.sent.at(-1), { state: 'unknown' });
    await assert.rejects(retry, cause => cause instanceof DeliveryUnknownError && cause.alreadySubmitted);
    assert.equal(restored.sent.filter(command => command.type === 'prompt').length, 0);
    const different = conv.send({ ...message, images: [{ data: 'b', mimeType: 'image/png' }] });
    const secondPrompt = restored.sent.at(-1);
    assert.equal(secondPrompt.type, 'prompt');
    assert.notEqual(secondPrompt.deliveryId, originalId);
    restored.result(secondPrompt, { accepted: true });
    await different;
  } finally { conv.dispose(); }
});

test('explicit server rejection is failed and permits a fresh attempt; receipt acceptance is not model completion', async () => {
  const conv = new Conversation(snapshot.cwd);
  try {
    const ws = ready(conv);
    const command = { type: 'prompt', message: 'hello' };
    const first = conv.send(command);
    const rejectedId = ws.sent.at(-1).deliveryId;
    ws.result(ws.sent.at(-1), undefined, false, 'model not selected');
    await assert.rejects(first, /model not selected/);
    assert.equal(conv.delivery.state, 'failed');
    const retry = conv.send(command);
    assert.notEqual(ws.sent.at(-1).deliveryId, rejectedId);
    ws.result(ws.sent.at(-1), { accepted: true });
    await retry;
    assert.equal(conv.delivery.state, 'accepted');
    assert.deepEqual(conv.messages, [], 'no artificial model response or completion is introduced');
  } finally { conv.dispose(); }
});

test('late ACK after timeout resolves unknown state; a stale status response cannot downgrade acceptance', async () => {
  const conv = new Conversation(snapshot.cwd);
  const originalSetTimeout = globalThis.setTimeout;
  try {
    const ws = ready(conv);
    globalThis.setTimeout = (callback, ms, ...args) => originalSetTimeout(callback, ms === 120000 ? 0 : ms, ...args);
    const send = conv.send({ type: 'prompt', message: 'delayed ack' });
    const prompt = ws.sent.at(-1);
    await assert.rejects(send, DeliveryUnknownError);
    globalThis.setTimeout = originalSetTimeout;
    const check = conv.checkDelivery();
    const query = ws.sent.at(-1);
    ws.result(prompt, { accepted: true });
    assert.equal(conv.delivery.state, 'accepted');
    ws.result(query, { state: 'sending' });
    assert.deepEqual(await check, { accepted: true });
    assert.equal(conv.delivery.state, 'accepted');
  } finally { globalThis.setTimeout = originalSetTimeout; conv.dispose(); }
});

test('delivery fingerprints match standard SHA-256 across Unicode and multi-block/image payloads', () => {
  for (const value of ['', 'a', '你好🌏', 'x'.repeat(55), 'x'.repeat(64), { images: [{ data: 'a'.repeat(131072), mimeType: 'image/png' }] }]) {
    const expected = createHash('sha256').update(JSON.stringify(value)).digest('hex');
    assert.equal(deliveryFingerprint(value), expected);
  }
});

test('receipt storage is payload-free, validates malformed entries and survives a fresh module instance', async () => {
  const scope = 'storage-test';
  writeDeliveries(scope, [{ id: 'delivery-000000000001', type: 'prompt', state: 'sending', updatedAt: 1,
    fingerprint: deliveryFingerprint({ message: 'private-content', images: [{ data: 'secret-image' }] }),
    message: 'must-not-store', error: 'must-not-store-either' }]);
  const wire = persisted.get('mewpii.delivery-receipts.v1');
  assert.ok(!wire.includes('private-content') && !wire.includes('secret-image') && !wire.includes('must-not-store'));
  const { readDeliveries: reloaded } = await import('../src/delivery-store.ts?fresh');
  assert.equal(reloaded(scope)[0].state, 'unknown');
  writeDeliveries(scope, []);
  assert.deepEqual(readDeliveries(scope), []);
});

test('switching away preserves unconfirmed receipts; queue-mode changes after reconnect cannot bypass dedup', async () => {
  const original = new Conversation(snapshot.cwd);
  const later = new Conversation(snapshot.cwd);
  try {
    const ws = ready(original);
    const sending = original.send({ type: 'prompt', message: 'switch-view-test' });
    const deliveryId = ws.sent.at(-1).deliveryId;
    original.dispose();
    await assert.rejects(sending, DeliveryUnknownError);
    const next = ready(later);
    assert.ok(later.unsettledDeliveries.some(item => item.id === deliveryId));
    for (const query of next.sent) next.result(query, { state: 'unknown' });
    await tick();
    const retry = later.send({ type: 'prompt', message: 'switch-view-test', streamingBehavior: 'steer' });
    const query = next.sent.at(-1);
    assert.equal(query.type, 'delivery_status');
    assert.equal(query.deliveryId, deliveryId);
    next.result(query, { state: 'accepted', result: { ok: true, data: { accepted: true } } });
    const result = await retry;
    assert.equal(result.deliveryAlreadySubmitted, true);
    assert.equal(next.sent.filter(command => command.type === 'prompt').length, 0);
  } finally { original.dispose(); later.dispose(); }
});

test('session-changing slash results settle their original scope without poisoning the new session', async () => {
  const conv = new Conversation(snapshot.cwd);
  try {
    const ws = ready(conv);
    const sending = conv.send({ type: 'slash', raw: '/new' });
    const command = ws.sent.at(-1);
    const oldScope = JSON.stringify(['', snapshot.cwd, sessionId]);
    const newId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    ws.receive({ type: 'snapshot', snapshot: { ...snapshot, sessionId: newId, sessionFile: '/delivery-test/new.jsonl' } });
    ws.result(command, { output: 'new session created' });
    await sending;
    assert.equal(conv.getDelivery(command.deliveryId).state, 'accepted');
    assert.ok(!conv.unsettledDeliveries.some(item => item.id === command.deliveryId));
    assert.ok(!readDeliveries(oldScope).some(item => item.id === command.deliveryId));
    assert.notEqual(conv.delivery?.id, command.deliveryId);
    assert.equal(conv.deliveryRequestIds.size, 0);
  } finally { conv.dispose(); }
});

test('multi-megabyte SHA-256 uses native async digest or yielding fallback with identical fingerprints', async () => {
  const payload = { images: [{ data: 'abc'.repeat(1024 * 1024), mimeType: 'image/png' }] };
  const expected = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  assert.equal(await deliveryFingerprintAsync(payload), expected);
  let ticks = 0;
  const heartbeat = setInterval(() => ticks++, 0);
  try {
    assert.equal(await deliveryFingerprintAsync(payload, false), expected);
    assert.ok(ticks >= 2, 'fallback hashing must yield to input/timers between chunks');
  } finally { clearInterval(heartbeat); }
});

test('navigation during large-image hashing is explicitly not sent and cannot dispatch to the new scope', async () => {
  const conv = new Conversation(snapshot.cwd);
  try {
    const ws = ready(conv);
    const before = ws.sent.length;
    const sending = conv.send({ type: 'prompt', message: 'large image', images: [{ data: 'a'.repeat(1024 * 1024), mimeType: 'image/png' }] });
    const newId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    ws.receive({ type: 'snapshot', snapshot: { ...snapshot, sessionId: newId, sessionFile: '/delivery-test/third.jsonl' } });
    await assert.rejects(sending, cause => cause instanceof DeliveryNotSentError && cause.reason === 'session_changed');
    assert.equal(ws.sent.slice(before).filter(command => command.type === 'prompt').length, 0);
  } finally { conv.dispose(); }
});

test('late-ACK request mapping is bounded and a status settlement releases the original mapping', async () => {
  const conv = new Conversation(snapshot.cwd);
  try {
    const ws = ready(conv);
    const command = { type: 'prompt', message: 'mapping-test' };
    const pending = conv.send(command);
    const original = ws.sent.at(-1);
    assert.equal(conv.deliveryRequestIds.get(original.id), original.deliveryId);
    const check = conv.checkDelivery();
    ws.result(ws.sent.at(-1), { state: 'accepted', result: { ok: true, data: { accepted: true } } });
    await check;
    assert.equal(conv.deliveryRequestIds.has(original.id), false);
    ws.result(original, { accepted: true });
    await pending;
    assert.equal(conv.deliveryRequestIds.size, 0);
  } finally { conv.dispose(); }
});

test('unconfirmed receipt bounds reject new records without deleting old safety metadata', () => {
  const scope = 'capacity-test';
  const records = Array.from({ length: 64 }, (_, i) => ({ id: `delivery-${String(i).padStart(16, '0')}`, type: 'prompt',
    state: 'unknown', updatedAt: 1, fingerprint: deliveryFingerprint(i) }));
  writeDeliveries(scope, records);
  assert.equal(canRecordDelivery(scope), false);
  assert.equal(readDeliveries(scope).length, 64);
  writeDeliveries(scope, []);
  assert.equal(canRecordDelivery(scope), true);
});

test('completed large command output reaches its caller but is not retained in browser receipts', async () => {
  const conv = new Conversation(snapshot.cwd);
  try {
    const ws = ready(conv);
    const sending = conv.send({ type: 'slash', raw: '/export-large-result' });
    const command = ws.sent.at(-1);
    ws.result(command, { output: 'x'.repeat(100_000) });
    const first = await sending;
    assert.equal(first.output.length, 100_000);
    const retained = await conv.checkDelivery(command.deliveryId);
    assert.deepEqual(retained, { accepted: true, deliveryResultOmitted: true });
  } finally { conv.dispose(); }
});

test('repeated transport timeouts cannot retain more than 256 late-ACK mappings', async () => {
  const conv = new Conversation(snapshot.cwd);
  const originalSetTimeout = globalThis.setTimeout;
  try {
    const ws = ready(conv);
    globalThis.setTimeout = (callback, ms, ...args) => originalSetTimeout(callback, ms === 120000 ? 0 : ms, ...args);
    for (let i = 0; i < 260; i++) {
      const pending = conv.sendRequest({ type: 'prompt', message: 'mapping-capacity', deliveryId: `delivery-${String(i).padStart(16, '0')}` });
      await assert.rejects(pending, /timed out/);
    }
    assert.equal(conv.deliveryRequestIds.size, 256);
    ws.close(1006);
    assert.equal(conv.deliveryRequestIds.size, 0);
  } finally { globalThis.setTimeout = originalSetTimeout; conv.dispose(); }
});
