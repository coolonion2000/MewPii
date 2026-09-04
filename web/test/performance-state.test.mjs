import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendPartialEvent,
  isBatchablePartialEvent,
} from '../src/partial-events.ts';
import {
  addUsedSession,
  getUsedSessions,
  subscribeUsedSessions,
} from '../src/used-sessions.ts';

function messageDelta(type, contentIndex, delta) {
  return {
    type: 'message_update',
    assistantMessageEvent: { type, contentIndex, delta },
  };
}

test('partial event batches merge compatible deltas and retain event order', () => {
  let pending = [];
  pending = appendPartialEvent(
    pending,
    messageDelta('text_delta', 0, 'hel'),
    10,
  );
  pending = appendPartialEvent(
    pending,
    messageDelta('text_delta', 0, 'lo'),
    11,
  );
  assert.equal(pending.length, 1);
  assert.equal(pending[0].receivedAt, 10);
  assert.equal(pending[0].event.assistantMessageEvent.delta, 'hello');

  pending = appendPartialEvent(
    pending,
    messageDelta('thinking_delta', 0, 'plan '),
    12,
  );
  pending = appendPartialEvent(
    pending,
    messageDelta('thinking_delta', 0, 'next'),
    13,
  );
  pending = appendPartialEvent(
    pending,
    { type: 'tool_execution_update', toolCallId: 'tool-a', update: 'old' },
    14,
  );
  pending = appendPartialEvent(
    pending,
    messageDelta('text_delta', 1, '!'),
    15,
  );
  pending = appendPartialEvent(
    pending,
    { type: 'tool_execution_update', toolCallId: 'tool-a', update: 'latest' },
    16,
  );

  assert.deepEqual(
    pending.map((item) => {
      const sub = item.event.assistantMessageEvent;
      return sub
        ? `${sub.type}:${sub.contentIndex}:${sub.delta}`
        : `tool:${item.event.toolCallId}:${item.event.update}`;
    }),
    [
      'text_delta:0:hello',
      'thinking_delta:0:plan next',
      'text_delta:1:!',
      'tool:tool-a:latest',
    ],
  );
  assert.equal(isBatchablePartialEvent(messageDelta('text_delta', 0, 'x')), true);
  assert.equal(isBatchablePartialEvent(messageDelta('thinking_delta', 0, 'x')), true);
  assert.equal(
    isBatchablePartialEvent({ type: 'tool_execution_update', toolCallId: 'x' }),
    true,
  );
  assert.equal(isBatchablePartialEvent({ type: 'message_end' }), false);
});

test('used-session top entry is idempotent but title and file changes publish', () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  let emits = 0;
  const unsubscribe = subscribeUsedSessions(() => emits++);
  const cwd = `/performance-used-session-${process.pid}`;
  try {
    addUsedSession({
      cwd,
      sessionPath: '/sessions/one.jsonl',
      sessionId: 'one',
      title: 'First',
    });
    const initial = getUsedSessions()[0];
    assert.equal(emits, 1);
    assert.equal(initial.at, 1_000);

    now = 2_000;
    addUsedSession({
      cwd,
      sessionPath: '/sessions/one.jsonl',
      sessionId: 'one',
      title: 'First',
    });
    assert.equal(emits, 1);
    assert.equal(getUsedSessions()[0], initial);
    assert.equal(getUsedSessions()[0].at, 1_000);

    now = 3_000;
    addUsedSession({
      cwd,
      sessionPath: '/sessions/one.jsonl',
      sessionId: 'one',
      title: 'Renamed',
    });
    assert.equal(emits, 2);
    assert.equal(getUsedSessions()[0].title, 'Renamed');
    assert.equal(getUsedSessions()[0].at, 3_000);

    now = 4_000;
    addUsedSession({
      cwd,
      sessionPath: '/sessions/two.jsonl',
      sessionId: 'two',
      title: 'Renamed',
    });
    assert.equal(emits, 3);
    assert.equal(getUsedSessions()[0].sessionPath, '/sessions/two.jsonl');
    assert.equal(getUsedSessions()[0].at, 4_000);
  } finally {
    unsubscribe();
    Date.now = originalNow;
  }
});
