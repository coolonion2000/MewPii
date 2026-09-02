/** Pure state transitions shared by React components and runtime tests. @author coolonion */
import type { PiiMessage, SessionSnapshot } from "./types";

export interface SelectionState {
  cwd: string;
  sessionPath?: string;
  sessionId?: string;
}

export type AppView =
  | "chat"
  | "files"
  | "models"
  | "skills"
  | "extensions"
  | "settings";

export interface AppRoute {
  view: AppView;
  selection?: SelectionState;
  pendingSessionId?: string;
}

const VIEWS = new Set<AppView>([
  "chat",
  "files",
  "models",
  "skills",
  "extensions",
  "settings",
]);

export function parseAppRoute(path: string, hash = ""): AppRoute {
  const legacy = hash.match(/^#\/([a-z]+)(?:\?(.+))?$/);
  if (legacy) {
    const requested = legacy[1] as AppView;
    const view = VIEWS.has(requested) ? requested : "chat";
    const params = new URLSearchParams(legacy[2] ?? "");
    const cwd = params.get("cwd");
    const session = params.get("session");
    if (view === "chat" && cwd)
      return { view, selection: { cwd, sessionPath: session ?? undefined } };
    return { view, selection: cwd ? { cwd } : undefined };
  }
  const match = path.match(/^\/chat\/([0-9a-f-]{8,})\/?$/i);
  if (match) return { view: "chat", pendingSessionId: match[1].toLowerCase() };
  const requested = path.replace(/^\//, "").replace(/\/$/, "") as AppView;
  return VIEWS.has(requested) ? { view: requested } : { view: "chat" };
}

export function sessionIdFromPath(path: string | undefined): string | undefined {
  return path?.match(/_([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i)?.[1]?.toLowerCase();
}

export function appRoutePath(route: AppRoute, sessionId?: string): string {
  if (route.view !== "chat") return `/${route.view}`;
  const id = sessionId ?? route.selection?.sessionId ?? sessionIdFromPath(route.selection?.sessionPath);
  return id ? `/chat/${id}` : "/chat";
}

export function parseStoredSelection(value: string | null): SelectionState | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<SelectionState>;
    if (typeof parsed.cwd !== "string" || typeof parsed.sessionPath !== "string")
      return undefined;
    return {
      cwd: parsed.cwd,
      sessionPath: parsed.sessionPath,
      sessionId:
        typeof parsed.sessionId === "string"
          ? parsed.sessionId
          : sessionIdFromPath(parsed.sessionPath),
    };
  } catch {
    return undefined;
  }
}

export function initialCwd(
  projectCwds: string[],
  lastCwd: string | null,
): string | undefined {
  return lastCwd || projectCwds[0];
}

export function acceptsGeneration(
  current: number,
  candidate: number,
  aborted: boolean,
): boolean {
  return !aborted && current === candidate;
}

export function parseStoredStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export function shouldShowDisconnected(
  connected: boolean,
  reconnecting: boolean,
  error: string | undefined,
): boolean {
  return !connected && !reconnecting && Boolean(error);
}

export interface LiveDeltaSample {
  t: number;
  n: number;
}

export interface LiveOutputMetrics {
  tokens?: number;
  tps?: number;
}

export interface LiveOutputMetricsInput {
  visibleChars: number;
  outputChars: number;
  firstDeltaAt: number | undefined;
  deltaSamples: readonly LiveDeltaSample[];
  now: number;
}

/** Estimate visible output only; hidden provider reasoning remains unknown. */
export function calculateLiveOutputMetrics({
  visibleChars,
  outputChars,
  firstDeltaAt,
  deltaSamples,
  now,
}: LiveOutputMetricsInput): LiveOutputMetrics {
  const chars = Math.max(0, visibleChars, outputChars);
  if (chars === 0) return {};

  const tokens = Math.round(chars / 3.5);
  if (!firstDeltaAt) return { tokens };

  const cutoff = now - 5000;
  const recentChars = deltaSamples
    .filter((sample) => sample.t >= cutoff)
    .reduce((sum, sample) => sum + sample.n, 0);
  const windowStart = Math.max(firstDeltaAt, cutoff);
  const elapsedSeconds = Math.max(0.5, (now - windowStart) / 1000);
  return { tokens, tps: recentChars / 3.5 / elapsedSeconds };
}

export interface GenerationGate {
  next(): number;
  accepts(candidate: number, aborted: boolean): boolean;
}

/** Issue monotonic request generations and reject stale or aborted results. */
export function createGenerationGate(): GenerationGate {
  let current = 0;
  return {
    next: () => ++current,
    accepts: (candidate, aborted) =>
      acceptsGeneration(current, candidate, aborted),
  };
}

export function clearMatchingRequest<T extends { id: string }>(
  current: T | undefined,
  requestId: string,
): T | undefined {
  return current?.id === requestId ? undefined : current;
}

/** Match pi's widget maps: the latest value for a key replaces the old one. */
export function dedupeLatestByKey<T extends { key: string }>(
  items: readonly T[],
): T[] {
  const byKey = new Map<string, T>();
  for (const item of items) byKey.set(item.key, item);
  return [...byKey.values()];
}

export interface TranscriptNotice {
  id: number;
  message: string;
  level: string;
  afterMessageKey?: string;
}

/** Stable-enough anchor for inserting non-persisted Pi status text into the transcript. */
export function messageTimelineKey(message: PiiMessage, index: number): string {
  if (message._entryId) return `entry:${message._entryId}`;
  const timestamp = (message as { timestamp?: unknown }).timestamp;
  if (typeof timestamp === "number" || typeof timestamp === "string") {
    return `time:${message.role}:${String(timestamp)}`;
  }
  const id = (message as { id?: unknown; toolCallId?: unknown }).id ??
    (message as { toolCallId?: unknown }).toolCallId;
  if (typeof id === "string" || typeof id === "number") {
    return `id:${message.role}:${String(id)}`;
  }
  return `index:${index}:${message.role}`;
}

/**
 * Match Pi's showStatus(): consecutive info lines update the prior transcript
 * item; warnings/errors and normal chat content break that replacement chain.
 */
export function applyTranscriptNotice(
  notices: readonly TranscriptNotice[],
  replaceableInfoId: number | undefined,
  notification: TranscriptNotice,
): { notices: TranscriptNotice[]; replaceableInfoId: number | undefined } {
  if (notification.level === "info" && replaceableInfoId !== undefined) {
    const index = notices.findIndex((notice) => notice.id === replaceableInfoId);
    if (index !== -1) {
      const next = [...notices];
      next[index] = { ...next[index], message: notification.message };
      return { notices: next, replaceableInfoId };
    }
  }
  return {
    notices: [...notices, notification],
    replaceableInfoId:
      notification.level === "info" ? notification.id : undefined,
  };
}

/** A generic slash result must not overwrite output emitted by its handler. */
export function commandNoticeFallback(
  revisionBefore: number,
  revisionAfter: number,
  output: string | undefined,
  fallback: string,
): string | undefined {
  if (revisionAfter !== revisionBefore) return undefined;
  return output || fallback;
}

export function fixedAgentUrl(url: string, agent?: string): string {
  if (!agent || /(?:[?&])agent=/.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}agent=${encodeURIComponent(agent)}`;
}

/** Only persisted sessions may reuse snapshots; every blank session must start fresh. */
export function conversationSnapshotCacheKey(
  agent: string | undefined,
  cwd: string,
  sessionPath: string | undefined,
): string | undefined {
  return sessionPath ? `${agent ?? "local"}|${cwd}|${sessionPath}` : undefined;
}

/** Normalize an allowed rename and fail closed while the session is running. */
export function normalizeSessionRename(
  draft: string,
  running: boolean,
): string | undefined {
  const name = draft.trim();
  return !running && name ? name : undefined;
}

export function restoreFailedText(current: string, submitted: string): string {
  return current.length > 0 ? current : submitted;
}

export function restoreFailedImages<
  T extends { data: string; mimeType: string },
>(current: T[], submitted: T[]): T[] {
  const seen = new Set<string>();
  return [...submitted, ...current].filter((image) => {
    const key = `${image.mimeType}:${image.data}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function messageText(message: PiiMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return (message.content as { type?: string; text?: string }[])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

/**
 * Keep locally submitted messages while a returned snapshot is still stale.
 * Once totalMessages advances, only the newly-added tail may acknowledge them.
 */
export function reconcileOptimisticMessages<
  T extends { text: string; baseTotalMessages: number },
>(optimistic: readonly T[], finalized: PiiMessage[], totalMessages: number): T[] {
  const consumed = new Set<number>();
  return optimistic.filter((pending) => {
    const added = Math.max(0, totalMessages - pending.baseTotalMessages);
    if (added === 0) return true;
    const start = Math.max(0, finalized.length - added);
    const match = finalized.findIndex((message, index) =>
      index >= start &&
      !consumed.has(index) &&
      message.role === "user" &&
      messageText(message) === pending.text,
    );
    if (match === -1) return true;
    consumed.add(match);
    return false;
  });
}

function entryId(message: PiiMessage): string | undefined {
  return typeof message._entryId === "string" && message._entryId
    ? message._entryId
    : undefined;
}

/** Prepend a history page without duplicating entries already received by snapshot/event. */
export function mergeHistoryMessages(
  current: PiiMessage[],
  older: PiiMessage[],
): PiiMessage[] {
  const known = new Set(
    current.map(entryId).filter((id): id is string => Boolean(id)),
  );
  const prefix = older.filter((message) => {
    const id = entryId(message);
    if (!id || !known.has(id)) {
      if (id) known.add(id);
      return true;
    }
    return false;
  });
  return [...prefix, ...current];
}

/** A reconnect may briefly return an older snapshot than the local event stream. */
export function isStaleConversationSnapshot(
  previousSessionId: string | undefined,
  previousBranchHeadId: string | undefined,
  previousTotalMessages: number,
  snapshot: SessionSnapshot,
): boolean {
  if (
    previousSessionId !== snapshot.sessionId ||
    previousBranchHeadId !== snapshot.branchHeadId
  )
    return false;
  return (snapshot.totalMessages ?? snapshot.messages.length) < previousTotalMessages;
}

/** Preserve loaded history only when the new snapshot overlaps the same session branch. */
export function mergeSnapshotMessages(
  current: PiiMessage[],
  previousSessionId: string | undefined,
  snapshot: SessionSnapshot,
): { messages: PiiMessage[]; historyFrom: number } {
  if (
    previousSessionId !== snapshot.sessionId ||
    current.length === 0 ||
    snapshot.messages.length === 0
  )
    return {
      messages: snapshot.messages,
      historyFrom: snapshot.historyFrom ?? 0,
    };
  const firstId = entryId(snapshot.messages[0]);
  if (!firstId)
    return {
      messages: snapshot.messages,
      historyFrom: snapshot.historyFrom ?? 0,
    };
  const overlap = current.findIndex((message) => entryId(message) === firstId);
  if (overlap < 0)
    return {
      messages: snapshot.messages,
      historyFrom: snapshot.historyFrom ?? 0,
    };
  return {
    messages: mergeHistoryMessages(
      snapshot.messages,
      current.slice(0, overlap),
    ),
    historyFrom: Math.min(
      snapshot.historyFrom ?? 0,
      Math.max(0, (snapshot.historyFrom ?? 0) - overlap),
    ),
  };
}

export function isTerminalRun(
  state: string | undefined,
  alive: boolean,
): boolean {
  if (alive) return false;
  return new Set([
    "completed",
    "complete",
    "done",
    "success",
    "failed",
    "error",
    "cancelled",
    "canceled",
    "aborted",
    "timeout",
    "timed_out",
  ]).has((state ?? "").toLowerCase());
}
