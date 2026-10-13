/** Current-work canonical title regressions. @author coolonion */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addUsedSession,
  getUsedSessions,
  removeUsedSession,
  resolveUsedSessionTitle,
  currentWorkEntry,
  parseCurrentWork,
} from '../src/used-sessions.ts';

const used = {
  cwd: '/work',
  sessionPath: '/sessions/one.jsonl',
  sessionId: 'session-one',
  title: 'first user message from the latest page',
  at: 1,
};

function project(summary) {
  return [{ cwd: '/work', sessions: [{
    path: '/sessions/one.jsonl',
    id: 'session-one',
    cwd: '/work',
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    messageCount: 500,
    running: false,
    ...summary,
  }] }];
}

test('current work uses the same canonical title as the workspace list', () => {
  assert.equal(
    resolveUsedSessionTitle(used, project({
      firstMessage: 'true first user message',
    })),
    'true first user message',
  );
  assert.equal(
    resolveUsedSessionTitle(used, project({
      name: 'manually renamed session',
      firstMessage: 'true first user message',
    })),
    'manually renamed session',
  );
});

test('current work keeps its local fallback until the workspace entry exists', () => {
  assert.equal(resolveUsedSessionTitle(used, []), used.title);
  assert.equal(
    resolveUsedSessionTitle({ ...used, sessionPath: undefined }, project({
      firstMessage: 'workspace title',
    })),
    used.title,
  );
});

test('selection promotes a session immediately and path assignment reconciles its identity', () => {
  const provisional = {
    agent: 'agent-a', cwd: '/project-promotion', sessionId: 'promotion-1',
    title: 'New session',
  };
  addUsedSession(provisional);
  assert.equal(getUsedSessions()[0].sessionId, 'promotion-1');
  addUsedSession({ ...provisional, sessionPath: '/sessions/promotion-1.jsonl', title: 'Real title' });
  assert.equal(getUsedSessions().filter(s => s.sessionId === 'promotion-1').length, 1);
  assert.equal(getUsedSessions()[0].sessionPath, '/sessions/promotion-1.jsonl');
  assert.equal(getUsedSessions()[0].title, 'Real title');
});

test('closing current work removes only the matching agent shortcut', () => {
  const local = { cwd: '/project-close', sessionId: 'close-1', title: 'Local' };
  const remote = { ...local, agent: 'agent-b', title: 'Remote' };
  addUsedSession(local);
  addUsedSession(remote);
  removeUsedSession({ ...local, at: 0 });
  assert.equal(getUsedSessions().some(s => s.cwd === local.cwd && !s.agent), false);
  assert.equal(getUsedSessions().some(s => s.cwd === remote.cwd && s.agent === 'agent-b'), true);
  addUsedSession({ ...local, title: 'Background update' });
  assert.equal(getUsedSessions().some(s => s.cwd === local.cwd && !s.agent), false);
  addUsedSession(local, { reopen: true });
  assert.equal(getUsedSessions()[0].title, 'Local');
});

test('blank projects do not create ambiguous current-work entries', () => {
  const length = getUsedSessions().length;
  addUsedSession({ cwd: '/project-blank', title: 'Blank' });
  assert.equal(getUsedSessions().length, length);
});

test('new session appears before first user message and custom messages do not block its title', () => {
  const input = { cwd: '/new-regression', messages: [{role: 'custom', content: 'plugin initialized'}] };
  assert.equal(currentWorkEntry(input), undefined);
  input.sessionId = 'new-regression';
  addUsedSession(currentWorkEntry(input));
  assert.equal(getUsedSessions()[0].title, '(新会话)');
  input.messages.push({role: 'user', content: [{type: 'text', text: 'First real request'}]});
  addUsedSession(currentWorkEntry(input));
  assert.equal(getUsedSessions()[0].title, 'First real request');
  input.sessionPath = '/sessions/new-regression.jsonl';
  addUsedSession(currentWorkEntry(input));
  addUsedSession(currentWorkEntry({...input, sessionPath: undefined, messages: []}));
  const rows = getUsedSessions().filter(s => s.sessionId === input.sessionId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sessionPath, input.sessionPath);
  assert.equal(rows[0].title, 'First real request');
});

test('current work persists shortcuts and dismissals with safe malformed-storage fallback', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const storage = new Map();
  Object.defineProperty(globalThis, 'sessionStorage', {configurable: true, value: {
    setItem: (key, value) => storage.set(key, value),
    getItem: key => storage.get(key) ?? null,
  }});
  try {
    const entry = {cwd: '/persist', sessionId: 'persist', title: 'Persist'};
    addUsedSession(entry);
    assert.equal(parseCurrentWork(storage.get('mewpii.current-work.v1')).used[0].sessionId, 'persist');
    removeUsedSession({...entry, at: 1});
    const restored = parseCurrentWork(storage.get('mewpii.current-work.v1'));
    assert.equal(restored.used.some(s => s.sessionId === 'persist'), false);
    assert.equal(restored.dismissed[0].sessionId, 'persist');
    for (const value of [null, 'null', '{broken', '[]']) {
      assert.deepEqual(parseCurrentWork(value), {used: [], dismissed: []});
    }
    assert.equal(parseCurrentWork(JSON.stringify({used: [null, {}, {...entry, at: 1}]})).used.length, 1);
    assert.equal(parseCurrentWork(JSON.stringify({used: Array(25).fill({...entry, at: 1})})).used.length, 20);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous);
    else delete globalThis.sessionStorage;
  }
});
