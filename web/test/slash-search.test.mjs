/** Slash suggestion matching and ranking regressions. @author coolonion */
import assert from 'node:assert/strict';
import test from 'node:test';
import { searchSlashCommands } from '../src/slash-search.ts';

const commands = [
  { cmd: '/review-loop', desc: 'Review' },
  { cmd: '/skill:lark-approval', desc: 'Approval' },
  { cmd: '/skill:lark-apps', desc: 'Apps' },
  { cmd: '/clone', desc: 'Clone' },
  { cmd: '/lark', desc: 'Direct command' },
  { cmd: '/skill:intervals-icu-workout', desc: 'Unrelated skill' },
];

test('bare skill names match without the skill: prefix and exact commands rank first', () => {
  assert.deepEqual(searchSlashCommands(commands, 'lark').map((item) => item.cmd), [
    '/lark', '/skill:lark-approval', '/skill:lark-apps',
  ]);
  assert.deepEqual(searchSlashCommands(commands.slice(0, 4), 'lark').map((item) => item.cmd), [
    '/skill:lark-approval', '/skill:lark-apps',
  ]);
});

test('full prefixes outrank fuzzy matches and selected items keep the full command', () => {
  assert.deepEqual(searchSlashCommands(commands, 'skill:lark').map((item) => item.cmd), [
    '/skill:lark-approval', '/skill:lark-apps',
  ]);
  assert.deepEqual(searchSlashCommands(commands, 'lrk').map((item) => item.cmd), [
    '/skill:lark-approval', '/skill:lark-apps', '/lark',
  ]);
});

test('empty queries retain discovery order and descriptions are not command matches', () => {
  assert.deepEqual(searchSlashCommands(commands, '').map((item) => item.cmd), commands.map((item) => item.cmd));
  assert.deepEqual(searchSlashCommands(commands, 'review').map((item) => item.cmd), ['/review-loop']);
  assert.deepEqual(searchSlashCommands(commands, 'does-not-exist'), []);
});
