import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapModelTiming } from '../dist/model-timing.js';

function fixture(events) {
  let clock = 0;
  const logs = [];
  const original = async () => ({async *[Symbol.asyncIterator]() {
    for (const [at, event] of events) { clock = at; yield event; }
  }});
  return { logs, wrapped: wrapModelTiming(original, () => 'test-session', (event, fields) => logs.push({event, ...fields}), () => clock) };
}

test('all providers separate metadata from first generated content, without logging payloads', async () => {
  for (const provider of ['openai-codex', 'custom-provider']) {
    const {logs, wrapped} = fixture([[10, {type: 'start'}], [12, {type: 'text_delta', delta: ''}],
      [25, {type: 'thinking_delta', delta: 'SECRET_TEXT'}], [40, {type: 'text_delta', delta: 'SECRET_TEXT'}],
      [50, {type: 'done'}]]);
    const stream = await wrapped({provider, id: 'test'}, {messages: ['SECRET_PROMPT']}, {apiKey: 'SECRET_KEY'});
    const received = [];
    for await (const event of stream) received.push(event);
    assert.equal(received.length, 5);
    assert.equal(logs.length, 3);
    assert.equal(logs[1].first_event_ms, 10);
    assert.equal(logs[1].first_content_ms, 25);
    assert.equal(logs[2].duration_ms, 50);
    assert.equal(logs[2].outcome, 'completed');
    assert.doesNotMatch(JSON.stringify(logs), /SECRET/);
  }
});

test('empty, error and abandoned streams log once without invented TTFT', async () => {
  for (const [event, outcome] of [[{type: 'done'}, 'completed'], [{type: 'error'}, 'error'], [{type: 'start'}, 'closed']]) {
    const {logs, wrapped} = fixture([[8, event]]);
    for await (const _ of await wrapped({provider: 'test', id: 'test'}, {}, {})) { /* consume */ }
    assert.equal(logs.length, 2);
    assert.equal(logs[1].first_content_ms, null);
    assert.equal(logs[1].outcome, outcome);
  }
});

test('setup and iterator failures preserve errors; diagnostic sink failures cannot interrupt output', async () => {
  const logs = [];
  const expected = new Error('provider failed');
  const wrap = original => wrapModelTiming(original, () => 'test', (event, fields) => logs.push({event, ...fields}));
  await assert.rejects(wrap(async () => {throw expected;})({provider: 'test', id: 'test'}, {}), error => error === expected);
  assert.equal(logs.at(-1).outcome, 'setup_error');
  const stream = await wrap(async () => ({async *[Symbol.asyncIterator]() {throw expected;}}))({provider: 'test', id: 'test'}, {});
  await assert.rejects(async () => { for await (const _ of stream) {} }, error => error === expected);
  assert.equal(logs.at(-1).outcome, 'error');
  const safe = wrapModelTiming(async () => ({async *[Symbol.asyncIterator]() {yield {type: 'done'};}}), () => 'test', () => {throw new Error('log sink failed');});
  for await (const event of await safe({provider: 'test', id: 'test'}, {})) assert.equal(event.type, 'done');
});
