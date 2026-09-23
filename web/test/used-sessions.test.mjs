/** Current-work canonical title regressions. @author coolonion */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addUsedSession,
  getUsedSessions,
  removeUsedSession,
  resolveUsedSessionTitle,
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
