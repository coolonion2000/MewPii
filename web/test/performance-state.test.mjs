import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendPartialEvent,
  isBatchablePartialEvent,
  normalizeMessageContent,
  normalizeStreamingContent,
  reconcileStreamingMessage,
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

test('cumulative message_update is authoritative and does not repeat its delta', () => {
  const current = {
    role: 'assistant',
    timestamp: 10,
    content: [{ type: 'text', text: 'hel' }],
  };
  const next = reconcileStreamingMessage(current, {
    type: 'message_update',
    message: {
      role: 'assistant',
      timestamp: 10,
      content: [{ type: 'text', text: 'hello' }],
    },
    assistantMessageEvent: {
      type: 'text_delta',
      contentIndex: 0,
      delta: 'lo',
    },
  });

  assert.equal(next.content[0].text, 'hello');
});

test('message_update recovers a missed message_start from its cumulative message', () => {
  const sparse = [];
  sparse[2] = { type: 'text', text: 'back online' };
  const next = reconcileStreamingMessage(undefined, {
    type: 'message_update',
    message: { role: 'assistant', timestamp: 20, content: sparse },
    assistantMessageEvent: {
      type: 'text_delta',
      contentIndex: 2,
      delta: 'line',
    },
  });

  assert.equal(next.role, 'assistant');
  assert.equal(next.content.length, 3);
  assert.ok(next.content.every((block) => block && typeof block === 'object'));
  assert.deepEqual(next.content[0], { type: 'text', text: '' });
  assert.equal(next.content[2].text, 'back online');
});

test('delta-only compatibility path creates safe indexed content blocks', () => {
  const next = reconcileStreamingMessage(undefined, {
    type: 'message_update',
    assistantMessageEvent: {
      type: 'thinking_delta',
      contentIndex: 2,
      delta: 'plan',
    },
  });

  assert.equal(next.content.length, 3);
  assert.ok(next.content.every((block) => block && typeof block === 'object'));
  assert.deepEqual(next.content[2], { type: 'thinking', thinking: 'plan' });
  assert.deepEqual(normalizeStreamingContent('answer'), [
    { type: 'text', text: 'answer' },
  ]);
  assert.deepEqual(
    normalizeMessageContent({
      role: 'assistant',
      content: [null, { type: 'text', text: 'done' }],
    }).content,
    [{ type: 'text', text: '' }, { type: 'text', text: 'done' }],
  );
});

test('batched cumulative deltas retain the newest authoritative message', () => {
  const first = {
    type: 'message_update',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'hel' }],
    },
    assistantMessageEvent: {
      type: 'text_delta',
      contentIndex: 0,
      delta: 'hel',
    },
  };
  const latest = {
    type: 'message_update',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
    },
    assistantMessageEvent: {
      type: 'text_delta',
      contentIndex: 0,
      delta: 'lo',
    },
  };
  const pending = appendPartialEvent(
    appendPartialEvent([], first, 10),
    latest,
    11,
  );

  assert.equal(pending.length, 1);
  assert.equal(pending[0].event.message.content[0].text, 'hello');
  assert.equal(
    reconcileStreamingMessage(undefined, pending[0].event).content[0].text,
    'hello',
  );
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
