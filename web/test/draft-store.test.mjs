/** In-memory conversation draft regression tests. @author coolonion */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearComposerDraft,
  conversationDraftKey,
  getComposerDraft,
  restoreFailedComposerDraft,
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

test('dispose before dispatch restores only the original conversation draft', () => {
  const original = conversationDraftKey(undefined, '/work', '/sessions/cold.jsonl');
  const switched = conversationDraftKey(undefined, '/work', '/sessions/other.jsonl');
  clearComposerDraft(original);
  clearComposerDraft(switched);
  const submitted = {
    text: 'send after startup',
    images: [{ data: 'old', mimeType: 'image/png', name: 'old.png' }],
  };

  // Composer clears its draft before waitUntilReady; switching disposes that
  // waiter, so the recovery must write the original key rather than React state.
  setComposerDraft(switched, { text: 'other conversation', images: [] });
  restoreFailedComposerDraft(original, submitted);
  assert.deepEqual(getComposerDraft(original), submitted);
  assert.deepEqual(getComposerDraft(switched), {
    text: 'other conversation',
    images: [],
  });

  // A late rejection must not overwrite text entered after switching back.
  setComposerDraft(original, {
    text: 'newer text',
    images: [{ data: 'new', mimeType: 'image/png', name: 'new.png' }],
  });
  restoreFailedComposerDraft(original, submitted);
  assert.deepEqual(getComposerDraft(original), {
    text: 'newer text',
    images: [
      { data: 'old', mimeType: 'image/png', name: 'old.png' },
      { data: 'new', mimeType: 'image/png', name: 'new.png' },
    ],
  });
});
