import assert from 'node:assert/strict';
import test from 'node:test';
import { transcriptStart } from '../src/transcript-window.ts';
test('long histories start at their recent tail, without deleting loaded messages', () => {
  const keys = Array.from({ length: 2000 }, (_, i) => String(i));
  assert.equal(transcriptStart(keys, undefined), 1880);
  assert.equal(transcriptStart(keys, keys[1760]), 1760);
  assert.equal(transcriptStart(keys, null), 0);
  assert.equal(keys.length, 2000);
});
test('streaming appends retain the reading anchor, while replacement histories return to their tail', () => {
  const keys = Array.from({ length: 300 }, (_, i) => String(i));
  assert.equal(transcriptStart([...keys, '300'], '180'), 180);
  assert.equal(transcriptStart(['older', ...keys], '180'), 181);
  assert.equal(transcriptStart(keys, 'missing'), 180);
  assert.equal(transcriptStart([], undefined), 0);
  assert.equal(transcriptStart(['first'], undefined), 0);
});
