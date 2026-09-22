/** Read-only state reconciliation regression cases. @author coolonion */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectState, presentRun, reportsUnmetCriteria } from '../src/subagent-presentation.ts';

test('newer transcript invalidates historical pause; shared PID is not execution proof', () => {
  const record = { state: 'paused', lastUpdate: 10000, pid: process.pid };
  assert.equal(projectState(record, 20000).effectiveState, 'unknown');
  assert.equal(projectState(record, 20000, { isStreaming: true }).effectiveState, 'running');
  assert.equal(projectState(record, 20000, { isStreaming: false }).effectiveState, 'unknown');
  assert.equal(projectState({ state: 'running' }, undefined, { isStreaming: false }).effectiveState, 'unknown');
  assert.equal(projectState({ ...record, activityState: 'needs_attention' }, 9000).effectiveState, 'needs_attention');
  assert.equal(projectState({ state: 'completed', lastUpdate: 20000 }, 19000).effectiveState, 'completed');
  assert.equal(projectState({ state: 'completed', lastUpdate: 10000 }, 20000).effectiveState, 'unknown');
});

test('native child lifecycle overrides a stale workflow without crossing session identities', async () => {
  const record = { runId: 'w', sessionId: '/parent', state: 'paused', lastUpdate: 10000,
    steps: [{ runId: 'child', status: 'paused', label: 'implement' }] };
  const child = { sessionId: '/parent', runId: 'child', index: 0, state: 'running', updatedAt: 20000, observedAt: Date.now(), live: true, currentTool: 'read' };
  const running = await presentRun(record, '/unused/w', [], [child]);
  assert.equal(running.effectiveState, 'running');
  assert.equal(running.statusStale, false);
  assert.equal(running.steps[0].currentTool, 'read');
  assert.equal((await presentRun(record, '/unused/w', [], [{ ...child, state: 'needs_attention' }])).effectiveState, 'needs_attention');
  assert.equal((await presentRun(record, '/unused/w', [], [{ ...child, sessionId: '/foreign' }])).effectiveState, 'paused');
  const stopped = await presentRun(record, '/unused/w', [], [{ ...child, live: false, state: 'stopped' }]);
  assert.equal(stopped.steps[0].effectiveState, 'stopped');
  assert.notEqual(stopped.effectiveState, 'running');
  const stopping = await presentRun(record, '/unused/w', [], [child, { ...child, runId: 'w', index: -1, state: 'stopping' }]);
  assert.equal(stopping.effectiveState, 'stopping');
});

