export interface FileMention { path: string; isDir: boolean }
export interface MentionQuery { start: number; end: number; query: string }
export function mentionQuery(text: string, cursor: number): MentionQuery | undefined {
  const before = text.slice(0, cursor);
  const match = /(?:^|[\s（(])@([^\s@]*)$/.exec(before);
  if (!match || match[1].length > 200) return;
  return { start: cursor - match[1].length - 1, end: cursor, query: match[1] };
}
export function mergeMentions(...groups: (FileMention[] | undefined)[]): FileMention[] {
  const unique = new Map<string, FileMention>();
  for (const group of groups) for (const item of group ?? []) unique.set(item.path, { ...item });
  return [...unique.values()];
}
const marker = '\n\n<workspace-references>\n';
const suffix = '\n</workspace-references>';
export function mentionMessage(text: string, mentions: FileMention[]): string {
  return mentions.length ? `${text}${text ? marker : marker.slice(2)}${JSON.stringify(mentions.map(({ path, isDir }) => ({ path, isDir })))}${suffix}` : text;
}
export function parseMentionMessage(text: string): { text: string; mentions: FileMention[] } {
  const plain = { text, mentions: [] as FileMention[] };
  const standalone = text.startsWith(marker.slice(2));
  const start = standalone ? 0 : text.lastIndexOf(marker);
  if (start < 0 || !text.endsWith(suffix)) return plain;
  try {
    const value: unknown = JSON.parse(text.slice(start + marker.length - (standalone ? 2 : 0), -suffix.length));
    // Recovery may merge a failed batch with references selected during that send.
    if (!Array.isArray(value) || value.length > 128 || !value.every(item => item && typeof item.path === 'string' && item.path.startsWith('/') && !/[\x00-\x1f]/.test(item.path) && typeof item.isDir === 'boolean')) return plain;
    return { text: text.slice(0, start), mentions: value };
  } catch { return plain; }
}
