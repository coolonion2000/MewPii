export interface PendingPartialEvent {
  event: Record<string, unknown>;
  receivedAt: number;
}

interface AssistantPartialEvent {
  type?: string;
  contentIndex?: number;
  delta?: string;
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
