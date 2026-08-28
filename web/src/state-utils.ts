/** Pure state transitions shared by React components and runtime tests. @author coolonion */
import type { PiiMessage, SessionSnapshot } from "./types";

export interface SelectionState {
  cwd: string;
  sessionPath?: string;
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
  const match = path.match(/^\/chat\/([0-9a-f-]{8,})$/);
  if (match) return { view: "chat", pendingSessionId: match[1] };
  const requested = path.slice(1) as AppView;
  return VIEWS.has(requested) ? { view: requested } : { view: "chat" };
}

export function appRoutePath(route: AppRoute, sessionId?: string): string {
  return route.view === "chat"
    ? sessionId
      ? `/chat/${sessionId}`
      : "/chat"
    : `/${route.view}`;
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

export function fixedAgentUrl(url: string, agent?: string): string {
  if (!agent || /(?:[?&])agent=/.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}agent=${encodeURIComponent(agent)}`;
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
