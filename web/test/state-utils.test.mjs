/** Frontend runtime state regression tests. @author coolonion */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acceptsGeneration,
  appRoutePath,
  calculateLiveOutputMetrics,
  clearMatchingRequest,
  createGenerationGate,
  fixedAgentUrl,
  initialCwd,
  isTerminalRun,
  mergeHistoryMessages,
  mergeSnapshotMessages,
  parseAppRoute,
  parseStoredSelection,
  parseStoredStringArray,
  sessionIdFromPath,
  restoreFailedImages,
  restoreFailedText,
  shouldShowDisconnected,
} from '../src/state-utils.ts';
import { shouldPlayCompletionSound } from '../src/completion-sound.ts';
import { evaluateProviderLogout } from '../src/model-utils.ts';

const message = (id, text = id) => ({ role: 'user', content: text, _entryId: id });
const snapshot = (messages, overrides = {}) => ({
  sessionId: 'session-a',
  sessionFile: '/tmp/session-a.jsonl',
  branchHeadId: 'head-a',
  cwd: '/work',
  isStreaming: false,
  thinkingLevel: 'off',
  messages,
  totalMessages: messages.length,
  historyFrom: 0,
  queue: { steering: [], followUp: [] },
  queueCapabilities: { reorder: false, remove: false },
  tools: [],
  slashCommands: [],
  ...overrides,
});

test('deep-link routes and generation gate reject stale resolve results', () => {
  assert.deepEqual(parseAppRoute('/chat/12345678-ABCD/'), { view: 'chat', pendingSessionId: '12345678-abcd' });
  const sessionPath = '/tmp/2026-01-01_12345678-abcd-4abc-8abc-123456789abc.jsonl';
  assert.equal(sessionIdFromPath(sessionPath), '12345678-abcd-4abc-8abc-123456789abc');
  assert.equal(appRoutePath({
    view: 'chat',
    selection: { cwd: '/work', sessionPath, sessionId: '12345678-abcd-4abc-8abc-123456789abc' },
  }), '/chat/12345678-abcd-4abc-8abc-123456789abc');
  assert.deepEqual(
    parseStoredSelection(JSON.stringify({ cwd: '/work', sessionPath })),
    { cwd: '/work', sessionPath, sessionId: '12345678-abcd-4abc-8abc-123456789abc' },
  );
  assert.equal(acceptsGeneration(3, 2, false), false);
  assert.equal(acceptsGeneration(3, 3, true), false);
  assert.equal(acceptsGeneration(3, 3, false), true);
  assert.equal(initialCwd([], '/last/project'), '/last/project');
  const request = { id: 'request-a', title: 'keep' };
  assert.equal(clearMatchingRequest(request, 'request-b'), request);
  assert.equal(clearMatchingRequest(request, 'request-a'), undefined);
});

test('session switches do not flash a disconnected banner before the first snapshot', () => {
  assert.equal(shouldShowDisconnected(false, false, undefined), false);
  assert.equal(shouldShowDisconnected(false, true, 'connection closed'), false);
  assert.equal(shouldShowDisconnected(false, false, 'connection closed'), true);
  assert.equal(shouldShowDisconnected(true, false, 'stale error'), false);
});

test('completion sound only fires when a running reply settles away from the foreground', () => {
  assert.equal(shouldPlayCompletionSound(true, false, 'hidden', false), true);
  assert.equal(shouldPlayCompletionSound(true, false, 'visible', false), true);
  assert.equal(shouldPlayCompletionSound(true, false, 'visible', true), false);
  assert.equal(shouldPlayCompletionSound(false, false, 'hidden', false), false);
  assert.equal(shouldPlayCompletionSound(true, true, 'hidden', false), false);
});

test('live output metrics distinguish unknown reasoning from estimated visible output', () => {
  assert.deepEqual(calculateLiveOutputMetrics({
    visibleChars: 0,
    outputChars: 0,
    firstDeltaAt: undefined,
    deltaSamples: [],
    now: 10_000,
  }), {});
  assert.deepEqual(calculateLiveOutputMetrics({
    visibleChars: 350,
    outputChars: 350,
    firstDeltaAt: 9_000,
    deltaSamples: [{ t: 9_500, n: 350 }],
    now: 10_000,
  }), { tokens: 100, tps: 100 });
  assert.deepEqual(calculateLiveOutputMetrics({
    visibleChars: 350,
    outputChars: 350,
    firstDeltaAt: 9_000,
    deltaSamples: [{ t: 9_500, n: 350 }],
    now: 16_000,
  }), { tokens: 100, tps: 0 });
});

