/** In-memory conversation draft regression tests. @author coolonion */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearComposerDraft,
  conversationDraftKey,
  getComposerDraft,
  setComposerDraft,
} from '../src/draft-store.ts';

test('composer drafts survive session switches without leaking across conversations', () => {
  const first = conversationDraftKey(undefined, '/work', '/sessions/first.jsonl');
  const second = conversationDraftKey(undefined, '/work', '/sessions/second.jsonl');
  clearComposerDraft(first);
  clearComposerDraft(second);

  setComposerDraft(first, {
    text: 'unsent message',
    images: [{ data: 'base64', mimeType: 'image/png', name: 'draft.png' }],
  });

  assert.deepEqual(getComposerDraft(first), {
    text: 'unsent message',
    images: [{ data: 'base64', mimeType: 'image/png', name: 'draft.png' }],
  });
  assert.equal(getComposerDraft(second), undefined);

  const copy = getComposerDraft(first);
  copy.images[0].name = 'mutated.png';
  assert.equal(getComposerDraft(first).images[0].name, 'draft.png');

  setComposerDraft(first, { text: '', images: [] });
  assert.equal(getComposerDraft(first), undefined);
});
