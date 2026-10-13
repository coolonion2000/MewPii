export type ToolResultBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType?: unknown }
  | { type: 'invalidImage' };

function isBlock(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Cheap default-open check; do not construct data URLs for collapsed cards. */
export function hasToolResultImage(content: unknown): boolean {
  return Array.isArray(content) && content.some(block => isBlock(block) && block.type === 'image');
}

/** Keep text/image ordering. An edit diff replaces text, never its image blocks. */
export function toolResultContent(content: unknown, diff?: unknown): ToolResultBlock[] {
  const source = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
  const blocks: ToolResultBlock[] = [];
  let remainingDiff = typeof diff === 'string' && diff ? diff : undefined;
  const hasDiff = Boolean(remainingDiff);
  for (const block of source) {
    if (!isBlock(block)) continue;
    if (block.type === 'text') {
      if (remainingDiff) {
        blocks.push({ type: 'text', text: remainingDiff });
        remainingDiff = undefined;
      } else if (!hasDiff && typeof block.text === 'string' && block.text) {
        blocks.push({ type: 'text', text: block.text });
      }
    } else if (block.type === 'image') {
      blocks.push(typeof block.data === 'string' && block.data.trim().length > 0
        ? { type: 'image', data: block.data, mimeType: block.mimeType }
        : { type: 'invalidImage' });
    }
  }
  if (remainingDiff) blocks.unshift({ type: 'text', text: remainingDiff });
  return blocks;
}
