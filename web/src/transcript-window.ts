export const TRANSCRIPT_PAGE_SIZE = 120;
/** Keep a stable first-visible message while streaming appends new messages. null means all loaded history. */
export function transcriptStart(keys: readonly string[], anchor: string | null | undefined): number {
  if (anchor === null) return 0;
  const index = anchor === undefined ? -1 : keys.indexOf(anchor);
  return index >= 0 ? index : Math.max(0, keys.length - TRANSCRIPT_PAGE_SIZE);
}
