/** Recent transcript pages remain useful without changing durable history. */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  readRawSessionPreview,
  SESSION_HISTORY_MAX_BYTES,
  SESSION_HISTORY_MAX_MESSAGES,
  SESSION_RECENT_MAX_BYTES,
  SESSION_RECENT_MAX_MESSAGES,
  SESSION_RECENT_VISIBLE_MESSAGES,
  SessionHost,
} from '../dist/session-host.js';

const visible = message => message.role === 'user' || message.role === 'assistant';
const ids = messages => messages.map(message => message._entryId);
const bytes = messages => Buffer.byteLength(JSON.stringify(messages));

function entriesFor(messages) {
  return messages.map((message, index) => ({
    type: 'message', id: `e${index}`, parentId: index ? `e${index - 1}` : null,
    timestamp: '2026-01-01T00:00:00.000Z', message,
  }));
}

function textMessages(count, length = 12) {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: [{ type: 'text', text: `${index}:${'x'.repeat(length)}` }],
  }));
}

function createHost(entries, contextMessages = entries.filter(entry => entry.type === 'message').map(entry => entry.message)) {
  const session = {
    sessionId: 'recent-history', sessionFile: undefined, sessionName: undefined,
    isStreaming: false, thinkingLevel: 'off', model: undefined,
    messages: contextMessages,
    sessionManager: { getLeafId: () => entries.at(-1)?.id, getBranch: () => entries },
    getSessionStats: () => ({ userMessages: 0, assistantMessages: 0, toolCalls: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
    getAvailableThinkingLevels: () => ['off'], getActiveToolNames: () => [],
    extensionRunner: { getRegisteredCommands: () => [] },
    promptTemplates: [], resourceLoader: { getSkills: () => ({ skills: [] }) },
  };
  return new SessionHost('recent-history', { session, cwd: '/tmp', dispose: async () => undefined }, {});
}

function historyPage(host, before) {
  const frames = [];
  host.sendHistory({ OPEN: 1, readyState: 1, send: raw => frames.push(JSON.parse(String(raw))) }, before, `page-${before}`);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, 'history');
  return frames[0];
}

function recoverHistory(host, snapshot) {
  let before = snapshot.historyFrom;
  let recovered = snapshot.messages;
  while (before > 0) {
    const page = historyPage(host, before);
    assert.ok(page.before < before, 'every older page must advance its cursor');
    assert.ok(page.messages.length <= SESSION_HISTORY_MAX_MESSAGES);
    assert.ok(bytes(page.messages) <= SESSION_HISTORY_MAX_BYTES || page.messages.length === 1,
      'history retains its small page budget, with only a single oversize-message exception');
    recovered = [...page.messages, ...recovered];
    before = page.before;
  }
  return recovered;
}

function assertBoundary(snapshot, entries) {
  const durableMessages = entries.filter(entry => entry.type === 'message');
  assert.equal(snapshot.historyBeforeEntryId,
    snapshot.historyFrom ? durableMessages[snapshot.historyFrom - 1].id : undefined);
}

test('a 1 MiB penultimate image does not reduce the initial snapshot to its last reply', async () => {
  const messages = textMessages(227);
  messages[225] = { role: 'toolResult', toolCallId: 'screenshot', toolName: 'mcp',
    content: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(1024 * 1024) }] };
  const entries = entriesFor(messages);
  const host = createHost(entries);
  try {
    const snapshot = host.snapshot();
    assert.equal(snapshot.totalMessages, 227);
    assert.equal(snapshot.messages.filter(visible).length, SESSION_RECENT_VISIBLE_MESSAGES);
    assert.equal(snapshot.messages.length, SESSION_RECENT_VISIBLE_MESSAGES + 1);
    assert.equal(snapshot.messages.at(-2).content[0].data.length, 1024 * 1024);
    assert.ok(bytes(snapshot.messages) <= SESSION_RECENT_MAX_BYTES);
    assertBoundary(snapshot, entries);
    assert.deepEqual(ids(recoverHistory(host, snapshot)), entries.map(entry => entry.id));
  } finally { await host.dispose(); }
});

test('recent page counts user and assistant messages rather than tool/custom records', async () => {
  const messages = Array.from({ length: 70 }, (_, index) => [
    { role: 'user', content: `question ${index}` },
    { role: 'assistant', content: [{ type: 'toolCall', id: `tool-${index}`, name: 'read', arguments: {} }] },
    { role: 'toolResult', toolCallId: `tool-${index}`, toolName: 'read', content: [{ type: 'text', text: 'read complete' }] },
    { role: 'custom', content: [{ type: 'text', text: 'hidden extension context' }] },
    { role: 'assistant', content: [{ type: 'text', text: `answer ${index}` }] },
  ]).flat();
  const entries = entriesFor(messages);
  const host = createHost(entries);
  try {
    const snapshot = host.snapshot();
    assert.equal(snapshot.messages.filter(visible).length, SESSION_RECENT_VISIBLE_MESSAGES);
    assert.ok(snapshot.messages.length > SESSION_HISTORY_MAX_MESSAGES);
    assert.deepEqual(ids(snapshot.messages.filter(visible)),
      entries.filter(entry => visible(entry.message)).slice(-SESSION_RECENT_VISIBLE_MESSAGES).map(entry => entry.id));
    assertBoundary(snapshot, entries);
    assert.deepEqual(ids(recoverHistory(host, snapshot)), entries.map(entry => entry.id));
  } finally { await host.dispose(); }
});

