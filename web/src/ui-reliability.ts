export interface SidebarResizeResult {
  collapsed: boolean;
  width: number;
}

export type SidebarDragPhase =
  | 'may-collapse'
  | 'collapsed'
  | 'may-expand'
  | 'expanded';

/** Keep resize math deterministic and reusable by pointer handlers and tests. */
export function clampResizeWidth(raw: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(raw)) return minimum;
  return Math.min(maximum, Math.max(minimum, raw));
}

/** Sidebar collapse/expand has hysteresis so a pointer cannot oscillate at one boundary. */
export function sidebarResizeStep(
  phase: SidebarDragPhase,
  rawWidth: number,
): SidebarResizeResult & { phase: SidebarDragPhase } {
  if (phase === 'may-collapse' && rawWidth < 110)
    return { phase: 'collapsed', collapsed: true, width: 46 };
  if (phase === 'collapsed')
    return { phase, collapsed: true, width: 46 };
  if (phase === 'may-expand' && rawWidth <= 170)
    return { phase, collapsed: true, width: 46 };
  if (phase === 'may-expand') phase = 'expanded';
  return {
    phase,
    collapsed: false,
    width: clampResizeWidth(rawWidth, 170, 480),
  };
}

/** Prefer a finalized diff/result, then the live output while a tool is still running. */
export function preferredToolOutput(
  diff: string | undefined,
  output: string | undefined,
  liveOutput: string | undefined,
  running: boolean,
): string {
  if (diff) return diff;
  if (output) return output;
  return running ? (liveOutput ?? '') : '';
}

export function isContentBlock(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function validContentBlocks(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isContentBlock) : [];
}

export interface RunningToolLike {
  toolCallId: string;
  running: boolean;
}

/** Collect tool calls already represented by persisted transcript rows. */
export function collectToolCallIds(
  messages: readonly unknown[],
): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (!isContentBlock(message)) continue;
    for (const block of validContentBlocks(message.content)) {
      if (block.type === 'toolCall' && typeof block.id === 'string' && block.id)
        ids.add(block.id);
    }
  }
  return ids;
}

/**
 * Tools can start before a browser attaches. Render those snapshots until a
 * cumulative streaming frame (or a finalized row) supplies their toolCall.
 */
export function orphanRunningTools<T extends RunningToolLike>(
  tools: ReadonlyMap<string, T>,
  finalizedToolCallIds: ReadonlySet<string>,
  streamingContent?: unknown,
): T[] {
  const represented = new Set(finalizedToolCallIds);
  for (const block of validContentBlocks(streamingContent)) {
    if (block.type === 'toolCall' && typeof block.id === 'string' && block.id)
      represented.add(block.id);
  }
  return [...tools.values()].filter(
    (tool) => tool.running && !represented.has(tool.toolCallId),
  );
}

export const MAX_RICH_MARKDOWN_CHARS = 300_000;
export const MAX_STREAMING_MESSAGE_MARKDOWN_CHARS = 16_000;
export const MAX_FINAL_MESSAGE_MARKDOWN_CHARS = 96_000;
export const MAX_FORMATTED_JSON_CHARS = 512_000;
export const MAX_NUMBERED_CODE_LINES = 2_000;

export function canRenderRichMarkdown(length: number): boolean {
  return length <= MAX_RICH_MARKDOWN_CHARS;
}

/**
 * Growing assistant messages are reparsed repeatedly, so their rich-render
 * budget is intentionally much smaller than a finalized preview's budget.
 */
export function canRenderMessageMarkdown(
  length: number,
  streaming: boolean,
): boolean {
  return length <= (
    streaming
      ? MAX_STREAMING_MESSAGE_MARKDOWN_CHARS
      : MAX_FINAL_MESSAGE_MARKDOWN_CHARS
  );
}

export function canFormatJson(length: number): boolean {
  return length <= MAX_FORMATTED_JSON_CHARS;
}

export const MODEL_CATALOG_CHANGED_EVENT = 'pii:model-catalog-changed';

/** Notify already-mounted composers/settings after OAuth or API-key changes. */
export function notifyModelCatalogChanged(): void {
  if (typeof window !== 'undefined')
    window.dispatchEvent(new Event(MODEL_CATALOG_CHANGED_EVENT));
}

export async function checkedJsonResponse<T extends { error?: string }>(
  response: Response,
  operation: string,
): Promise<T> {
  let body: T | undefined;
  try {
    body = await response.json() as T;
  } catch {
    // Preserve the HTTP status when an intermediary returns non-JSON content.
  }
  if (!response.ok)
    throw new Error(body?.error ?? `${operation}: HTTP ${response.status}`);
  if (!body) throw new Error(`${operation}: invalid response`);
  return body;
}

export function oauthPollDelay(failures: number): number {
  return Math.min(5_000, 800 * 2 ** Math.min(Math.max(0, failures), 3));
}

/** A manual close after OAuth completion must still refresh the model catalog. */
export function oauthCloseSucceeded(
  observedSuccess: boolean,
  status: { done?: boolean; error?: unknown },
): boolean {
  return observedSuccess || (status.done === true && !status.error);
}

interface ToolCardMemoInputs {
  call: unknown;
  result?: unknown;
  activity?: unknown;
  onOpenFile?: unknown;
  language: string;
}

/** Keep localized tool labels fresh while preserving the normal shallow memo boundary. */
export function sameToolCardMemoInputs(
  previous: ToolCardMemoInputs,
  next: ToolCardMemoInputs,
): boolean {
  return (
    previous.call === next.call &&
    previous.result === next.result &&
    previous.activity === next.activity &&
    previous.onOpenFile === next.onOpenFile &&
    previous.language === next.language
  );
}
