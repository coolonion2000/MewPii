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

export function reconcileReadyPaging(
  current: Pick<SessionSnapshot, "pagingProvisional">,
  historyFrom: number,
  totalMessages: number,
  ready: Pick<SessionSnapshot, "historyFrom" | "totalMessages">,
): { historyFrom: number; totalMessages: number } {
  return current.pagingProvisional === true
    ? {
        historyFrom: ready.historyFrom,
        totalMessages: ready.totalMessages,
      }
    : { historyFrom, totalMessages };
}

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

/** Old servers omit initializing; only an explicit true means not ready yet. */
export function isSessionSnapshotReady(
  snapshot: Pick<SessionSnapshot, "initializing"> | undefined,
): boolean {
  return Boolean(snapshot) && snapshot?.initializing !== true;
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

/** Preserve React state identity when a polled ordered string list is unchanged. */
export function sameOrderedStrings(
  previous: readonly string[],
  next: readonly string[],
): boolean {
  return (
    previous.length === next.length &&
    previous.every((value, index) => value === next[index])
  );
}

export interface SessionCatalogRefreshState {
  messageCount: number;
  isStreaming?: boolean;
  sessionFile?: string;
}

/**
 * The first snapshot hydrates an already-listed session and must not immediately
 * refetch the catalog. Later lifecycle changes can make its sidebar row stale.
 */
export function shouldRefreshSessionCatalog(
  previous: SessionCatalogRefreshState | undefined,
  next: SessionCatalogRefreshState | undefined,
): boolean {
  if (!previous || !next) return false;
  return (
    (previous.isStreaming === true && next.isStreaming === false) ||
    (previous.messageCount === 0 && next.messageCount > 0) ||
    (Boolean(next.sessionFile) && next.sessionFile !== previous.sessionFile)
  );
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
  const id = (message as { id?: unknown; toolCallId?: unknown }).id ??
    (message as { toolCallId?: unknown }).toolCallId;
  if (typeof id === "string" || typeof id === "number") {
    return `id:${message.role}:${String(id)}`;
  }
  const timestamp = (message as { timestamp?: unknown }).timestamp;
  if (typeof timestamp === "number" || typeof timestamp === "string") {
    return `time:${message.role}:${String(timestamp)}`;
  }
  return `index:${index}:${message.role}`;
}

/** React keys stay stable for persisted messages and disambiguate rare transient collisions. */
export function uniqueMessageTimelineKeys(
  messages: readonly PiiMessage[],
): string[] {
  const occurrences = new Map<string, number>();
  return messages.map((message, index) => {
    const base = messageTimelineKey(message, index);
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    return occurrence === 0 ? base : `${base}:occurrence:${occurrence}`;
  });
}

/**
 * Decide whether an incoming finalized message upgrades the same last row.
 * Prefer durable/direct IDs; timestamps are only a fallback when neither side
 * exposes a direct message/tool identity.
 */
export function sameMessageTimelineIdentity(
  previous: PiiMessage,
  next: PiiMessage,
): boolean {
  if (previous.role !== next.role) return false;
  if (previous._entryId && next._entryId)
    return previous._entryId === next._entryId;
  const previousId =
    (previous as { id?: unknown }).id ??
    (previous as { toolCallId?: unknown }).toolCallId;
  const nextId =
    (next as { id?: unknown }).id ??
    (next as { toolCallId?: unknown }).toolCallId;
  if (previousId !== undefined || nextId !== undefined)
    return (
      previousId !== undefined &&
      nextId !== undefined &&
      String(previousId) === String(nextId)
    );
  const previousTimestamp = (previous as { timestamp?: unknown }).timestamp;
  const nextTimestamp = (next as { timestamp?: unknown }).timestamp;
  return nextTimestamp !== undefined && previousTimestamp === nextTimestamp;
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

/** Cache only under the session path reported by the current host snapshot. */
export function conversationStateCacheKeys(
  agent: string | undefined,
  cwd: string,
  _requestedSessionPath: string | undefined,
  snapshotSessionPath: string | undefined,
): string[] {
  const key = conversationSnapshotCacheKey(agent, cwd, snapshotSessionPath);
  return key ? [key] : [];
}

/** Keep the cached snapshot queue and its mutation token in one atomic state. */
export function synchronizeSnapshotQueue(
  snapshot: SessionSnapshot,
  queue: { steering: string[]; followUp: string[] },
  queueCapabilities?: SessionSnapshot["queueCapabilities"],
): SessionSnapshot {
  return {
    ...snapshot,
    queue: {
      steering: [...queue.steering],
      followUp: [...queue.followUp],
    },
    queueCapabilities: queueCapabilities ?? snapshot.queueCapabilities,
  };
}

/** Refresh one entry and evict the least-recently-used entries above capacity. */
export function setLruMapEntry<K, V>(
  cache: Map<K, V>,
  key: K,
  value: V,
  capacity: number,
): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > Math.max(0, capacity)) {
    const oldest = cache.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
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
export interface OptimisticReconciliation<T> {
  remaining: T[];
  matches: { pendingIndex: number; finalizedIndex: number }[];
}

/** Reconcile pending rows and expose exact matches so transient anchors can migrate. */
export function reconcileOptimisticMessageState<
  T extends { text: string; baseTotalMessages: number },
>(
  optimistic: readonly T[],
  finalized: PiiMessage[],
  totalMessages: number,
): OptimisticReconciliation<T> {
  const consumed = new Set<number>();
  const remaining: T[] = [];
  const matches: { pendingIndex: number; finalizedIndex: number }[] = [];
  optimistic.forEach((pending, pendingIndex) => {
    const added = Math.max(0, totalMessages - pending.baseTotalMessages);
    if (added === 0) {
      remaining.push(pending);
      return;
    }
    const start = Math.max(0, finalized.length - added);
    const match = finalized.findIndex((message, index) =>
      index >= start &&
      !consumed.has(index) &&
      message.role === "user" &&
      messageText(message) === pending.text,
    );
    if (match === -1) {
      remaining.push(pending);
      return;
    }
    consumed.add(match);
    matches.push({ pendingIndex, finalizedIndex: match });
  });
  return { remaining, matches };
}

export function reconcileOptimisticMessages<
  T extends { text: string; baseTotalMessages: number },
>(optimistic: readonly T[], finalized: PiiMessage[], totalMessages: number): T[] {
  return reconcileOptimisticMessageState(
    optimistic,
    finalized,
    totalMessages,
  ).remaining;
}

/** Move notices only between identities proven to represent the same message. */
export function reanchorTranscriptNotices(
  notices: readonly TranscriptNotice[],
  replacements: readonly { from: string; to: string }[],
): TranscriptNotice[] {
  if (replacements.length === 0) return [...notices];
  const byOldKey = new Map(replacements.map(({ from, to }) => [from, to]));
  return notices.map((notice) => {
    const replacement = notice.afterMessageKey
      ? byOldKey.get(notice.afterMessageKey)
      : undefined;
    return replacement
      ? { ...notice, afterMessageKey: replacement }
      : notice;
  });
}

/** Detect timestamp-backed messages upgraded to persisted entry identities. */
export function timestampAnchorReplacements(
  previous: readonly PiiMessage[],
  finalized: readonly PiiMessage[],
): { from: string; to: string }[] {
  const consumed = new Set<number>();
  const replacements: { from: string; to: string }[] = [];
  previous.forEach((message, previousIndex) => {
    const timestamp = (message as { timestamp?: unknown }).timestamp;
    if (timestamp === undefined) return;
    const match = finalized.findIndex((candidate, finalizedIndex) =>
      !consumed.has(finalizedIndex) &&
      candidate.role === message.role &&
      (candidate as { timestamp?: unknown }).timestamp === timestamp,
    );
    if (match === -1) return;
    consumed.add(match);
    const from = messageTimelineKey(message, previousIndex);
    const to = messageTimelineKey(finalized[match], match);
    if (from !== to) replacements.push({ from, to });
  });
  return replacements;
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
