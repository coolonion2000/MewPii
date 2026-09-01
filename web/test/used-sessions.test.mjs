/** Current-work canonical title regressions. @author coolonion */
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveUsedSessionTitle } from '../src/used-sessions.ts';

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
