/** A paused/completed task may share a living supervisor process. @author coolonion */
import assert from 'node:assert/strict';
import test from 'node:test';
import { subagentStateKey, subagentRunTerminal, subagentStatusView } from '../src/subagent-run-state.ts';

test('PID liveness never overrides paused, failed, completed, or attention states', () => {
  assert.equal(subagentStateKey('paused', 'needs_attention', true), 'subagentPaused');
  assert.equal(subagentStateKey('complete', undefined, true), 'subagentCompleted');
  assert.equal(subagentStateKey('failed', undefined, true), 'subagentFailed');
  assert.equal(subagentStateKey('running', 'needs_attention', true), 'subagentNeedsAttention');
  assert.equal(subagentStateKey('running', undefined, false), 'subagentInterrupted');
  assert.equal(subagentStateKey('running', undefined, true), 'running');
  assert.equal(subagentStateKey(undefined, undefined, true), 'subagentUnknown');
});

test('paused runs keep polling so resumption and detached completion can be observed', () => {
  assert.equal(subagentRunTerminal('paused'), false);
  assert.equal(subagentRunTerminal('running'), false);
  assert.equal(subagentRunTerminal('complete'), true);
  assert.equal(subagentRunTerminal('failed'), true);
});

const completedChildren = { effectiveState: 'failed', statusStale: false,
  steps: [{ effectiveState: 'completed' }, { effectiveState: 'completed' }],
  childSummary: { total: 2, completed: 2 }, workflow: { state: 'failed', issue: 'continuation' } };

test('completed children get a qualified completion label, never overall workflow success', () => {
  const view = subagentStatusView(completedChildren);
  assert.equal(view.label, 'subagentChildrenCompleted');
  assert.equal(view.warning, 'subagentContinuationRequired');
  assert.equal(view.reason, 'subagentContinuationFailure');
  assert.equal(completedChildren.effectiveState, 'failed');
});

test('partial, empty, stale and unavailable child states cannot be called completed', () => {
  for (const change of [
    { steps: [{ effectiveState: 'completed' }, { effectiveState: 'unknown' }] },
    { steps: [], childSummary: { total: 0, completed: 0 } },
    { childSummary: { total: 2, completed: 1 } },
    { effectiveState: 'unknown', statusStale: true },
    { effectiveState: 'running' },
  ]) assert.equal(subagentStatusView({ ...completedChildren, ...change }).childrenCompleted, false);
  assert.equal(subagentStatusView(completedChildren, true).label, 'subagentUnknown');
  assert.equal(subagentStatusView(completedChildren, true).reason, undefined);
});

test('old timeout and true failure stay distinguishable from child completion', () => {
  const record = { effectiveState: 'failed', statusStale: false, steps: [{ effectiveState: 'failed' }], childSummary: { total: 1, completed: 0 }, workflow: { state: 'failed', issue: 'timeout' } };
  assert.equal(subagentStatusView(record).label, 'subagentTimedOut');
  assert.equal(subagentStatusView({ ...record, workflow: { state: 'failed', issue: 'failed' } }).label, 'subagentFailed');
});

test('startup and reported unmet results are distinct from execution completion', () => {
  assert.equal(subagentStatusView({ effectiveState: 'failed', statusStale: false, steps: [], workflow: { issue: 'startup' } }).label, 'subagentStartupFailed');
  assert.equal(subagentStatusView({ ...completedChildren, outcome: 'reported-unmet' }).label, 'subagentOutcomeUnmet');
  assert.equal(subagentStatusView({ ...completedChildren, outcome: 'reported-unmet' }, true).label, 'subagentUnknown');
  assert.equal(subagentStatusView({ ...completedChildren, effectiveState: 'running', outcome: 'reported-unmet' }).label, 'running');
  assert.equal(subagentStateKey('stopping'), 'subagentStopping');
});
