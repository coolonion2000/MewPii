import test from 'node:test';
import assert from 'node:assert/strict';
import { watchServiceHealth } from '../src/service-health.ts';

test('health timeout reports unknown state and successful probe recovers', async () => {
  let calls = 0;
  let done;
  const finished = new Promise(resolve => { done = resolve; });
  const states = [];
  const dispose = watchServiceHealth(async signal => {
    if (++calls === 1) await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('timeout')), {once: true}));
  }, state => { states.push(state); if (!state) done(); }, 5, 5);
  try {
    await finished;
    assert.deepEqual(states, [true, false]);
  } finally { dispose(); }
});

test('disposing aborts pending probe without publishing stale status', async () => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let signal;
  const states = [];
  const dispose = watchServiceHealth(async s => {
    signal = s; entered();
    await new Promise((resolve, reject) => s.addEventListener('abort', () => reject(Error('closed')), {once: true}));
  }, s => states.push(s), 1, 1000);
  await started; dispose();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(signal.aborted, true);
  assert.deepEqual(states, []);
});
