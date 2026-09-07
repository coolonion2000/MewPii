/** Session ancestry and activity ordering regressions. @author coolonion */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSessionTree } from '../src/session-tree.ts';

function session(id, modified, parentSessionPath, name = id) {
  return {
    path: id, id, cwd: '/work', name, parentSessionPath,
    created: '2026-01-01T00:00:00Z',
    modified: `2026-01-01T00:00:${String(modified).padStart(2, '0')}Z`,
    messageCount: 1, firstMessage: '', running: false,
  };
}

test('ordinary forks and renamed subagents retain their recorded ancestry', () => {
  const sessions = [
    session('logs', 4, 'release', '上线日志'),
    session('release', 3, 'docs', '上线'),
    session('docs', 2, 'root', '文档'),
    session('root', 1),
    session('worker', 5, 'root', 'subagent-reviewer'),
  ];
  const shape = (nodes) => nodes.map(({ session, children }) => [session.id, shape(children)]);
  const before = shape(buildSessionTree(sessions));
  assert.deepEqual(before, [['root', [
    ['worker', []], ['docs', [['release', [['logs', []]]]]],
  ]]]);
  sessions[4].name = '代码审查';
  assert.deepEqual(shape(buildSessionTree(sessions)), before);
});

test('recent descendant activity orders both roots and sibling subtrees without mutating input', () => {
  const sessions = [
    session('other', 8), session('root', 1),
    session('older-child', 2, 'root'), session('newer-child', 7, 'root'),
    session('grandchild', 9, 'older-child'),
  ];
  const original = structuredClone(sessions);
  const roots = buildSessionTree(sessions);
  assert.deepEqual(roots.map((node) => node.session.id), ['root', 'other']);
  assert.deepEqual(roots[0].children.map((node) => node.session.id), ['older-child', 'newer-child']);
  assert.equal(roots[0].latestActivity, Date.parse(sessions[4].modified));
  assert.deepEqual(sessions, original);
});

test('a missing parent leaves the session and its descendants accessible', () => {
  const roots = buildSessionTree([
    session('child', 2, 'missing'), session('grandchild', 3, 'child'),
  ]);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].session.id, 'child');
  assert.equal(roots[0].children[0].session.id, 'grandchild');
  assert.deepEqual(buildSessionTree([]), []);
});
