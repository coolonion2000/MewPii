import type { PiiMessage } from './types';

export interface PendingPartialEvent {
  event: Record<string, unknown>;
  receivedAt: number;
}

export interface AssistantPartialEvent {
  type?: string;
  contentIndex?: number;
  delta?: string;
  content?: string;
  toolCall?: Record<string, unknown>;
}

const MAX_STREAMING_CONTENT_BLOCKS = 4096;

function emptyTextBlock(): Record<string, unknown> {
  return { type: 'text', text: '' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Preserve content indexes while replacing JSON nulls / sparse array holes with
 * inert blocks. React renderers may safely read `block.type` from every slot.
 */
export function normalizeStreamingContent(
  value: unknown,
): Record<string, unknown>[] {
  if (typeof value === 'string') {
    return value ? [{ type: 'text', text: value }] : [];
  }
  if (!Array.isArray(value)) return [];
  const length = Math.min(value.length, MAX_STREAMING_CONTENT_BLOCKS);
  return Array.from({ length }, (_, index) => {
    const block = value[index];
    return isRecord(block) ? { ...block } : emptyTextBlock();
  });
}

/** Clone a transcript message and make every array content slot render-safe. */
export function normalizeMessageContent(value: PiiMessage): PiiMessage {
  if (!Array.isArray(value.content) && value.role !== 'assistant') {
    return { ...value };
  }
  return {
    ...value,
    content: normalizeStreamingContent(value.content),
  };
}

/** Clone a cumulative assistant partial into the UI-safe message shape. */
export function normalizeStreamingMessage(
  value: PiiMessage | null | undefined,
): PiiMessage | undefined {
  if (!value || value.role !== 'assistant') return undefined;
  return normalizeMessageContent(value);
}

function safeContentIndex(value: unknown): number {
  return Number.isInteger(value) && Number(value) >= 0
    ? Math.min(Number(value), MAX_STREAMING_CONTENT_BLOCKS - 1)
    : 0;
}

function ensureContentSlot(
  content: Record<string, unknown>[],
  index: number,
): void {
  while (content.length <= index) content.push(emptyTextBlock());
}

/**
 * Reconcile one message_update frame. `event.message` is the SDK's cumulative
 * partial and is authoritative. Applying its delta again would duplicate text.
 * The delta-only path remains for older/remotely transformed event producers.
 */
export function reconcileStreamingMessage(
  current: PiiMessage | undefined,
  event: Record<string, unknown>,
): PiiMessage | undefined {
  const cumulative = isRecord(event.message)
    ? normalizeStreamingMessage(event.message as PiiMessage)
    : undefined;
  if (cumulative) return cumulative;

  const sub = isRecord(event.assistantMessageEvent)
    ? (event.assistantMessageEvent as AssistantPartialEvent)
    : undefined;
  if (!sub?.type) return normalizeStreamingMessage(current);

  const base =
    normalizeStreamingMessage(current) ??
    ({ role: 'assistant', content: [] } as PiiMessage);
  const content = normalizeStreamingContent(base.content);
  const index = safeContentIndex(sub.contentIndex);
  ensureContentSlot(content, index);

  if (sub.type === 'text_start') {
    content[index] = { type: 'text', text: '' };
  } else if (sub.type === 'thinking_start') {
    content[index] = { type: 'thinking', thinking: '' };
  } else if (sub.type === 'text_delta' || sub.type === 'thinking_delta') {
    const key = sub.type === 'text_delta' ? 'text' : 'thinking';
    const expectedType = sub.type === 'text_delta' ? 'text' : 'thinking';
    const existing = content[index];
    const block = existing?.type === expectedType
      ? existing
      : { type: expectedType, [key]: '' };
    content[index] = {
      ...block,
      [key]: `${String(block[key] ?? '')}${sub.delta ?? ''}`,
    };
  } else if (sub.type === 'text_end' || sub.type === 'thinking_end') {
    const key = sub.type === 'text_end' ? 'text' : 'thinking';
    content[index] = {
      type: sub.type === 'text_end' ? 'text' : 'thinking',
      [key]: sub.content ?? '',
    };
  } else if (sub.type === 'toolcall_start') {
    content[index] = {
      type: 'toolCall',
      id: `pending-${index}`,
      name: '',
      arguments: {},
    };
  } else if (sub.type === 'toolcall_end' && isRecord(sub.toolCall)) {
    content[index] = { ...sub.toolCall };
  }

  return { ...base, content };
}

export function isBatchablePartialEvent(
  event: Record<string, unknown>,
): boolean {
  if (event.type === 'tool_execution_update') return true;
  if (event.type !== 'message_update') return false;
  const sub = event.assistantMessageEvent as AssistantPartialEvent | undefined;
  return sub?.type === 'text_delta' || sub?.type === 'thinking_delta';
}

/**
 * Add one visual-only event without changing the relative order of retained
 * events. Adjacent text/thinking chunks collapse; tool output keeps only its
 * newest frame because the protocol payload is the latest partial result.
 */
export function appendPartialEvent(
  pending: readonly PendingPartialEvent[],
  event: Record<string, unknown>,
  receivedAt: number,
): PendingPartialEvent[] {
  const frame = { event, receivedAt };
  const sub = event.assistantMessageEvent as AssistantPartialEvent | undefined;
  const previous = pending.at(-1);
  const previousSub = previous?.event.assistantMessageEvent as
    | AssistantPartialEvent
    | undefined;
  if (
    previous &&
    event.type === 'message_update' &&
    previous.event.type === 'message_update' &&
    (sub?.type === 'text_delta' || sub?.type === 'thinking_delta') &&
    previousSub?.type === sub.type &&
    previousSub.contentIndex === sub.contentIndex
  ) {
    return [
      ...pending.slice(0, -1),
      {
        receivedAt: previous.receivedAt,
        event: {
          ...event,
          assistantMessageEvent: {
            ...sub,
            delta: `${previousSub.delta ?? ''}${sub.delta ?? ''}`,
          },
        },
      },
    ];
  }

  if (event.type === 'tool_execution_update' && event.toolCallId !== undefined) {
    let previousToolIndex = -1;
    for (let index = pending.length - 1; index >= 0; index--) {
      const item = pending[index];
      if (
        item?.event.type === 'tool_execution_update' &&
        item.event.toolCallId === event.toolCallId
      ) {
        previousToolIndex = index;
        break;
      }
    }
    if (previousToolIndex >= 0) {
      return [
        ...pending.slice(0, previousToolIndex),
        ...pending.slice(previousToolIndex + 1),
        frame,
      ];
    }
  }

  return [...pending, frame];
}
