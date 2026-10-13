import assert from 'node:assert/strict';
import test from 'node:test';
import { messageToolCallIds } from '../src/message-tool-dependencies.ts';
import { orphanRunningTools } from '../src/ui-reliability.ts';

test('historical tool dependencies are parsed once across repeated tool updates', () => {
  let blockReads = 0;
  const messages = Array.from({ length: 120 }, (_, messageIndex) => ({
    content: Array.from({ length: 40 }, (_, blockIndex) => ({
      get type() { blockReads++; return blockIndex % 2 ? 'text' : 'toolCall'; },
      id: `${messageIndex}-${blockIndex}`,
    })),
  }));
  for (let update = 0; update < 40; update++) {
    for (const message of messages) assert.equal(messageToolCallIds(message).length, 20);
  }
  // Prior comparator filtered every content array per update: 192,000 reads.
  // Weak caching retains only 4,800 reads, independent of the number of updates.
  assert.equal(blockReads, 120 * 40);
});

test('tool dependency cache follows content replacement and tolerates malformed blocks', () => {
  const message = { content: [null, [], 'text', { type: 'text' }, { type: 'toolCall', id: 42 }, { type: 'toolCall', id: 'old' }] };
  assert.deepEqual(messageToolCallIds(message), ['old']);
  const first = messageToolCallIds(message);
  assert.equal(messageToolCallIds(message), first);
  message.content = [{ type: 'toolCall', id: 'new' }];
  assert.deepEqual(messageToolCallIds(message), ['new']);
  assert.notEqual(messageToolCallIds(message), first);
  assert.deepEqual(messageToolCallIds({ content: 'plain user message' }), []);
});

test('streaming orphan checks never iterate or copy historical tool IDs', () => {
  const history = new Set(Array.from({ length: 20000 }, (_, i) => `done-${i}`));
  let lookups = 0;
  const lookupOnlyHistory = {
    has(id) { lookups++; return history.has(id); },
    [Symbol.iterator]() { throw Error('Historical set must not be copied on a streaming delta'); },
  };
  const tools = new Map([
    ['done-0', { toolCallId: 'done-0', running: true }],
    ['stream', { toolCallId: 'stream', running: true }],
    ['orphan', { toolCallId: 'orphan', running: true }],
    ['idle', { toolCallId: 'idle', running: false }],
  ]);
  for (let delta = 0; delta < 40; delta++) {
    assert.deepEqual(orphanRunningTools(tools, lookupOnlyHistory, [{ type: 'toolCall', id: 'stream' }]), [tools.get('orphan')]);
  }
  assert.equal(lookups, 40 * 3);
  assert.equal(history.size, 20000);
});
