/** @author coolonion */
import test from 'node:test';
import assert from 'node:assert/strict';
import { updateCompactionState } from '../src/compaction-state.ts';

test('compaction start/end retain reason, clocks and estimated usage for snapshots', () => {
  const running = updateCompactionState(undefined, { type: 'compaction_start', reason: 'overflow' }, 100);
  assert.deepEqual(running, { status: 'running', reason: 'overflow', startedAt: 100 });
  const done = updateCompactionState(running, { type: 'compaction_end', result: { tokensBefore: 900000, estimatedTokensAfter: 80000 }, willRetry: true }, 200);
  assert.equal(done.status, 'completed');
  assert.equal(done.startedAt, 100);
  assert.equal(done.endedAt, 200);
  assert.equal(done.tokensBefore, 900000);
  assert.equal(done.estimatedTokensAfter, 80000);
  assert.equal(updateCompactionState(done, { type: 'agent_settled' }), done);
});
test('cancelled, failed and missing results cannot be labelled completed', () => {
  assert.equal(updateCompactionState(undefined, { type: 'compaction_end', aborted: true }).status, 'cancelled');
  assert.equal(updateCompactionState(undefined, { type: 'compaction_end', errorMessage: 'failed' }).status, 'failed');
  assert.equal(updateCompactionState(undefined, { type: 'compaction_end' }).status, 'failed');
});