test('legacy sidebar storage ignores malformed and non-string values', () => {
  assert.deepEqual(parseStoredStringArray('["/a", 1, null, "/b"]'), ['/a', '/b']);
  assert.deepEqual(parseStoredStringArray('{bad json'), []);
  assert.deepEqual(parseStoredStringArray(null), []);
});

test('provider logout failures preserve server errors and never report success', () => {
  const notFound = evaluateProviderLogout('missing', 'Logout', false, 404, {
    ok: false,
    error: 'provider not found',
  });
  const unavailable = evaluateProviderLogout('remote', 'Logout', false, 502, {
    ok: false,
    error: 'credential remains configured',
  });
  assert.deepEqual(notFound, { ok: false, notice: 'provider not found' });
  assert.deepEqual(unavailable, { ok: false, notice: 'credential remains configured' });
  assert.doesNotMatch(notFound.notice, /✓/);
  assert.doesNotMatch(unavailable.notice, /✓/);
});

test('project refresh gate rejects an older response that resolves last', async () => {
  const gate = createGenerationGate();
  let state = { projects: ['initial'], archives: ['initial-archive'] };
  let resolveFirst;
  let resolveSecond;
  const firstResponse = new Promise((resolvePromise) => { resolveFirst = resolvePromise; });
  const secondResponse = new Promise((resolvePromise) => { resolveSecond = resolvePromise; });
  const commit = async (generation, response) => {
    const candidate = await response;
    if (gate.accepts(generation, false)) state = candidate;
  };
  const first = commit(gate.next(), firstResponse);
  const second = commit(gate.next(), secondResponse);
  resolveSecond({ projects: ['new'], archives: ['new-archive'] });
  await second;
  resolveFirst({ projects: ['stale'], archives: ['stale-archive'] });
  await first;
  assert.deepEqual(state, { projects: ['new'], archives: ['new-archive'] });
});

test('failed submission restores payload without overwriting a newer draft or image', () => {
  assert.equal(restoreFailedText('new draft', 'failed prompt'), 'new draft');
  assert.equal(restoreFailedText('', 'failed prompt'), 'failed prompt');
  const sent = { data: 'old', mimeType: 'image/png', name: 'old.png' };
  const newer = { data: 'new', mimeType: 'image/png', name: 'new.png' };
  assert.deepEqual(restoreFailedImages([newer], [sent]), [sent, newer]);
  assert.deepEqual(restoreFailedImages([sent], [sent]), [sent]);
});

test('history and overlapping snapshots merge by entryId without duplicates', () => {
  const current = [message('b'), message('c')];
  assert.deepEqual(mergeHistoryMessages(current, [message('a'), message('b')]).map((item) => item._entryId), ['a', 'b', 'c']);
  const merged = mergeSnapshotMessages(
    [message('a'), message('b'), message('c')],
    'session-a',
    snapshot([message('c', 'updated'), message('d')], { historyFrom: 2, totalMessages: 4 }),
  );
  assert.deepEqual(merged.messages.map((item) => item._entryId), ['a', 'b', 'c', 'd']);
  assert.equal(merged.historyFrom, 0);
  const other = mergeSnapshotMessages(merged.messages, 'session-a', snapshot([message('x')], { sessionId: 'session-b' }));
  assert.deepEqual(other.messages.map((item) => item._entryId), ['x']);
});

test('agent URL is fixed and terminal run detection is explicit', () => {
  assert.equal(fixedAgentUrl('/api/file?path=x', 'mac mini'), '/api/file?path=x&agent=mac%20mini');
  assert.equal(fixedAgentUrl('/api/file?agent=one', 'two'), '/api/file?agent=one');
  assert.equal(fixedAgentUrl('/api/file', undefined), '/api/file');
  assert.equal(isTerminalRun('completed', false), true);
  assert.equal(isTerminalRun('running', false), false);
  assert.equal(isTerminalRun('failed', true), false);
});
