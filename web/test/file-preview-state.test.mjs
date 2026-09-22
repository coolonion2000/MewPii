import test from 'node:test';
import assert from 'node:assert/strict';
import { filePreviewState } from '../src/file-preview-state.ts';

const call = { role: 'assistant', content: [{ type: 'toolCall', id: 'w1', name: 'write', arguments: { path: '/tmp/report.md' } }] };
const tool = { toolCallId: 'w1', toolName: 'write', args: { path: '/tmp/report.md' }, running: true };
test('streaming file call waits, completion and persisted result each refresh the exact preview', () => {
  const state = (tools, messages = [], streaming) => filePreviewState('/work', '/tmp/report.md', tools, messages, streaming);
  assert.equal(state(new Map(), [], call).pending, true);
  const running = state(new Map([['w1', tool]]), [call]);
  assert.equal(running.pending, true);
  const doneTools = new Map([['w1', { ...tool, running: false, endedAt: 10 }]]);
  const ended = state(doneTools, [call]);
  assert.equal(ended.pending, false);
  assert.notEqual(ended.revision, running.revision);
  const persisted = state(doneTools, [call, { role: 'toolResult', toolCallId: 'w1', isError: false }]);
  assert.notEqual(persisted.revision, ended.revision);
  assert.equal(state(new Map(), [call]).pending, false, 'unfinished historical call must not wait forever');
});
test('other tools do not refresh preview; failures settle without granting access', () => {
  const state = tools => filePreviewState('/work', '/tmp/report.md', tools, []);
  assert.deepEqual(state(new Map([['other', { ...tool, args: { path: '/tmp/other.md' } }]])), state(new Map()));
  assert.equal(state(new Map([['w1', { ...tool, running: false, isError: true }]])).pending, false);
  const relative = { ...tool, args: { file_path: './report.md' } };
  assert.equal(filePreviewState('/tmp', '/tmp/report.md', new Map([['w1', relative]]), []).pending, true);
  assert.equal(filePreviewState('/tmp', '/tmp/report.md', new Map(), [{ role: 'assistant', content: [{ type: 'text', text: '/tmp/report.md' }] }]).pending, false);
});
