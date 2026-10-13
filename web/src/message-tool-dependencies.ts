/** Finalized content arrays are immutable; release their memo along with the transcript. */
const cachedIds = new WeakMap<object, readonly string[]>();
const noIds: readonly string[] = [];

/** Tool-map updates should compare dependencies, not repeatedly parse old messages. */
export function messageToolCallIds(message: Readonly<Record<string, unknown>>): readonly string[] {
  const content = message.content;
  if (!Array.isArray(content)) return noIds;
  const cached = cachedIds.get(content);
  if (cached) return cached;
  const ids: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && !Array.isArray(block) &&
        block.type === 'toolCall' && typeof block.id === 'string' && block.id) {
      ids.push(block.id);
    }
  }
  cachedIds.set(content, ids);
  return ids;
}
