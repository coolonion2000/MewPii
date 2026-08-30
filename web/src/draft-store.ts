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
