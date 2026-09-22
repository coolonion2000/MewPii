/** Isolated artifact/API regressions, without rebuilding or touching the live server. @author coolonion */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, appendFile, rm, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSessionPreview, readSessionUsage, readTextTail } from '../src/subagent-run-details.ts';

function message(text, timestamp = 20000) {
  return JSON.stringify({ type: 'message', timestamp, message: {
    role: 'assistant', content: [{ type: 'text', text }], usage: { totalTokens: 10, cost: { total: 0.1 } },
  } }) + '\n';
}

test('read-only previews tolerate partial JSONL, bound large messages, and refresh usage after append', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mewpii-subagent-preview-'));
  try {
    const file = join(root, 'session.jsonl');
    await writeFile(file, message('working') + '{"incomplete":');
    const preview = await readSessionPreview(file);
    assert.equal(preview.messages[0].text, 'working');
    assert.equal(preview.updatedAt, 20000);
    assert.deepEqual(await readSessionUsage(file), { tokens: 10, cost: 0.1 });
    await appendFile(file, '1}\n' + message('x'.repeat(20000), 30000));
    assert.deepEqual(await readSessionUsage(file), { tokens: 20, cost: 0.2 });
    const next = await readSessionPreview(file);
    assert.equal(next.messages.at(-1).text.length, 8000);
    assert.equal(next.truncated, true);
    await writeFile(file, 'x'.repeat(300000) + '\n' + message('latest', 40000));
    assert.equal((await readSessionPreview(file)).messages.at(-1).text, 'latest');
    await writeFile(file, 'x'.repeat(300000));
    assert.equal((await readTextTail(file)).text, '');
    assert.equal((await readSessionPreview(join(root, 'missing'))).unavailable, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('run API exposes real child details and stale workflow state without controlling the child', { timeout: 20000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mewpii-subagent-api-')));
  const runDir = join(root, 'pi-subagents-test', 'async-subagent-runs', 'workflow-test');
  const home = join(root, 'home');
  await mkdir(runDir, { recursive: true });
  await mkdir(home);
  const session = join(root, 'child.jsonl');
  await writeFile(session, message('continued child output'));
  const statusFile = join(runDir, 'status.json');
  const recordedAt = Date.now();
  await writeFile(session, message('continued child output', recordedAt + 5000));
  const status = JSON.stringify({ state: 'paused', activityState: 'needs_attention', pid: process.pid, toolCallId: 'call-test', sessionId: 'parent-test',
    cwd: root, startedAt: recordedAt - 5000, lastUpdate: recordedAt, endedAt: recordedAt,
    steps: [{ label: 'implementation', agent: 'worker', status: 'paused', sessionFile: session, runId: 'child-id', lastActivityAt: recordedAt }],
  });
  await writeFile(statusFile, status);
  const repo = fileURLToPath(new URL('../..', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts', '--host', '127.0.0.1', '--port', '0'], {
    cwd: repo, env: { ...process.env, HOME: home, TMPDIR: root, PII_PASSWORD: '', PII_WORKSPACE_ROOTS: root },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  try {
    const deadline = Date.now() + 12000;
    let port;
    while (!(port = output.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)?.[1])) {
      if (Date.now() > deadline || child.exitCode !== null) throw Error(output);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const base = `http://127.0.0.1:${port}/api/subagent-run?runId=workflow-test`;
    const response = await fetch(`${base}&step=0`);
    assert.equal(response.status, 200);
    const detail = await response.json();
    assert.equal(detail.state, 'paused');
    assert.equal(detail.alive, true);
    assert.equal(detail.statusStale, true);
    assert.equal(detail.presentation.effectiveState, 'unknown');
    assert.equal(detail.presentation.steps[0].effectiveState, 'unknown');
    const list = await (await fetch(`http://127.0.0.1:${port}/api/subagent-runs?parent=parent-test`)).json();
    assert.deepEqual(list.runs[0].presentation, detail.presentation);
    assert.equal(list.runs[0].presentation.toolCallId, 'call-test');
    assert.equal((await fetch(`${base}&parent=another-parent`)).status, 404);
    assert.equal(detail.preview.messages[0].text, 'continued child output');
    assert.match(detail.log, /continued child output/);
    assert.equal(detail.steps[0].runId, 'child-id');
    assert.equal(detail.steps[0].tokens, undefined);
    const withUsage = await (await fetch(`${base}&usage=1`)).json();
    assert.equal(withUsage.steps[0].tokens, 10);
    assert.equal((await fetch(`${base}&step=99`)).status, 404);
    assert.equal((await fetch(`${base}&step=../../etc/passwd`)).status, 400);
    assert.equal(await readFile(statusFile, 'utf8'), status);
    assert.equal(await readFile(session, 'utf8'), message('continued child output', recordedAt + 5000));
    const completedDir = join(root, 'pi-subagents-test', 'async-subagent-runs', 'completed-children');
    await mkdir(completedDir);
    const completedStatus = JSON.stringify({ state: 'failed', sessionId: 'parent-test', startedAt: recordedAt, lastUpdate: recordedAt + 6000,
      error: 'unsupported-continuation: detached workflow child settled, but JavaScript workflow continuation was not persisted.',
      steps: [{ label: 'impl', status: 'completed', sessionFile: session }, { label: 'review', status: 'completed', sessionFile: session }] });
    await writeFile(join(completedDir, 'status.json'), completedStatus);
    const completed = await (await fetch(`http://127.0.0.1:${port}/api/subagent-run?runId=completed-children&parent=parent-test`)).json();
    assert.equal(completed.state, 'failed');
    assert.deepEqual(completed.presentation.childSummary, { total: 2, completed: 2 });
    assert.equal(completed.presentation.workflow.issue, 'continuation');
    assert.match(completed.presentation.workflow.error, /continuation was not persisted/);
    const completedList = await (await fetch(`http://127.0.0.1:${port}/api/subagent-runs?parent=parent-test`)).json();
    assert.deepEqual(completedList.runs.find(run => run.id === 'completed-children').presentation, completed.presentation);
    assert.equal(await readFile(join(completedDir, 'status.json'), 'utf8'), completedStatus);
  } finally {
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    await rm(root, { recursive: true, force: true });
  }
});
