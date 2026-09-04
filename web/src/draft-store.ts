/** In-memory per-conversation composer drafts. Cleared on page refresh. @author coolonion */

export interface ComposerDraftImage {
  data: string;
  mimeType: string;
  name: string;
}

export interface ComposerDraft {
  text: string;
  images: ComposerDraftImage[];
}

const MAX_DRAFTS = 20;
const drafts = new Map<string, ComposerDraft>();

export function conversationDraftKey(
  agent: string | undefined,
  cwd: string,
  sessionPath: string | undefined,
): string {
  return `${agent ?? "local"}\u0000${cwd}\u0000${sessionPath ?? "new"}`;
}

export function getComposerDraft(key: string): ComposerDraft | undefined {
  const draft = drafts.get(key);
  if (!draft) return undefined;
  return { text: draft.text, images: draft.images.map((image) => ({ ...image })) };
}

export function setComposerDraft(key: string, draft: ComposerDraft): void {
  if (!draft.text && draft.images.length === 0) {
    drafts.delete(key);
    return;
  }
  drafts.delete(key);
  drafts.set(key, {
    text: draft.text,
    images: draft.images.map((image) => ({ ...image })),
  });
  while (drafts.size > MAX_DRAFTS) {
    const oldest = drafts.keys().next().value as string | undefined;
    if (!oldest) break;
    drafts.delete(oldest);
  }
}

export function clearComposerDraft(key: string): void {
  drafts.delete(key);
}

/**
 * Restore a submission that never reached the server (for example, when its
 * cold conversation is disposed during a session switch). Read current state
 * at commit time so a late failure cannot replace text typed after switching
 * back to the conversation.
 */
export function restoreFailedComposerDraft(
  key: string,
  submitted: ComposerDraft,
): ComposerDraft {
  const current = getComposerDraft(key);
  const seen = new Set<string>();
  const restored = {
    text: current?.text ? current.text : submitted.text,
    images: [...submitted.images, ...(current?.images ?? [])].filter((image) => {
      const imageKey = `${image.mimeType}:${image.data}`;
      if (seen.has(imageKey)) return false;
      seen.add(imageKey);
      return true;
    }),
  };
  setComposerDraft(key, restored);
  return restored;
}