test('the 4 MiB recent batch budget falls back to complete small history pages', async () => {
  const entries = entriesFor(textMessages(80, 100 * 1024));
  const host = createHost(entries);
  try {
    const snapshot = host.snapshot();
    assert.ok(snapshot.messages.length > 1);
    assert.ok(snapshot.messages.filter(visible).length < SESSION_RECENT_VISIBLE_MESSAGES);
    assert.ok(bytes(snapshot.messages) <= SESSION_RECENT_MAX_BYTES);
    assertBoundary(snapshot, entries);
    const restored = recoverHistory(host, snapshot);
    assert.deepEqual(ids(restored), entries.map(entry => entry.id));
    assert.deepEqual(restored.map(message => message.content), entries.map(entry => entry.message.content));
  } finally { await host.dispose(); }
});

test('the 400-record recent cap still allows every tool-heavy history entry to be recovered', async () => {
  const entries = entriesFor([
    ...textMessages(20),
    ...Array.from({ length: 450 }, (_, index) => ({ role: 'toolResult', toolCallId: `tool-${index}`,
      content: [{ type: 'text', text: `output ${index}` }] })),
  ]);
  const host = createHost(entries);
  try {
    const snapshot = host.snapshot();
    assert.equal(snapshot.messages.length, SESSION_RECENT_MAX_MESSAGES);
    assert.equal(snapshot.messages.filter(visible).length, 0);
    assertBoundary(snapshot, entries);
    assert.deepEqual(ids(recoverHistory(host, snapshot)), entries.map(entry => entry.id));
  } finally { await host.dispose(); }
});

test('a single message larger than the recent batch budget is preserved and advances pagination', async () => {
  const entries = entriesFor([
    ...textMessages(4),
    { role: 'toolResult', content: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(SESSION_RECENT_MAX_BYTES + 1024) }] },
  ]);
  const host = createHost(entries);
  try {
    const snapshot = host.snapshot();
    assert.equal(snapshot.messages.length, 1);
    assert.ok(bytes(snapshot.messages) > SESSION_RECENT_MAX_BYTES);
    assert.equal(snapshot.messages[0].content[0].data.length, SESSION_RECENT_MAX_BYTES + 1024);
    assertBoundary(snapshot, entries);
    assert.deepEqual(ids(recoverHistory(host, snapshot)), entries.map(entry => entry.id));
    const singleOversizeHistory = historyPage(host, entries.length);
    assert.equal(singleOversizeHistory.messages.length, 1);
    assert.equal(singleOversizeHistory.before, entries.length - 1);
    assert.deepEqual(singleOversizeHistory.messages, snapshot.messages);
  } finally { await host.dispose(); }
});

test('compaction changes model context without deleting the durable visible transcript', async () => {
  const messages = textMessages(120);
  const entries = entriesFor(messages);
  entries.splice(100, 0, { type: 'compaction', id: 'compact-1', parentId: 'e99',
    timestamp: '2026-01-01T00:01:00.000Z', summary: 'summarized context only',
    firstKeptEntryId: 'e90', tokensBefore: 100000 });
  entries[101].parentId = 'compact-1';
  const modelContext = [{ role: 'user', content: 'summarized context only' }, ...messages.slice(100)];
  const host = createHost(entries, modelContext);
  try {
    const snapshot = host.snapshot();
    assert.equal(snapshot.totalMessages, messages.length);
    assert.equal(snapshot.messages.filter(visible).length, SESSION_RECENT_VISIBLE_MESSAGES);
    assert.equal(snapshot.messages[0]._entryId, 'e70');
    assertBoundary(snapshot, entries);
    const restored = recoverHistory(host, snapshot);
    assert.deepEqual(ids(restored), entries.filter(entry => entry.type === 'message').map(entry => entry.id));
    assert.deepEqual(restored[0].content, messages[0].content);
    assert.equal(restored.some(message => message.content === 'summarized context only'), false);
  } finally { await host.dispose(); }
});

test('raw startup preview also keeps fifty visible messages across a large tool image', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mewpii-recent-preview-'));
  const file = join(directory, 'large-image.jsonl');
  const messages = textMessages(90);
  messages[88] = { role: 'toolResult', content: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(1024 * 1024) }] };
  const entries = entriesFor(messages);
  await writeFile(file, [{ type: 'session', version: 3, id: 'recent-preview', cwd: directory,
    timestamp: '2026-01-01T00:00:00.000Z' }, ...entries].map(entry => JSON.stringify(entry)).join('\n') + '\n');
  try {
    const preview = await readRawSessionPreview(file, directory);
    assert.ok(preview);
    assert.equal(preview.snapshot.messages.filter(visible).length, SESSION_RECENT_VISIBLE_MESSAGES);
    assert.equal(preview.snapshot.messages.length, SESSION_RECENT_VISIBLE_MESSAGES + 1);
    assert.equal(preview.snapshot.messages.at(-2).content[0].data.length, 1024 * 1024);
    assert.ok(bytes(preview.snapshot.messages) <= SESSION_RECENT_MAX_BYTES);
    assert.deepEqual(ids(preview.snapshot.messages), entries.slice(-51).map(entry => entry.id));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
