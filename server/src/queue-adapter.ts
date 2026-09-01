/** Guarded adapter for Pi's currently non-public per-item queue internals. @author coolonion */
export type QueueLane = "steering" | "followUp";

export interface QueueCapabilities {
  revision: number;
  reorder: boolean;
  remove: boolean;
  reason?: string;
}

export interface QueueView {
  steering: string[];
  followUp: string[];
  capabilities: QueueCapabilities;
}

interface InternalMessageQueue {
  messages?: unknown[];
}

interface InternalAgentSession {
  _steeringMessages?: string[];
  _followUpMessages?: string[];
  _emitQueueUpdate?: () => void;
  agent?: {
    steeringQueue?: InternalMessageQueue;
    followUpQueue?: InternalMessageQueue;
  };
}

interface QueueLaneState {
  texts: string[];
  messages: unknown[];
  ids: string[];
}

interface QueueInspection {
  steering: QueueLaneState;
  followUp: QueueLaneState;
  emitUpdate: () => void;
  valid: boolean;
  reason?: string;
}

const INCOMPATIBLE_REASON =
  "当前 Pi SDK 队列结构不兼容，已禁用单条操作以避免删错消息。";
const IN_FLIGHT_REASON =
  "队列正在交付消息，请等待列表刷新后重试。";
const RICH_MESSAGE_REASON =
  "含图片或自定义内容的队列消息暂不支持单条编辑。";
const STALE_QUEUE_ERROR = "队列已变化，请重试当前操作。";

function textPayload(message: unknown): { text?: string; textOnly: boolean } {
  if (!message || typeof message !== "object") return { textOnly: false };
  const candidate = message as {
    role?: unknown;
    content?: unknown;
  };
  if (candidate.role !== "user") return { textOnly: false };
  if (typeof candidate.content === "string")
    return { text: candidate.content, textOnly: true };
  if (!Array.isArray(candidate.content)) return { textOnly: false };
  let text = "";
  for (const block of candidate.content) {
    if (
      !block ||
      typeof block !== "object" ||
      (block as { type?: unknown }).type !== "text" ||
      typeof (block as { text?: unknown }).text !== "string"
    )
      return { textOnly: false };
    text += (block as { text: string }).text;
  }
  return { text, textOnly: true };
}

/**
 * Adds identity and revision checks around Pi 0.84.x queue arrays.
 * Every mutation fails closed when the upstream private shape changes or a
 * message has already moved from pending to in-flight delivery.
 */
export class SessionQueueAdapter {
  private readonly messageIds = new WeakMap<Record<string, unknown>, string>();
  private nextMessageId = 0;
  private revision = 0;
  private fingerprint: string | undefined;

  constructor(private readonly getSession: () => unknown) {}

  view(): QueueView {
    const inspected = this.inspect();
    this.updateRevision(inspected);
    return {
      steering: [...inspected.steering.texts],
      followUp: [...inspected.followUp.texts],
      capabilities: {
        revision: this.revision,
        reorder: inspected.valid,
        remove: inspected.valid,
        reason: inspected.reason,
      },
    };
  }

  remove(
    lane: QueueLane,
    index: number,
    expectedMessage: string,
    expectedRevision: number,
  ): string {
    const inspected = this.mutableInspection(
      lane,
      index,
      expectedMessage,
      expectedRevision,
    );
    const target = inspected[lane];
    const [removedText] = target.texts.splice(index, 1);
    target.messages.splice(index, 1);
    inspected.emitUpdate();
    return removedText;
  }

  move(
    from: QueueLane,
    to: QueueLane,
    index: number,
    expectedMessage: string,
    expectedRevision: number,
  ): void {
    if (from === to) throw new Error("队列目标与来源相同。");
    const inspected = this.mutableInspection(
      from,
      index,
      expectedMessage,
      expectedRevision,
    );
    const source = inspected[from];
    const destination = inspected[to];
    const [text] = source.texts.splice(index, 1);
    const [message] = source.messages.splice(index, 1);
    destination.texts.push(text);
    destination.messages.push(message);
    inspected.emitUpdate();
  }

  private mutableInspection(
    lane: QueueLane,
    index: number,
    expectedMessage: string,
    expectedRevision: number,
  ): QueueInspection {
    const inspected = this.inspect();
    this.updateRevision(inspected);
    if (!inspected.valid)
      throw new Error(inspected.reason ?? INCOMPATIBLE_REASON);
    if (expectedRevision !== this.revision) throw new Error(STALE_QUEUE_ERROR);
    const target = inspected[lane];
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= target.texts.length ||
      target.texts[index] !== expectedMessage
    )
      throw new Error(STALE_QUEUE_ERROR);
    return inspected;
  }

  private inspect(): QueueInspection {
    const session = this.getSession() as InternalAgentSession;
    const steeringTexts = session?._steeringMessages;
    const followUpTexts = session?._followUpMessages;
    const steeringMessages = session?.agent?.steeringQueue?.messages;
    const followUpMessages = session?.agent?.followUpQueue?.messages;
    const emit = session?._emitQueueUpdate;
    const fallback = {
      steering: this.fallbackLane(steeringTexts),
      followUp: this.fallbackLane(followUpTexts),
      emitUpdate: () => undefined,
      valid: false,
      reason: INCOMPATIBLE_REASON,
    };
    if (
      !Array.isArray(steeringTexts) ||
      !Array.isArray(followUpTexts) ||
      !Array.isArray(steeringMessages) ||
      !Array.isArray(followUpMessages) ||
      typeof emit !== "function"
    )
      return fallback;
    if (
      steeringTexts.length !== steeringMessages.length ||
      followUpTexts.length !== followUpMessages.length
    )
      return {
        ...fallback,
        steering: this.fallbackLane(steeringTexts),
        followUp: this.fallbackLane(followUpTexts),
        reason: IN_FLIGHT_REASON,
      };

    const steering = this.inspectLane(steeringTexts, steeringMessages);
    const followUp = this.inspectLane(followUpTexts, followUpMessages);
    if (!steering || !followUp)
      return {
        ...fallback,
        steering: steering ?? this.fallbackLane(steeringTexts),
        followUp: followUp ?? this.fallbackLane(followUpTexts),
        reason: RICH_MESSAGE_REASON,
      };
    return {
      steering,
      followUp,
      emitUpdate: () => emit.call(session),
      valid: true,
    };
  }

  private inspectLane(
    texts: string[],
    messages: unknown[],
  ): QueueLaneState | undefined {
    const ids: string[] = [];
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index];
      const payload = textPayload(message);
      if (!payload.textOnly || payload.text !== texts[index]) return undefined;
      ids.push(this.idFor(message as Record<string, unknown>));
    }
    return { texts, messages, ids };
  }

  private fallbackLane(texts: unknown): QueueLaneState {
    return {
      texts: Array.isArray(texts)
        ? texts.filter((value): value is string => typeof value === "string")
        : [],
      messages: [],
      ids: [],
    };
  }

  private idFor(message: Record<string, unknown>): string {
    const existing = this.messageIds.get(message);
    if (existing) return existing;
    const next = `q${++this.nextMessageId}`;
    this.messageIds.set(message, next);
    return next;
  }

  private updateRevision(inspected: QueueInspection): void {
    const nextFingerprint = inspected.valid
      ? `${inspected.steering.ids.join(",")}|${inspected.followUp.ids.join(",")}`
      : `invalid:${JSON.stringify([
          inspected.steering.texts,
          inspected.followUp.texts,
          inspected.reason,
        ])}`;
    if (nextFingerprint === this.fingerprint) return;
    this.fingerprint = nextFingerprint;
    this.revision++;
  }
}
