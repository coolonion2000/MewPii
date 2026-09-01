/** Conversation startup readiness regression tests. @author coolonion */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ReadinessWaiters } from '../src/readiness-waiters.ts';

test('a submission waiting during startup resumes after readiness', async () => {
  const waiters = new ReadinessWaiters();
  let settled = false;
  const ready = waiters.wait(1_000).then(() => {
    settled = true;
  });

  await Promise.resolve();
  assert.equal(settled, false);
  waiters.resolveAll();
  await ready;
  assert.equal(settled, true);
});

test('disposing a conversation rejects submissions waiting for startup', async () => {
  const waiters = new ReadinessWaiters();
  const ready = waiters.wait(1_000);
  waiters.rejectAll(new Error('conversation disposed'));
  await assert.rejects(ready, /conversation disposed/);
});