test('only explicit latest acceptance report flags unmet criteria; tool output and prose cannot', async () => {
  const report = '```acceptance-report\n{"criteriaSatisfied":[{"id":"x","status":"not-satisfied"}]}\n```';
  assert.equal(reportsUnmetCriteria(report), true);
  assert.equal(reportsUnmetCriteria('failed blocker not-satisfied'), false);
  assert.equal(reportsUnmetCriteria(report + '\n' + report), false);
  assert.equal(reportsUnmetCriteria('```acceptance-report\ninvalid\n```'), false);
  const root = await mkdtemp(join(tmpdir(), 'mewpii-outcome-'));
  try {
    const sessionFile = join(root, 'child.jsonl');
    const record = { state: 'complete', lastUpdate: 30000, steps: [{ status: 'completed', sessionFile }] };
    for (const role of ['assistant', 'toolResult']) {
      await writeFile(sessionFile, JSON.stringify({ type: 'message', timestamp: 20000, message: { role, content: report } }) + '\n');
      const view = await presentRun(record, join(root, 'w'), []);
      assert.equal(view.outcome, role === 'assistant' ? 'reported-unmet' : undefined);
    }
    await writeFile(sessionFile, [
      { type: 'message', timestamp: 19000, message: { role: 'assistant', content: report } },
      { type: 'message', timestamp: 20000, message: { role: 'assistant', content: 'New result' } },
    ].map(JSON.stringify).join('\n'));
    assert.equal((await presentRun(record, join(root, 'w'), [])).outcome, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('launch failure is not model failure', async () => {
  assert.equal((await presentRun({ state: 'failed', error: "Error: Run 'worker' failed: spawn pi ENOENT" }, '/unused/w', [])).workflow.issue, 'startup');
});

test('completed children and failed continuation are independent outcomes, without rewriting records', async () => {
  const record = { state: 'failed', error: 'unsupported-continuation: detached workflow child settled, but JavaScript workflow continuation was not persisted.',
    startedAt: 1000, lastUpdate: 30000, steps: [{ label: 'impl', status: 'completed' }, { label: 'review', status: 'completed' }] };
  const original = structuredClone(record);
  const result = await presentRun(record, '/unused/workflow', []);
  assert.equal(result.effectiveState, 'failed');
  assert.deepEqual(result.childSummary, { total: 2, completed: 2 });
  assert.equal(result.workflow.issue, 'continuation');
  assert.equal(result.workflow.error, record.error);
  assert.equal(result.workflow.startedAt, 1000);
  assert.deepEqual(record, original);
  const partial = await presentRun({ ...record, steps: [{ status: 'completed' }, { status: 'failed' }] }, '/unused/workflow', []);
  assert.deepEqual(partial.childSummary, { total: 2, completed: 1 });
  assert.equal((await presentRun({ ...record, steps: [] }, '/unused/workflow', [])).childSummary.completed, 0);
});

test('timeout classification uses runner diagnostics, not arbitrary output wording', async () => {
  const timeout = await presentRun({ state: 'failed', error: 'Subagent timed out after 1799248ms.', steps: [{ status: 'failed' }] }, '/unused/workflow', []);
  assert.equal(timeout.workflow.issue, 'timeout');
  assert.equal(timeout.childSummary.completed, 0);
  assert.equal((await presentRun({ state: 'failed', error: 'Validation failed: expected timeout flag' }, '/unused/workflow', [])).workflow.issue, 'failed');
  assert.equal((await presentRun({ state: 'complete', error: 'unsupported-continuation: old diagnostic' }, '/unused/workflow', [])).workflow.issue, undefined);
});

test('newer matching native child state is used; child completion does not complete workflow', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mewpii-presentation-'));
  try {
    await mkdir(join(root, 'child'));
    const session = join(root, 'child.jsonl');
    await writeFile(session, JSON.stringify({ type: 'message', timestamp: 20000, message: { role: 'assistant', content: 'continued' } }) + '\n');
    const record = { state: 'paused', lastUpdate: 10000, steps: [{ label: 'implement', runId: 'child', sessionFile: session, status: 'paused' }] };
    assert.equal((await presentRun(record, join(root, 'parent'), [])).effectiveState, 'unknown');
    const completedParent = await presentRun({ ...record, state: 'failed', lastUpdate: 30000,
      steps: [{ ...record.steps[0], lastActivityAt: 25000, activityState: 'needs_attention' }] }, join(root, 'parent'), []);
    assert.equal(completedParent.steps[0].stateSource, 'record');
    assert.equal(completedParent.effectiveState, 'failed');
    await writeFile(join(root, 'child', 'status.json'), JSON.stringify({ runId: 'child', sessionFile: session, state: 'running', lastUpdate: 21000 }));
    const running = await presentRun(record, join(root, 'parent'), []);
    assert.equal(running.effectiveState, 'running');
    assert.equal(running.steps[0].stateSource, 'native');
    await writeFile(join(root, 'child', 'status.json'), JSON.stringify({ runId: 'child', sessionFile: session, state: 'completed', lastUpdate: 22000 }));
    const finishedChild = await presentRun(record, join(root, 'parent'), []);
    assert.equal(finishedChild.steps[0].effectiveState, 'completed');
    assert.equal(finishedChild.effectiveState, 'unknown');
    await writeFile(join(root, 'child', 'status.json'), JSON.stringify({ runId: 'child', sessionFile: '/wrong/session', state: 'running', lastUpdate: 21000 }));
    assert.equal((await presentRun(record, join(root, 'parent'), [])).effectiveState, 'unknown');
    assert.equal((await presentRun(record, join(root, 'parent'), [{ sessionFile: session, isStreaming: true }])).effectiveState, 'running');
  } finally { await rm(root, { recursive: true, force: true }); }
});
