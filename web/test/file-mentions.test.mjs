import test from 'node:test';
import assert from 'node:assert/strict';
import { mentionQuery, mentionMessage, parseMentionMessage, mergeMentions } from '../src/file-mentions.ts';
import { setComposerDraft, getComposerDraft, restoreFailedComposerDraft } from '../src/draft-store.ts';
test('mentions use the caret, support Chinese/path queries, and do not match email addresses', () => {
  assert.deepEqual(mentionQuery('看下 @src/comp 后面', 12), { start: 3, end: 12, query: 'src/comp' });
  assert.equal(mentionQuery('a@example.com', 13), undefined);
  assert.equal(mentionQuery('https://x/@test', 15), undefined);
  assert.equal(mentionQuery('@中文', 3).query, '中文');
  assert.equal(mentionQuery('@', 1).query, '');
});
test('references round trip safely and ordinary/malformed messages are left untouched', () => {
  const refs = [{ path: '/work/中文 "file".md', isDir: false }, { path: '/work/src', isDir: true }];
  assert.deepEqual(parseMentionMessage(mentionMessage('看看', refs)), { text: '看看', mentions: refs });
  assert.deepEqual(parseMentionMessage(mentionMessage('', refs).trim()), { text: '', mentions: refs });
  assert.deepEqual(mergeMentions(refs, refs), refs);
  assert.equal(mentionMessage('@ordinary', []), '@ordinary');
  const malformed = 'text\n\n<workspace-references>\n[{"path":"javascript:bad","isDir":false}]\n</workspace-references>';
  assert.equal(parseMentionMessage(malformed).text, malformed);
});
test('reference-only drafts survive switches and failed submission merges references without duplication', () => {
  const refs = [{ path: '/work/a', isDir: false }];
  setComposerDraft('mention-draft', { text: '', images: [], mentions: refs });
  assert.deepEqual(getComposerDraft('mention-draft').mentions, refs);
  const copy = getComposerDraft('mention-draft'); copy.mentions[0].path = 'mutated';
  assert.equal(getComposerDraft('mention-draft').mentions[0].path, '/work/a');
  restoreFailedComposerDraft('mention-draft', { text: 'failed', images: [], mentions: [...refs, { path: '/work/b', isDir: true }] });
  assert.equal(getComposerDraft('mention-draft').mentions.length, 2);
});
