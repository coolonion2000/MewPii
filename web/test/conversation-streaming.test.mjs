import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};
globalThis.location = {
  protocol: 'http:',
  host: '127.0.0.1',
  pathname: '/',
  search: '',
  assign() {},
  reload() {},
};
globalThis.window = {
  fetch: async () => {
    throw new Error('unexpected fetch in Conversation unit test');
  },
};

const bundled = await build({
  entryPoints: [fileURLToPath(new URL('../src/api.ts', import.meta.url))],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
});
const apiUrl = `data:text/javascript;base64,${Buffer.from(
  bundled.outputFiles[0].contents,
).toString('base64')}`;
const { Conversation } = await import(apiUrl);

function snapshot(overrides = {}) {
  return {
    sessionId: 'stream-cache-session',
    sessionFile: '/sessions/stream-cache.jsonl',
    cwd: `/conversation-stream-cache-${process.pid}`,
    isStreaming: true,
    thinkingLevel: 'medium',
    messages: [],
    totalMessages: 0,
    historyFrom: 0,
    queue: { steering: [], followUp: [] },
    queueCapabilities: { revision: 0, reorder: true, remove: true },
    tools: [],
    slashCommands: [],
    ...overrides,
  };
}

test('conversation cache restores an in-flight message and active tool', () => {
  // The agent_start snapshot can lag the first event by one task. Active local
  // state must still make the cache resumable during that narrow race.
  const state = snapshot({ isStreaming: false });
  const source = new Conversation(state.cwd, state.sessionFile);
  source.snapshot = state;
  source.applyEvent({
    type: 'message_update',
    message: {
      role: 'assistant',
      timestamp: 100,
      content: [{ type: 'text', text: 'still running' }],
    },
    assistantMessageEvent: {
      type: 'text_delta',
      contentIndex: 0,
      delta: 'running',
    },
  });
  source.applyEvent({
    type: 'tool_execution_start',
    toolCallId: 'tool-1',
    toolName: 'bash',
    args: { command: 'pwd' },
  }, 110);
  source.applyEvent({
    type: 'tool_execution_update',
    toolCallId: 'tool-1',
    update: '/workspace',
  }, 120);
  source.dispose();

  const restored = new Conversation(state.cwd, state.sessionFile);
  assert.equal(restored.streaming.content[0].text, 'still running');
  assert.deepEqual(restored.tools.get('tool-1'), {
    toolCallId: 'tool-1',
    toolName: 'bash',
    args: { command: 'pwd' },
    running: true,
    startedAt: 110,
    liveOutput: '/workspace',
  });

  restored.applyEvent({
    type: 'message_update',
    message: {
      role: 'assistant',
      timestamp: 100,
      content: [{ type: 'text', text: 'still running!' }],
    },
    assistantMessageEvent: {
      type: 'text_delta',
      contentIndex: 0,
      delta: '!',
    },
  });
  assert.equal(restored.streaming.content[0].text, 'still running!');
});

test('a session identity change cannot leak cached stream state', () => {
  const original = snapshot({
    sessionId: 'old-session',
    sessionFile: `/sessions/old-${process.pid}.jsonl`,
  });
  const conversation = new Conversation(original.cwd, original.sessionFile);
  conversation.snapshot = original;
  conversation.applyEvent({
    type: 'message_update',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'old output' }],
    },
    assistantMessageEvent: {
      type: 'text_delta',
      contentIndex: 0,
      delta: 'old output',
    },
  });
  conversation.applyEvent({
    type: 'tool_execution_start',
    toolCallId: 'old-tool',
    toolName: 'bash',
    args: {},
  });

  conversation.applySnapshot(snapshot({
    sessionId: 'new-session',
    sessionFile: `/sessions/new-${process.pid}.jsonl`,
  }));

  assert.equal(conversation.streaming, undefined);
  assert.equal(conversation.tools.size, 0);
});

test('a late attach restores tools that started while the view was away', () => {
  const state = snapshot({
    sessionId: 'late-tool-session',
    sessionFile: `/sessions/late-tool-${process.pid}.jsonl`,
  });
  const conversation = new Conversation(state.cwd, state.sessionFile);
  conversation.snapshot = state;
  conversation.applySnapshot(snapshot({
    ...state,
    streamingMessage: {
      role: 'assistant',
      timestamp: 456,
      content: [{ type: 'text', text: 'resumed answer' }],
    },
    activeToolCalls: [{
      toolCallId: 'late-tool',
      toolName: 'bash',
      args: { command: 'npm test' },
      startedAt: 123,
      liveOutput: '\u001b[32mpassing\u001b[0m',
    }],
  }));

  assert.equal(conversation.streaming.content[0].text, 'resumed answer');
  assert.deepEqual(conversation.tools.get('late-tool'), {
    toolCallId: 'late-tool',
    toolName: 'bash',
    args: { command: 'npm test' },
    running: true,
    startedAt: 123,
    liveOutput: 'passing',
  });
});

test('metadata-only ready frame restores a live stream from its checkpoint', () => {
  const state = snapshot({
    sessionId: 'ready-resume-session',
    sessionFile: `/sessions/ready-resume-${process.pid}.jsonl`,
  });
  const conversation = new Conversation(state.cwd, state.sessionFile);
  conversation.snapshot = state;
  conversation.handleMessage({
    type: 'session_ready',
    snapshot: {
      ...state,
      streamingMessage: {
        role: 'assistant',
        content: [{ type: 'text', text: 'ready checkpoint' }],
      },
      activeToolCalls: [{
        toolCallId: 'ready-tool',
        toolName: 'read',
        args: { path: '/tmp/file' },
      }],
    },
  });

  assert.equal(conversation.streaming.content[0].text, 'ready checkpoint');
  assert.equal(conversation.tools.get('ready-tool').running, true);
});

test('a live tool snapshot clears an assistant partial that already finalized', () => {
  const state = snapshot({
    sessionId: 'tool-after-message-session',
    sessionFile: `/sessions/tool-after-message-${process.pid}.jsonl`,
  });
  const conversation = new Conversation(state.cwd, state.sessionFile);
  conversation.snapshot = state;
  conversation.applyEvent({
    type: 'message_update',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'already final' }],
    },
    assistantMessageEvent: {
      type: 'text_delta',
      contentIndex: 0,
      delta: 'already final',
    },
  });

  conversation.applySnapshot(snapshot({
    ...state,
    streamingMessage: null,
    activeToolCalls: [{
      toolCallId: 'post-message-tool',
      toolName: 'bash',
      args: {},
    }],
  }));

  assert.equal(conversation.streaming, undefined);
  assert.equal(conversation.tools.get('post-message-tool').running, true);
});
