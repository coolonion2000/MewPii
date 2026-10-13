/** Recent transcript hydration must stay independent of model/session execution. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
globalThis.sessionStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
globalThis.location = { protocol: 'http:', host: '127.0.0.1', href: 'http://127.0.0.1/chat', pathname: '/chat', search: '', assign() {}, reload() {} };
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
  result(command, ok = true) { this.receive({ type: 'command_result', id: command.id, ok, error: ok ? undefined : 'history unavailable' }); }
}
globalThis.WebSocket = Socket;
const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/api.ts', import.meta.url))], bundle: true, format: 'esm', platform: 'browser', write: false });
const { Conversation } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
const tick = () => new Promise(resolve => setImmediate(resolve));
const rows = (count, toolHeavy = false) => Array.from({ length: count }, (_, i) => ({
  _entryId: `entry-${i}`, role: toolHeavy && i % 3 !== 0 ? 'toolResult' : 'assistant', content: [{type: 'text', text: `row ${i}`}],
}));
let sequence = 0;
function fixture(messages, before, overrides = {}) {
  const cwd = `/recent-history-${++sequence}`;
  const snap = { cwd, sessionId: cwd, sessionFile: `${cwd}/session.jsonl`, branchHeadId: 'head-a',
    initializing: false, isStreaming: false, messages, totalMessages: before + messages.length,
    historyFrom: before, thinkingLevel: 'medium', queue: {steering: [], followUp: []}, tools: [], slashCommands: [], ...overrides };
  const conv = new Conversation(cwd);
  conv.connect();
  const ws = Socket.instances.at(-1);
  ws.onopen();
  ws.receive({ type: 'snapshot', snapshot: snap });
  return {conv, ws, snap};
}
const requests = ws => ws.sent.filter(command => command.type === 'history');
function page(ws, snap, command, messages, before) {
  ws.receive({ type: 'history', requestId: command.requestId, sessionId: snap.sessionId,
    branchHeadId: snap.branchHeadId, messages, before });
  ws.result(command);
}

test('a thin image-limited snapshot hydrates 50 visible rows in sequential pages without blocking sends', async () => {
  const all = rows(160, true);
  const {conv, ws, snap} = fixture(all.slice(159), 159);
  try {
    assert.equal(requests(ws).length, 0, 'first ready render is synchronous, hydration is background');
    await tick();
    assert.equal(requests(ws).length, 1);
    conv.loadOlder();
    assert.equal(requests(ws).length, 1, 'manual and background paging share one in-flight request');
    const send = conv.send({type: 'prompt', message: 'still usable while history loads'});
    const normal = ws.sent.at(-1);
    assert.equal(normal.type, 'prompt');
    ws.result(normal);
    await send;
    for (let expected = 1; expected <= 3; expected++) {
      assert.equal(requests(ws).length, expected);
      const command = requests(ws).at(-1);
      const before = command.before - 50;
      page(ws, snap, command, all.slice(before, command.before), before);
      await tick();
    }
    assert.equal(requests(ws).length, 3);
    assert.equal(conv.historyFrom, 9);
    assert.equal(conv.messages.filter(message => message.role === 'assistant').length, 51);
    assert.equal(conv.historyInFlight, false);
  } finally { conv.dispose(); }
});

test('provisional initialization waits for authoritative ready paging and complete recent history sends nothing', async () => {
  const all = rows(80);
  const {conv, ws, snap} = fixture(all.slice(79), 0, {initializing: true, pagingProvisional: true});
  try {
    await tick();
    assert.equal(requests(ws).length, 0);
    const {messages, ...ready} = {...snap, initializing: false, historyFrom: 79, totalMessages: 80};
    ws.receive({type: 'session_ready', snapshot: ready});
    await tick();
    assert.equal(requests(ws)[0].before, 79);
    page(ws, snap, requests(ws)[0], all.slice(29, 79), 29);
    await tick();
    assert.equal(requests(ws).length, 1);
    ws.receive({type: 'snapshot', snapshot: {...ready, messages: all.slice(30), historyFrom: 30}});
    await tick();
    assert.equal(requests(ws).length, 1);
  } finally { conv.dispose(); }
});

test('paging failure does not retry on snapshots, but explicit manual retry remains available', async () => {
  const all = rows(80);
  const {conv, ws, snap} = fixture(all.slice(79), 79);
  try {
    await tick();
    ws.result(requests(ws)[0], false);
    await tick();
    for (let i = 0; i < 3; i++) ws.receive({type: 'snapshot', snapshot: snap});
    await tick();
    assert.equal(requests(ws).length, 1);
    assert.equal(conv.historyInFlight, false);
    conv.loadOlder();
    assert.equal(requests(ws).length, 2);
    page(ws, snap, requests(ws)[1], all.slice(29, 79), 29);
    await tick();
    assert.equal(conv.messages.length, 51);
  } finally { conv.dispose(); }
});

test('compaction or reconnect thin snapshot preserves the proven already-visible transcript', async () => {
  const all = rows(101);
  const {conv, ws, snap} = fixture(all.slice(50, 100), 50);
  try {
    await tick();
    assert.equal(requests(ws).length, 0);
    ws.receive({type: 'event', event: {type: 'compaction_start', reason: 'threshold'}});
    ws.receive({type: 'event', event: {type: 'compaction_end'}});
    ws.receive({type: 'snapshot', snapshot: {...snap, branchHeadId: 'head-after-compaction',
      messages: all.slice(100), historyFrom: 100, totalMessages: 101, historyBeforeEntryId: 'entry-99'}});
    await tick();
    assert.deepEqual(conv.messages.map(message => message._entryId), all.slice(50).map(message => message._entryId));
    assert.equal(conv.historyFrom, 50);
    assert.equal(requests(ws).length, 0, 'loaded recent rows need no network replay');
  } finally { conv.dispose(); }
});

test('no-progress and wrong-branch history responses stop background hydration', async () => {
  for (const wrongBranch of [false, true]) {
    const {conv, ws, snap} = fixture(rows(1), 20);
    try {
      await tick();
      const command = requests(ws)[0];
      page(ws, wrongBranch ? {...snap, branchHeadId: 'other-head'} : snap, command,
        wrongBranch ? rows(20) : [], wrongBranch ? 0 : 20);
      await tick();
      ws.receive({type: 'snapshot', snapshot: snap});
      await tick();
      assert.equal(requests(ws).length, 1);
      assert.equal(conv.messages.length, 1);
      assert.equal(conv.historyFrom, 20);
    } finally { conv.dispose(); }
  }
});

test('late history cannot contaminate a switched session or branch', async () => {
  for (const switchSession of [false, true]) {
    const {conv, ws, snap} = fixture(rows(1), 20);
    try {
      await tick();
      const command = requests(ws)[0];
      const nextRows = rows(50).map(message => ({...message, _entryId: `new-${message._entryId}`}));
      const next = {...snap, messages: nextRows, historyFrom: 0, totalMessages: 50, branchHeadId: 'head-b',
        sessionId: switchSession ? 'session-b' : snap.sessionId};
      ws.receive({type: 'snapshot', snapshot: next});
      page(ws, snap, command, rows(20), 0);
      await tick();
      assert.deepEqual(conv.messages.map(message => message._entryId), nextRows.map(message => message._entryId));
      assert.equal(conv.historyFrom, 0);
      assert.equal(requests(ws).length, 1);
    } finally { conv.dispose(); }
  }
});

test('disconnect and disposal cancel scheduled hydration; a fresh reconnect can resume', async () => {
  const {conv, ws, snap} = fixture(rows(1), 20);
  try {
    ws.close(1006);
    await tick();
    assert.equal(requests(ws).length, 0);
    conv.connect();
    const restored = Socket.instances.at(-1);
    restored.onopen();
    restored.receive({type: 'snapshot', snapshot: snap});
    await tick();
    assert.equal(requests(restored).length, 1);
    conv.dispose();
    await tick();
    assert.equal(requests(restored).length, 1);
  } finally { conv.dispose(); }
  const closed = fixture(rows(1), 20);
  closed.conv.dispose();
  await tick();
  assert.equal(requests(closed.ws).length, 0);
});
