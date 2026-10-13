import type {
  ClientCommand,
  CustomUiFrame,
  PiiMessage,
  ProjectGroup,
  ServerMessage,
  SessionSnapshot,
  UiRequest,
  WidgetState,
} from "./types";
import {
  applyTranscriptNotice,
  clearMatchingRequest,
  conversationSnapshotCacheKey,
  conversationStateCacheKeys,
  fixedAgentUrl,
  isStaleConversationSnapshot,
  isSessionSnapshotReady,
  mergeHistoryMessages,
  mergeSnapshotMessages,
  messageTimelineKey,
  reanchorTranscriptNotices,
  reconcileReadyPaging,
  reconcileOptimisticMessageState,
  sameMessageTimelineIdentity,
  setLruMapEntry,
  synchronizeSnapshotQueue,
  timestampAnchorReplacements,
  type TranscriptNotice,
} from "./state-utils";
import { ReadinessWaiters } from "./readiness-waiters";
import { watchServiceHealth } from "./service-health";
import { canRecordDelivery, deliveryFingerprintForSend, readDeliveries, writeDeliveries } from './delivery-store';
import { hasRecentVisibleMessages, notifyModelCatalogChanged } from "./ui-reliability";
import {
  appendPartialEvent,
  isBatchablePartialEvent,
  normalizeMessageContent,
  normalizeStreamingMessage,
  reconcileStreamingMessage,
  type PendingPartialEvent,
} from "./partial-events";

// ---------------------------------------------------------------------------
// multi-agent routing: when an agent is selected, all /api and /ws traffic is
// proxied to it by the hub
// ---------------------------------------------------------------------------
const AGENT_KEY = "pii-agent";

export function getAgent(): string | undefined {
  return localStorage.getItem(AGENT_KEY) || undefined;
}

export function setAgent(name?: string): void {
  if (name) localStorage.setItem(AGENT_KEY, name);
  else localStorage.removeItem(AGENT_KEY);
  location.reload();
}

export function withAgent(
  url: string,
  agent: string | undefined = getAgent(),
): string {
  return fixedAgentUrl(url, agent);
}

{
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof Request
          ? input.url
          : String(input);
    if (typeof input === "string" && input.startsWith("/api/")) {
      input = withAgent(input);
    }
    const res = await origFetch(input, init);
    // silent 401 (e.g. session expired after server restart) → back to login
    if (res.status === 401 && !url.startsWith("/api/auth/login")) {
      location.assign(
        `/login?next=${encodeURIComponent(location.pathname + location.search)}`,
      );
    }
    return res;
  };
}

export async function fetchProjects(
  signal?: AbortSignal,
  includeArchived = false,
): Promise<ProjectGroup[]> {
  const res = await fetch(
    includeArchived ? "/api/sessions?includeArchived=1" : "/api/sessions",
    { signal },
  );
  if (!res.ok) throw new Error(`sessions: ${res.status}`);
  const data = (await res.json()) as { projects: ProjectGroup[] };
  return data.projects;
}

export async function deleteSession(path: string): Promise<void> {
  const res = await fetch(`/api/sessions?path=${encodeURIComponent(path)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`delete: ${res.status}`);
}

export interface ModelsResponse {
  catalogRefreshing?: boolean;
  providers: {
    id: string;
    name: string;
    configured: boolean;
    authSource?: string;
    modelCount: number;
  }[];
  models: import("./types").ModelInfoLite[];
}

const MODELS_CACHE_TTL_MS = 15_000;
let modelsCache:
  | { value: ModelsResponse; loadedAt: number }
  | undefined;
let modelsRequest: Promise<ModelsResponse> | undefined;
let modelsPollTimer: ReturnType<typeof setTimeout> | undefined;
let modelsPollAttempts = 0;

function followCatalogRefresh(value: ModelsResponse): void {
  if (!value.catalogRefreshing) {
    clearTimeout(modelsPollTimer);
    modelsPollTimer = undefined;
    modelsPollAttempts = 0;
    return;
  }
  if (modelsPollTimer || modelsPollAttempts >= 25) return;
  modelsPollTimer = setTimeout(async () => {
    modelsPollTimer = undefined;
    modelsPollAttempts += 1;
    try {
      await fetchModels(true);
    } catch {
      followCatalogRefresh(value);
    }
  }, 1000);
}

/** Deduplicate Composer/Settings model discovery across rapid view changes. */
export function getCachedModels(): ModelsResponse | undefined {
  return modelsCache?.value;
}

export async function fetchModels(force = false): Promise<ModelsResponse> {
  if (!force && modelsCache) {
    if (Date.now() - modelsCache.loadedAt >= MODELS_CACHE_TTL_MS) {
      // Keep the last usable list interactive while revalidating. Failure must
      // not discard it or produce an unhandled background rejection.
      void fetchModels(true).catch(() => {});
    }
    return modelsCache.value;
  }
  if (modelsRequest) return modelsRequest;
  const loading = fetch("/api/models", { signal: AbortSignal.timeout(10_000) }).then(async (res) => {
    if (!res.ok) throw new Error(`models: ${res.status}`);
    const value = (await res.json()) as ModelsResponse;
    const hadCache = Boolean(modelsCache);
    modelsCache = { value, loadedAt: Date.now() };
    followCatalogRefresh(value);
    if (hadCache) notifyModelCatalogChanged();
    return value;
  });
  const tracked = loading.finally(() => {
    if (modelsRequest === tracked) modelsRequest = undefined;
  });
  modelsRequest = tracked;
  return tracked;
}

// ---------------------------------------------------------------------------
// Conversation: one WebSocket = one conversation view
// ---------------------------------------------------------------------------

export interface ToolActivity {
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown>;
  running: boolean;
  isError?: boolean;
  startedAt?: number;
  endedAt?: number;
  /** Live partial output text (e.g. bash stdout while running). */
  liveOutput?: string;
}

/** Live-measured timing for the current/last run (not persisted by pi). */
export interface RunStats {
  agentStartedAt?: number;
  endedAt?: number;
  firstDeltaAt?: number;
  llmMs: number;
  toolMs: number;
  turns: number;
  steps: number;
  outputChars: number;
}

function runningToolsFromSnapshot(
  snapshot: Pick<SessionSnapshot, "activeToolCalls">,
): Map<string, ToolActivity> {
  return new Map(
    (snapshot.activeToolCalls ?? [])
      .filter(
        (tool) =>
          tool &&
          typeof tool.toolCallId === "string" &&
          typeof tool.toolName === "string",
      )
      .map((tool) => [
        tool.toolCallId,
        {
          toolCallId: tool.toolCallId,
          toolName: tool.toolName,
          args:
            tool.args && typeof tool.args === "object"
              ? { ...tool.args }
              : undefined,
          running: true,
          startedAt:
            typeof tool.startedAt === "number" ? tool.startedAt : undefined,
          liveOutput:
            typeof tool.liveOutput === "string"
              ? stripAnsi(tool.liveOutput)
              : undefined,
        },
      ]),
  );
}

function sameStringArray(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameWidgets(
  left: readonly WidgetState[],
  right: readonly WidgetState[],
): boolean {
  return (
    left.length === right.length &&
    left.every((widget, index) => {
      const other = right[index];
      return (
        widget.key === other?.key &&
        widget.placement === other.placement &&
        sameStringArray(widget.lines, other.lines)
      );
    })
  );
}

function sameStatuses(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => left[key] === right[key])
  );
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const content = (value as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((b) => b as { type?: string; text?: string })
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n");
    }
  }
  return "";
}

// eslint-disable-next-line no-control-regex
const ANSI_RE =
  /\x1b(?:\[[0-9;?]*[a-zA-Z]|\][^\x07]*\x07|_[^\x07]*\x07|\([0-9A-B])/g;
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

interface StreamSub {
  type: string;
  contentIndex?: number;
  delta?: string;
  content?: string;
  toolCall?: {
    type: "toolCall";
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  };
  message?: PiiMessage;
}

interface OptimisticMessage {
  key: number;
  text: string;
  message: PiiMessage;
  /** Finalized branch size when this message was submitted. */
  baseTotalMessages: number;
}

interface CachedConversationState {
  snapshot: SessionSnapshot;
  optimistic: OptimisticMessage[];
  streaming?: PiiMessage;
  activeTools: ToolActivity[];
  transcriptNotices: TranscriptNotice[];
  transcriptNoticeRevision: number;
  noticeSeq: number;
  replaceableInfoNoticeId?: number;
}

// Last-known finalized + pending state, shown instantly while a fresh snapshot
// streams in after switching back to a conversation.
const conversationStateCache = new Map<string, CachedConversationState>();
const CONVERSATION_STATE_CACHE_CAPACITY = 24;
const COMMAND_TIMEOUT_MS = 120_000;
const PARTIAL_UPDATE_FLUSH_MS = 40;

export type MessageDelivery = {
  id: string;
  type: 'prompt' | 'steer' | 'followUp' | 'slash';
  state: 'sending' | 'accepted' | 'failed' | 'unknown';
  updatedAt: number;
  error?: string;
};

export class DeliveryUnknownError extends Error {
  constructor(public readonly deliveryId: string, public readonly alreadySubmitted = false) {
    super('Message delivery is unconfirmed; check its status before sending it again.');
    this.name = 'DeliveryUnknownError';
  }
}

export class DeliveryNotSentError extends Error {
  constructor(public readonly reason: 'disposed' | 'session_changed') {
    super(reason === 'disposed' ? 'Conversation closed while preparing the message; message was not sent.'
      : 'Session changed while preparing the message; message was not sent.');
    this.name = 'DeliveryNotSentError';
  }
}

class CommandOutcomeUnknownError extends Error {}
type MessageCommand = Extract<ClientCommand, { type: 'prompt' | 'steer' | 'followUp' | 'slash' }>;

function retainedDeliveryData(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return data && JSON.stringify(data).length > 8192 ? { accepted: true, deliveryResultOmitted: true } : data;
}

export class Conversation {
  private ws?: WebSocket;
  private listeners = new Set<() => void>();
  private revision = 0;
  private commandSeq = 0;
  private pending = new Map<
    string,
    {
      resolve: (data: Record<string, unknown> | undefined) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readyWaiters = new ReadinessWaiters();
  private pendingPartialEvents: PendingPartialEvent[] = [];
  private partialFlushTimer?: ReturnType<typeof setTimeout>;

  snapshot?: SessionSnapshot;
  /** Finalized messages (from snapshot / message_end). */
  messages: PiiMessage[] = [];
  /** Optimistically rendered user messages awaiting server echo (remote latency). */
  optimistic: OptimisticMessage[] = [];
  private optimisticSeq = 0;
  /** In-flight assistant message being streamed. */
  streaming?: PiiMessage;
  /** Live tool execution states keyed by toolCallId. */
  tools = new Map<string, ToolActivity>();
  connected = false;
  transportOpen = false;
  delivery?: MessageDelivery;
  private deliveryRecords = new Map<string, {
    status: MessageDelivery;
    fingerprint: string;
    sessionId?: string;
    scope?: string;
    result?: Record<string, unknown>;
  }>();
  private deliveryChecks = new Map<string, Promise<Record<string, unknown> | undefined>>();
  private deliveryRequestIds = new Map<string, string>();
  private deliveryScope?: string;

  get unsettledDeliveries(): MessageDelivery[] {
    return [...this.deliveryRecords.values()].filter(record => record.scope === this.deliveryScope &&
      (record.status.state === 'unknown' || record.status.state === 'sending')).map(record => record.status);
  }

  getDelivery(id: string): MessageDelivery | undefined {
    return this.deliveryRecords.get(id)?.status;
  }
  serviceUnresponsive = false;
  private stopHealthWatch?: () => void;
  /** True while attempting to re-establish a dropped connection. */
  reconnecting = false;
  error?: string;
  lastError?: string;
  private closedIntentionally = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempts = 0;
  runStats: RunStats = {
    llmMs: 0,
    toolMs: 0,
    turns: 0,
    steps: 0,
    outputChars: 0,
  };
  /** Rolling delta samples {t, chars} for a recent-window rate. */
  deltaSamples: { t: number; n: number }[] = [];
  queue = { steering: [] as string[], followUp: [] as string[] };
  /** Index of the oldest loaded message within the full branch (0 = all loaded). */
  historyFrom = 0;
  totalMessages = 0;
  historyInFlight = false;
  private historyRequestId?: string;
  private historyRequest?: { before: number; sessionId: string; branchHeadId?: string };
  private historySeq = 0;
  private recentHistoryScheduled = false;
  private recentHistoryPaused = false;
  /** Active while a context compaction is running. */
  compaction?: { reason: string };
  /** Active while the provider request is being retried. */
  retry?: {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    errorMessage: string;
    since: number;
  };
  widgets: WidgetState[] = [];
  statuses: Record<string, string> = {};
  /** Non-persisted Pi status/warning/error rows anchored in the transcript. */
  transcriptNotices: TranscriptNotice[] = [];
  /** Increments for every notice, even when a consecutive info row is replaced. */
  transcriptNoticeRevision = 0;
  private noticeSeq = 0;
  private replaceableInfoNoticeId?: number;
  uiRequest?: UiRequest;
  editorUpdate?: { text: string; mode: "replace" | "append"; revision: number };
  quitRequested = false;
  customUi?: CustomUiFrame;
  /** Browser-only notifications; extension command output never enters this list. */
  toasts: { id: number; message: string; level: string }[] = [];
  private toastSeq = 0;

  constructor(
    public readonly cwd: string,
    public readonly sessionPath?: string,
    public readonly agent: string | undefined = getAgent(),
    public readonly requestedSessionId?: string,
  ) {
    // Agent identity is immutable for this Conversation; reconnects must never
    // jump to local or another remote workspace.
    const cacheKey = conversationSnapshotCacheKey(agent, cwd, sessionPath);
    const cached = cacheKey ? conversationStateCache.get(cacheKey) : undefined;
    if (cached && cacheKey) {
      setLruMapEntry(
        conversationStateCache,
        cacheKey,
        cached,
        CONVERSATION_STATE_CACHE_CAPACITY,
      );
      this.optimistic = cached.optimistic.map((item) => ({
        ...item,
        message: { ...item.message },
      }));
      this.optimisticSeq = Math.max(
        0,
        ...this.optimistic.map((item) => item.key),
      );
      this.streaming = normalizeStreamingMessage(cached.streaming);
      this.tools = new Map(
        (cached.activeTools ?? []).map((activity) => [
          activity.toolCallId,
          {
            ...activity,
            args: activity.args ? { ...activity.args } : undefined,
          },
        ]),
      );
      this.transcriptNotices = cached.transcriptNotices.map((notice) => ({
        ...notice,
      }));
      this.transcriptNoticeRevision = cached.transcriptNoticeRevision;
      this.noticeSeq = cached.noticeSeq;
      this.replaceableInfoNoticeId = cached.replaceableInfoNoticeId;
      // Seed the prior identity before reconciliation so a same-session cache
      // hydrate is not mistaken for new chat content that breaks showStatus().
      this.messages = [...cached.snapshot.messages];
      this.historyFrom = cached.snapshot.historyFrom ?? 0;
      this.totalMessages =
        cached.snapshot.totalMessages ?? cached.snapshot.messages.length;
      this.queue = {
        steering: [...(cached.snapshot.queue?.steering ?? [])],
        followUp: [...(cached.snapshot.queue?.followUp ?? [])],
      };
      this.snapshot = {
        ...cached.snapshot,
        messages: this.messages,
        queue: this.queue,
      };
      this.applySnapshot(cached.snapshot);
    }
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getRevision = (): number => this.revision;

  /** Wait for extension/resource initialization while keeping startup UI interactive. */
  waitUntilReady(timeoutMs = 60_000): Promise<void> {
    if (this.connected && isSessionSnapshotReady(this.snapshot))
      return Promise.resolve();
    if (this.closedIntentionally)
      return Promise.reject(new Error("conversation disposed"));
    if (this.error && !this.reconnecting) return Promise.reject(new Error(this.error));
    return this.readyWaiters.wait(timeoutMs);
  }

  private emit(): void {
    this.revision++;
    for (const fn of this.listeners) fn();
  }

  private enqueuePartialEvent(event: Record<string, unknown>): void {
    const receivedAt = Date.now();
    this.pendingPartialEvents = appendPartialEvent(
      this.pendingPartialEvents,
      event,
      receivedAt,
    );
    if (this.partialFlushTimer !== undefined) return;
    this.partialFlushTimer = setTimeout(() => {
      this.partialFlushTimer = undefined;
      this.flushPendingPartialEvents(true);
    }, PARTIAL_UPDATE_FLUSH_MS);
  }

  /** Apply queued visual deltas before any lifecycle/control event. */
  private flushPendingPartialEvents(shouldEmit: boolean): boolean {
    if (this.partialFlushTimer !== undefined) {
      clearTimeout(this.partialFlushTimer);
      this.partialFlushTimer = undefined;
    }
    if (this.pendingPartialEvents.length === 0) return false;
    const pending = this.pendingPartialEvents;
    this.pendingPartialEvents = [];
    for (const { event, receivedAt } of pending)
      this.applyEvent(event, receivedAt);
    if (shouldEmit) this.emit();
    return true;
  }

  connect(): void {
    if (this.closedIntentionally) return;
    if (!this.stopHealthWatch) this.stopHealthWatch = watchServiceHealth(async signal => {
      const response = await fetch(new URL(withAgent('/api/health', this.agent), location.href), { signal });
      if (!response.ok) throw new Error(`health: ${response.status}`);
    }, unresponsive => {
      if (this.serviceUnresponsive === unresponsive) return;
      this.serviceUnresponsive = unresponsive;
      this.emit();
    });
    clearTimeout(this.reconnectTimer);
    const proto = location.protocol === "https:" ? "wss" : "ws";
    // A stable Conversation can start blank or rebind via /new. Reconnect to
    // its current host, never the constructor's superseded session identity.
    const sessionPath = this.snapshot ? this.snapshot.sessionFile : this.sessionPath;
    const sessionId = this.snapshot ? this.snapshot.sessionId : this.requestedSessionId;
    let url = `${proto}://${location.host}/ws?snapshotDelta=1&cwd=${encodeURIComponent(this.snapshot?.cwd ?? this.cwd)}${
      sessionPath ? `&session=${encodeURIComponent(sessionPath)}` : ""
    }${
      !sessionPath && sessionId
        ? `&sessionId=${encodeURIComponent(sessionId)}`
        : ""
    }`;
    url = withAgent(url, this.agent);
    const ws = new WebSocket(url);
    this.ws = ws;
    this.connected = false;
    this.transportOpen = false;
    this.recentHistoryPaused = false;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.transportOpen = true;
      // The transport is open, but commands remain blocked until a ready
      // snapshot arrives. An earlier initializing snapshot may still carry UI.
      this.error = undefined;
      this.emit();
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      console.warn('[conversation] socket_closed', { code: ev.code, clean: ev.wasClean, ready: this.connected });
      this.flushPendingPartialEvents(false);
      this.connected = false;
      this.transportOpen = false;
      // fail all in-flight commands so the UI unblocks
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new CommandOutcomeUnknownError("connection closed"));
      }
      this.pending.clear();
      this.deliveryRequestIds.clear();
      this.historyInFlight = false;
      this.historyRequestId = undefined;
      this.historyRequest = undefined;
      this.recentHistoryPaused = true;
      if (!this.closedIntentionally) {
        this.error = `connection closed (${ev.code})`;
        this.readyWaiters.rejectAll(new Error(this.error));
        this.scheduleReconnect();
      }
      this.emit();
    };
    ws.onerror = () => {
      // onclose follows; handled there
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      try {
        this.handleMessage(JSON.parse(String(ev.data)) as ServerMessage);
      } catch (cause) {
        this.error =
          cause instanceof Error
            ? `invalid server message: ${cause.message}`
            : "invalid server message";
        this.emit();
      }
    };
  }

  private scheduleReconnect(): void {
    clearTimeout(this.reconnectTimer);
    this.reconnecting = true;
    this.reconnectAttempts += 1;
    const delay =
      Math.min(5000, 400 * 2 ** Math.min(this.reconnectAttempts - 1, 4)) +
      Math.random() * 400;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private syncSnapshotMessages(): void {
    if (!this.snapshot) return;
    this.snapshot = {
      ...this.snapshot,
      messages: [...this.messages],
      historyFrom: this.historyFrom,
      totalMessages: this.totalMessages,
    };
  }

  private cacheCurrentState(): void {
    if (!this.snapshot) return;
    this.syncSnapshotMessages();
    const activeTools = [...this.tools.values()]
      .filter((activity) => activity.running)
      .map((activity) => ({
        ...activity,
        args: activity.args ? { ...activity.args } : undefined,
      }));
    const snapshot =
      (this.streaming || activeTools.length > 0) && !this.snapshot.isStreaming
        ? { ...this.snapshot, isStreaming: true }
        : this.snapshot;
    const state: CachedConversationState = {
      snapshot,
      optimistic: this.optimistic.map((item) => ({
        ...item,
        message: { ...item.message },
      })),
      streaming: normalizeStreamingMessage(this.streaming),
      activeTools,
      transcriptNotices: this.transcriptNotices.map((notice) => ({ ...notice })),
      transcriptNoticeRevision: this.transcriptNoticeRevision,
      noticeSeq: this.noticeSeq,
      replaceableInfoNoticeId: this.replaceableInfoNoticeId,
    };
    for (const key of conversationStateCacheKeys(
      this.agent,
      this.cwd,
      this.sessionPath,
      this.snapshot.sessionFile,
    )) {
      setLruMapEntry(
        conversationStateCache,
        key,
        state,
        CONVERSATION_STATE_CACHE_CAPACITY,
      );
    }
  }

  requestQuit(): void {
    this.quitRequested = true;
    this.emit();
  }

  dispose(): void {
    this.transportOpen = false;
    this.stopHealthWatch?.();
    this.stopHealthWatch = undefined;
    this.flushPendingPartialEvents(false);
    this.cacheCurrentState();
    this.closedIntentionally = true;
    clearTimeout(this.reconnectTimer);
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new CommandOutcomeUnknownError("conversation disposed"));
    }
    this.pending.clear();
    this.deliveryRequestIds.clear();
    this.readyWaiters.rejectAll(new Error("conversation disposed"));
    this.ws?.close(1000);
    this.listeners.clear();
  }

  private currentTranscriptAnchor(): string | undefined {
    const messages = [
      ...this.messages,
      ...this.optimistic.map((item) => item.message),
      ...(this.streaming ? [this.streaming] : []),
    ];
    const last = messages.at(-1);
    return last ? messageTimelineKey(last, messages.length - 1) : undefined;
  }

  private breakTranscriptNoticeSequence(): void {
    this.replaceableInfoNoticeId = undefined;
  }

  private migrateTranscriptNoticeAnchors(
    replacements: readonly { from: string; to: string }[],
  ): void {
    if (replacements.length === 0) return;
    this.transcriptNotices = reanchorTranscriptNotices(
      this.transcriptNotices,
      replacements,
    );
  }

  private receiveTranscriptNotice(message: string, level: string): void {
    const update = applyTranscriptNotice(
      this.transcriptNotices,
      this.replaceableInfoNoticeId,
      {
        id: ++this.noticeSeq,
        message,
        level,
        afterMessageKey: this.currentTranscriptAnchor(),
      },
    );
    this.transcriptNotices = update.notices;
    this.replaceableInfoNoticeId = update.replaceableInfoId;
    this.transcriptNoticeRevision++;
  }

  private handleMessage(msg: ServerMessage): void {
    if (msg.type === "event" && isBatchablePartialEvent(msg.event)) {
      this.enqueuePartialEvent(msg.event);
      return;
    }
    const flushedPartials = this.flushPendingPartialEvents(false);
    if (msg.type === "snapshot") {
      const needsDeliveryRecovery = !this.connected || this.reconnecting ||
        !isSessionSnapshotReady(this.snapshot) || this.snapshot?.sessionId !== msg.snapshot.sessionId;
      this.connected = true;
      this.transportOpen = true;
      this.error = undefined;
      this.reconnecting = false;
      this.reconnectAttempts = 0;
      this.applySnapshot(msg.snapshot);
      if (isSessionSnapshotReady(msg.snapshot)) {
        this.readyWaiters.resolveAll();
        if (needsDeliveryRecovery) this.recheckDelivery();
        this.scheduleRecentHistory();
      }
    } else if (msg.type === "session_ready") {
      if (this.snapshot?.sessionId !== msg.snapshot.sessionId) {
        if (flushedPartials) this.emit();
        return;
      }
      const readyPaging = reconcileReadyPaging(
        this.snapshot,
        this.historyFrom,
        this.totalMessages,
        msg.snapshot,
      );
      this.connected = true;
      this.transportOpen = true;
      this.error = undefined;
      this.reconnecting = false;
      this.reconnectAttempts = 0;
      this.snapshot = {
        ...this.snapshot,
        ...msg.snapshot,
        pagingProvisional: false,
        messages: this.messages,
        // A pre-open raw preview knows only the visible suffix. No history
        // request can complete while initialization is pending, so the first
        // ready delta can safely replace its provisional paging metadata.
        historyFrom: readyPaging.historyFrom,
        totalMessages: readyPaging.totalMessages,
      };
      this.historyFrom = readyPaging.historyFrom;
      this.totalMessages = readyPaging.totalMessages;
      this.queue = {
        steering: [...(msg.snapshot.queue?.steering ?? [])],
        followUp: [...(msg.snapshot.queue?.followUp ?? [])],
      };
      if (!msg.snapshot.isStreaming) {
        this.streaming = undefined;
        this.tools = new Map(
          [...this.tools].map(([id, activity]) => [
            id,
            activity.running ? { ...activity, running: false } : activity,
          ]),
        );
      } else {
        const resumed = normalizeStreamingMessage(
          msg.snapshot.streamingMessage,
        );
        if (
          Object.prototype.hasOwnProperty.call(
            msg.snapshot,
            "streamingMessage",
          )
        )
          this.streaming = resumed;
        if (Array.isArray(msg.snapshot.activeToolCalls))
          this.tools = runningToolsFromSnapshot(msg.snapshot);
      }
      this.cacheCurrentState();
      this.readyWaiters.resolveAll();
      this.recheckDelivery();
      this.scheduleRecentHistory();
    } else if (msg.type === "event") {
      this.applyEvent(msg.event);
    } else if (msg.type === "widgets") {
      if (sameWidgets(this.widgets, msg.widgets)) {
        if (flushedPartials) this.emit();
        return;
      }
      this.widgets = msg.widgets;
    } else if (msg.type === "statuses") {
      if (sameStatuses(this.statuses, msg.statuses)) {
        if (flushedPartials) this.emit();
        return;
      }
      this.statuses = msg.statuses;
    } else if (msg.type === "toast") {
      // Despite the protocol name, Pi renders extension notifications in the
      // transcript. Only browser-owned notifications use the floating stack.
      this.receiveTranscriptNotice(msg.message, msg.level);
    } else if (msg.type === "history") {
      if (msg.requestId !== this.historyRequestId) {
        if (flushedPartials) this.emit();
        return;
      }
      const requested = this.historyRequest;
      this.historyInFlight = false;
      this.historyRequestId = undefined;
      this.historyRequest = undefined;
      if (
        !requested ||
        msg.sessionId !== requested.sessionId ||
        msg.branchHeadId !== requested.branchHeadId ||
        msg.sessionId !== this.snapshot?.sessionId ||
        msg.branchHeadId !== this.snapshot?.branchHeadId ||
        !Number.isInteger(msg.before) || msg.before < 0 ||
        msg.before >= requested.before ||
        msg.messages.length !== requested.before - msg.before
      ) {
        // Stop malformed/no-progress responses instead of repeatedly paging.
        this.recentHistoryPaused = true;
        this.emit();
        return;
      }
      this.messages = mergeHistoryMessages(
        this.messages,
        msg.messages.map(normalizeMessageContent),
      );
      this.historyFrom = Math.min(this.historyFrom, msg.before);
      this.syncSnapshotMessages();
      this.cacheCurrentState();
      this.scheduleRecentHistory();
    } else if (msg.type === "editor_text") {
      this.editorUpdate = { text: msg.text, mode: msg.mode, revision: (this.editorUpdate?.revision ?? 0) + 1 };
    } else if (msg.type === "ui_request") {
      this.uiRequest = msg.request;
    } else if (msg.type === "ui_close") {
      this.uiRequest = clearMatchingRequest(this.uiRequest, msg.requestId);
    } else if (msg.type === "custom_ui_frame") {
      if (!this.customUi || msg.frame.revision >= this.customUi.revision)
        this.customUi = msg.frame;
    } else if (msg.type === "custom_ui_close") {
      if (this.customUi?.requestId === msg.requestId) this.customUi = undefined;
    } else if (msg.type === "command_result") {
      const deliveryId = msg.id ? this.deliveryRequestIds.get(msg.id) : undefined;
      if (deliveryId) {
        this.deliveryRequestIds.delete(msg.id!);
        const record = this.deliveryRecords.get(deliveryId);
        if (record) record.result = retainedDeliveryData(msg.data);
        this.updateDelivery(deliveryId, msg.ok ? 'accepted' : 'failed', msg.error);
      }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.data);
        else p.reject(new Error(msg.error ?? "command failed"));
      }
      if (!msg.ok && msg.error) {
        this.breakTranscriptNoticeSequence();
        this.lastError = msg.error;
      }
    }
    this.emit();
  }

  private applySnapshot(snap: SessionSnapshot): void {
    snap = {
      ...snap,
      messages: snap.messages.map(normalizeMessageContent),
    };
    const previousAnchor = this.currentTranscriptAnchor();
    const previousMessages = this.messages;
    const previousOptimistic = this.optimistic;
    const previousSessionId = this.snapshot?.sessionId;
    const previousBranchHeadId = this.snapshot?.branchHeadId;
    const previousTotalMessages = this.totalMessages;
    if (
      this.historyInFlight &&
      (previousSessionId !== snap.sessionId ||
        previousBranchHeadId !== snap.branchHeadId)
    ) {
      this.historyInFlight = false;
      this.historyRequestId = undefined;
      this.historyRequest = undefined;
    }
    // Preserve A under A's canonical path before an in-host newSession rebinds
    // this Conversation to B.
    if (previousSessionId && previousSessionId !== snap.sessionId) {
      this.cacheCurrentState();
      this.recentHistoryPaused = false;
    }
    const staleSnapshot = isStaleConversationSnapshot(
      previousSessionId,
      previousBranchHeadId,
      previousTotalMessages,
      snap,
    );
    const merged = staleSnapshot
      ? { messages: this.messages, historyFrom: this.historyFrom }
      : mergeSnapshotMessages(this.messages, previousSessionId, snap, this.historyFrom);
    this.messages = merged.messages;
    this.historyFrom = merged.historyFrom;
    this.snapshot = {
      ...snap,
      messages: this.messages,
      historyFrom: this.historyFrom,
    };
    this.compaction = snap.compactionState?.status === 'running'
      ? { reason: snap.compactionState.reason } : undefined;
    this.totalMessages = staleSnapshot
      ? previousTotalMessages
      : (snap.totalMessages ?? snap.messages.length);
    this.queue = {
      steering: [...(snap.queue?.steering ?? [])],
      followUp: [...(snap.queue?.followUp ?? [])],
    };
    const hasStreamingCheckpoint = Object.prototype.hasOwnProperty.call(
      snap,
      "streamingMessage",
    );
    const resumedStreaming = normalizeStreamingMessage(snap.streamingMessage);
    if (previousSessionId && previousSessionId !== snap.sessionId) {
      this.streaming = snap.isStreaming ? resumedStreaming : undefined;
      this.runStats = { llmMs: 0, toolMs: 0, turns: 0, steps: 0, outputChars: 0 };
      this.deltaSamples = [];
      this.tools = new Map();
    } else if (!snap.isStreaming) {
      this.streaming = undefined;
      if (this.runStats.agentStartedAt && !this.runStats.endedAt)
        this.runStats.endedAt = Date.now();
      this.deltaSamples = [];
      this.tools = new Map(
        [...this.tools].map(([id, activity]) => [
          id,
          activity.running ? { ...activity, running: false } : activity,
        ]),
      );
    } else if (hasStreamingCheckpoint) {
      this.streaming = resumedStreaming;
    }
    if (snap.isStreaming && Array.isArray(snap.activeToolCalls))
      this.tools = runningToolsFromSnapshot(snap);
    if (previousSessionId && previousSessionId !== snap.sessionId) {
      this.optimistic = [];
      this.transcriptNotices = [];
      this.replaceableInfoNoticeId = undefined;
    } else {
      const reconciliation = reconcileOptimisticMessageState(
        previousOptimistic,
        this.messages,
        this.totalMessages,
      );
      const replacements = timestampAnchorReplacements(
        previousMessages,
        this.messages,
      );
      for (const match of reconciliation.matches) {
        const pending = previousOptimistic[match.pendingIndex];
        const finalized = this.messages[match.finalizedIndex];
        if (!pending || !finalized) continue;
        replacements.push({
          from: messageTimelineKey(
            pending.message,
            previousMessages.length + match.pendingIndex,
          ),
          to: messageTimelineKey(finalized, match.finalizedIndex),
        });
      }
      this.optimistic = reconciliation.remaining;
      this.migrateTranscriptNoticeAnchors(replacements);
      const migratedPreviousAnchor =
        replacements.find(({ from }) => from === previousAnchor)?.to ??
        previousAnchor;
      if (migratedPreviousAnchor !== this.currentTranscriptAnchor()) {
        this.breakTranscriptNoticeSequence();
      }
    }
    this.cacheCurrentState();
  }

  private applyEvent(
    event: Record<string, unknown>,
    now = Date.now(),
  ): void {
    const type = event.type as string;
    switch (type) {
      case "provider_request":
        if (this.snapshot) this.snapshot = { ...this.snapshot,
          providerRequest: (event.state ?? undefined) as SessionSnapshot['providerRequest'] };
        break;
      case "auto_retry_start":
        this.retry = {
          attempt: Number(event.attempt ?? 1),
          maxAttempts: Number(event.maxAttempts ?? 0),
          delayMs: Number(event.delayMs ?? 0),
          errorMessage: String(event.errorMessage ?? ""),
          since: now,
        };
        break;
      case "auto_retry_end":
        this.retry = undefined;
        break;
      case "compaction_start":
        this.compaction = { reason: String(event.reason ?? "manual") };
        if (this.snapshot) this.snapshot = { ...this.snapshot, providerRequest: undefined,
          compactionState: (event.compactionState ?? { status: 'running', reason: this.compaction.reason, startedAt: now }) as SessionSnapshot['compactionState'] };
        break;
      case "compaction_end":
        this.compaction = undefined;
        if (this.snapshot) this.snapshot = { ...this.snapshot, compactionState: (event.compactionState ?? null) as SessionSnapshot['compactionState'] };
        break;
      case "queue_update": {
        this.queue = {
          steering: [...((event.steering as string[]) ?? [])],
          followUp: [...((event.followUp as string[]) ?? [])],
        };
        const capabilities = event.queueCapabilities;
        const validCapabilities =
          capabilities &&
          typeof capabilities === "object" &&
          typeof (capabilities as { revision?: unknown }).revision === "number" &&
          typeof (capabilities as { reorder?: unknown }).reorder === "boolean" &&
          typeof (capabilities as { remove?: unknown }).remove === "boolean"
            ? (capabilities as SessionSnapshot["queueCapabilities"])
            : undefined;
        if (this.snapshot) {
          this.snapshot = synchronizeSnapshotQueue(
            this.snapshot,
            this.queue,
            validCapabilities,
          );
          this.cacheCurrentState();
        }
        break;
      }
      case "agent_start":
        this.runStats = {
          agentStartedAt: now,
          llmMs: 0,
          toolMs: 0,
          turns: 0,
          steps: 0,
          outputChars: 0,
        };
        this.deltaSamples = [];
        break;
      case "turn_start":
        this.runStats.turns += 1;
        break;
      case "message_start": {
        const message = event.message as PiiMessage | undefined;
        if (!message) break;
        this.breakTranscriptNoticeSequence();
        if (message.role === "assistant") {
          this.streaming = normalizeStreamingMessage(message);
        }
        break;
      }
      case "message_update": {
        const sub = event.assistantMessageEvent as StreamSub | undefined;
        const nextStreaming = reconcileStreamingMessage(this.streaming, event);
        if (!nextStreaming) break;
        this.streaming = nextStreaming;
        if (sub?.type === "text_delta" || sub?.type === "thinking_delta") {
          if (!this.runStats.firstDeltaAt) this.runStats.firstDeltaAt = now;
          this.runStats.outputChars += (sub.delta ?? "").length;
          this.deltaSamples.push({ t: now, n: (sub.delta ?? "").length });
          if (this.deltaSamples.length > 400)
            this.deltaSamples.splice(0, this.deltaSamples.length - 400);
        }
        break;
      }
      case "message_end": {
        const rawMessage = event.message as PiiMessage | undefined;
        if (!rawMessage) break;
        const message = normalizeMessageContent(rawMessage);
        this.breakTranscriptNoticeSequence();
        const replacements: { from: string; to: string }[] = [];
        let optimisticAnchor: string | undefined;
        if (message.role === "user" && this.optimistic.length > 0) {
          const text =
            typeof message.content === "string"
              ? message.content
              : Array.isArray(message.content)
                ? (message.content as { type?: string; text?: string }[])
                    .filter((b) => b.type === "text")
                    .map((b) => b.text ?? "")
                    .join("")
                : "";
          const idx = this.optimistic.findIndex((o) => o.text === text);
          if (idx !== -1) {
            optimisticAnchor = messageTimelineKey(
              this.optimistic[idx].message,
              this.messages.length + idx,
            );
            this.optimistic = [
              ...this.optimistic.slice(0, idx),
              ...this.optimistic.slice(idx + 1),
            ];
          }
        }
        const streaming = this.streaming;
        const streamingAnchor =
          streaming &&
          streaming.role === message.role &&
          (streaming as { timestamp?: unknown }).timestamp ===
            (message as { timestamp?: unknown }).timestamp
            ? messageTimelineKey(
                streaming,
                this.messages.length + this.optimistic.length,
              )
            : undefined;
        if (message.role === "assistant") this.streaming = undefined;
        // Replace a timestamp-only duplicate with the persisted entry identity.
        const lastIndex = this.messages.length - 1;
        const last = this.messages[lastIndex];
        const dup = Boolean(
          last && sameMessageTimelineIdentity(last, message),
        );
        const previousDuplicateAnchor = dup && last
          ? messageTimelineKey(last, lastIndex)
          : undefined;
        if (dup) {
          this.messages = [...this.messages.slice(0, lastIndex), message];
        } else {
          this.messages = [...this.messages, message];
          this.totalMessages = Math.max(
            this.totalMessages + 1,
            this.messages.length,
          );
        }
        const finalizedIndex = this.messages.length - 1;
        const finalizedAnchor = messageTimelineKey(message, finalizedIndex);
        for (const from of [
          optimisticAnchor,
          streamingAnchor,
          previousDuplicateAnchor,
        ]) {
          if (from && from !== finalizedAnchor)
            replacements.push({ from, to: finalizedAnchor });
        }
        this.migrateTranscriptNoticeAnchors(replacements);
        this.syncSnapshotMessages();
        this.cacheCurrentState();
        break;
      }
      case "tool_execution_start": {
        const id = String(event.toolCallId ?? "");
        this.tools = new Map(this.tools);
        this.tools.set(id, {
          toolCallId: id,
          toolName: String(event.toolName ?? ""),
          args: event.args as Record<string, unknown>,
          running: true,
          startedAt: now,
        });
        break;
      }
      case "tool_execution_update": {
        const id = String(event.toolCallId ?? "");
        const t = this.tools.get(id);
        if (t) {
          this.tools = new Map(this.tools);
          this.tools.set(id, {
            ...t,
            liveOutput: stripAnsi(
              extractText(event.partialResult ?? event.update),
            ),
          });
        }
        break;
      }
      case "tool_execution_end": {
        const id = String(event.toolCallId ?? "");
        const t = this.tools.get(id);
        if (t) {
          this.runStats.steps += 1;
          if (t.startedAt) this.runStats.toolMs += now - t.startedAt;
          this.tools = new Map(this.tools);
          this.tools.set(id, {
            ...t,
            running: false,
            isError: Boolean(event.isError),
            endedAt: now,
          });
        }
        break;
      }
      case "agent_end":
        if (this.runStats.agentStartedAt) {
          this.runStats.endedAt = now;
          this.runStats.llmMs = Math.max(
            0,
            now - this.runStats.agentStartedAt - this.runStats.toolMs,
          );
        }
        break;
      case "agent_settled":
        if (this.snapshot) this.snapshot = { ...this.snapshot, providerRequest: undefined };
        this.retry = undefined;
        if (this.runStats.agentStartedAt && !this.runStats.endedAt)
          this.runStats.endedAt = now;
        this.deltaSamples = [];
        break;
    }
  }

  /** Surface an error to the message area. */
  reportError(message: string): void {
    this.breakTranscriptNoticeSequence();
    this.lastError = message;
    this.emit();
  }

  /** Dismiss the persistent message-area error without changing connection state. */
  clearError(): void {
    if (!this.lastError) return;
    this.lastError = undefined;
    this.emit();
  }

  /** Add or replace Pi-style command output in the transcript. */
  showTranscriptNotice(message: string, level = "info"): void {
    this.receiveTranscriptNotice(message, level);
    this.emit();
  }

  /** Browser-owned transient notification, intentionally separate from Pi output. */
  toast(message: string, level = "info"): void {
    const notification = { id: ++this.toastSeq, message, level };
    this.toasts = [...this.toasts, notification];
    setTimeout(() => {
      this.toasts = this.toasts.filter((item) => item.id !== notification.id);
      this.emit();
    }, 4000);
    this.emit();
  }

  /** Immediately render a user message locally; deduped when the server echoes it. */
  addOptimistic(
    text: string,
    images?: { data: string; mimeType: string }[],
  ): number {
    this.breakTranscriptNoticeSequence();
    const key = ++this.optimisticSeq;
    const content = images?.length
      ? [
          ...images.map((img) => ({
            type: "image",
            data: img.data,
            mimeType: img.mimeType,
          })),
          ...(text ? [{ type: "text", text }] : []),
        ]
      : text;
    this.optimistic = [
      ...this.optimistic,
      {
        key,
        text,
        baseTotalMessages: this.totalMessages,
        message: {
          role: "user",
          content,
          timestamp: Date.now(),
          _pending: true,
        } as PiiMessage,
      },
    ];
    this.cacheCurrentState();
    this.emit();
    return key;
  }

  removeOptimistic(key: number): void {
    this.optimistic = this.optimistic.filter((o) => o.key !== key);
    this.cacheCurrentState();
    this.emit();
  }


  answerUi(value: unknown): void {
    const req = this.uiRequest;
    if (!req) return;
    this.uiRequest = undefined;
    void this.send({ type: "ui_response", requestId: req.id, value }).catch(
      () => undefined,
    );
  }

  customUiInput(data: string): void {
    const requestId = this.customUi?.requestId;
    if (!requestId || !data || data.length > 8192) return;
    this.sendNotification({ type: "custom_ui_input", requestId, data });
  }

  customUiResize(width: number): void {
    const requestId = this.customUi?.requestId;
    if (!requestId) return;
    this.sendNotification({ type: "custom_ui_resize", requestId, width });
  }

  cancelCustomUi(): void {
    const requestId = this.customUi?.requestId;
    if (!requestId) return;
    this.sendNotification({ type: "custom_ui_cancel", requestId });
  }

  syncEditorText(text: string): void { this.sendNotification({ type: "editor_state", text }); }

  private sendNotification(cmd: ClientCommand): void {
    const ws = this.ws;
    if (this.connected && ws?.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify(cmd));
  }

  /** Fill the recent visible transcript after readiness, without blocking prompts. */
  private scheduleRecentHistory(): void {
    if (this.recentHistoryScheduled || this.recentHistoryPaused) return;
    this.recentHistoryScheduled = true;
    queueMicrotask(() => {
      this.recentHistoryScheduled = false;
      if (this.closedIntentionally || this.recentHistoryPaused ||
          !this.connected || !isSessionSnapshotReady(this.snapshot) ||
          this.snapshot?.pagingProvisional === true || this.historyInFlight ||
          this.historyFrom <= 0 || hasRecentVisibleMessages(this.messages)) return;
      this.loadOlder(true);
    });
  }

  loadOlder(automatic = false): void {
    if (this.historyFrom <= 0 || this.historyInFlight || !this.snapshot ||
        !this.connected || !isSessionSnapshotReady(this.snapshot)) return;
    if (!automatic) this.recentHistoryPaused = false;
    const requestId = `history-${++this.historySeq}`;
    this.historyInFlight = true;
    this.historyRequestId = requestId;
    this.historyRequest = {
      before: this.historyFrom,
      sessionId: this.snapshot.sessionId,
      branchHeadId: this.snapshot.branchHeadId,
    };
    void this.send({
      type: "history",
      before: this.historyFrom,
      requestId,
    }).catch(() => {
      if (this.historyRequestId !== requestId) return;
      this.historyInFlight = false;
      this.historyRequestId = undefined;
      this.historyRequest = undefined;
      this.recentHistoryPaused = true;
      this.emit();
    });
    this.emit();
  }

  async stop(): Promise<void> {
    const sessionId = this.snapshot?.sessionId ?? this.requestedSessionId;
    if (!sessionId) {
      await this.send({ type: 'abort' });
      return;
    }
    const response = await fetch(new URL(withAgent('/api/sessions/stop', this.agent), location.href), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }), signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error ?? `stop: ${response.status}`);
    if (this.closedIntentionally || this.snapshot?.sessionId !== sessionId) return;
    // Success is acknowledged only after the server's stop settlement succeeds.
    if (this.snapshot) this.snapshot = { ...this.snapshot, isStreaming: false };
    this.streaming = undefined;
    this.emit();
  }

  private modelSelectionRevision = 0;

  async selectModel(provider: string, modelId: string): Promise<void> {
    const revision = ++this.modelSelectionRevision;
    await this.waitUntilReady();
    if (revision !== this.modelSelectionRevision) return;
    await this.send({ type: 'setModel', provider, modelId });
  }

  send(cmd: ClientCommand): Promise<Record<string, unknown> | undefined> {
    if (cmd.type === 'prompt' || cmd.type === 'steer' || cmd.type === 'followUp' || cmd.type === 'slash')
      return this.sendDelivery(cmd);
    return this.sendRequest(cmd);
  }

  private updateDelivery(id: string, state: MessageDelivery['state'], error?: string): void {
    const record = this.deliveryRecords.get(id);
    if (!record) return;
    if ((record.status.state === 'accepted' || record.status.state === 'failed') &&
        (state === 'sending' || state === 'unknown')) return;
    record.status = { ...record.status, state, error: error?.slice(0, 4096), updatedAt: Date.now() };
    if (record.scope === this.deliveryScope && (!this.delivery || this.delivery.id === id)) this.delivery = record.status;
    if (state === 'accepted' || state === 'failed') {
      for (const [requestId, deliveryId] of this.deliveryRequestIds)
        if (deliveryId === id) this.deliveryRequestIds.delete(requestId);
    }
    this.persistDeliveries(record.scope);
    this.emit();
  }

  private syncDeliveryScope(): void {
    if (!this.snapshot?.sessionId) return;
    const scope = JSON.stringify([this.agent ?? '', this.snapshot.cwd, this.snapshot.sessionId]);
    if (scope === this.deliveryScope) return;
    this.persistDeliveries();
    this.deliveryScope = scope;
    this.delivery = undefined;
    for (const { fingerprint, ...status } of readDeliveries(scope)) {
      if (!this.deliveryRecords.has(status.id))
        this.deliveryRecords.set(status.id, { status, fingerprint, sessionId: this.snapshot.sessionId, scope });
      this.delivery = this.deliveryRecords.get(status.id)!.status;
    }
  }

  private persistDeliveries(scope = this.deliveryScope): void {
    if (!scope) return;
    writeDeliveries(scope, [...this.deliveryRecords.values()].flatMap(({ status, fingerprint, scope: owner }) =>
      owner === scope && (status.state === 'sending' || status.state === 'unknown')
        ? [{ ...status, state: status.state, fingerprint }] : []));
  }

  private async sendDelivery(cmd: MessageCommand): Promise<Record<string, unknown> | undefined> {
    this.syncDeliveryScope();
    const sessionId = this.snapshot?.sessionId;
    const scope = this.deliveryScope;
    const { deliveryId: _providedId, ...payload } = cmd;
    // Queue mode can legitimately change after reconnecting to a running host;
    // it must not make the same user message look like a new delivery.
    const fingerprintValue = deliveryFingerprintForSend(payload.type === 'prompt'
      ? { type: payload.type, message: payload.message, images: payload.images } : payload);
    const fingerprint = typeof fingerprintValue === 'string' ? fingerprintValue : await fingerprintValue;
    if (this.closedIntentionally) throw new DeliveryNotSentError('disposed');
    if (sessionId !== this.snapshot?.sessionId || scope !== this.deliveryScope)
      throw new DeliveryNotSentError('session_changed');
    // An interrupted acknowledgement is not a rejection. Repeated clicks for
    // that same payload ask about the original ID instead of submitting again.
    for (const record of this.deliveryRecords.values()) {
      if (record.sessionId === sessionId && record.fingerprint === fingerprint &&
          (record.status.state === 'sending' || record.status.state === 'unknown')) {
        this.delivery = record.status;
        try {
          const result = await this.checkDelivery(record.status.id);
          return { ...result, deliveryAlreadySubmitted: true };
        } catch (cause) {
          if (cause instanceof DeliveryUnknownError) throw new DeliveryUnknownError(record.status.id, true);
          throw cause;
        }
      }
    }
    if (this.unsettledDeliveries.length >= 64 || (this.deliveryScope && !canRecordDelivery(this.deliveryScope)))
      throw new Error('Too many unconfirmed messages; check existing deliveries before sending more.');
    // Use a browser-global random ID; request IDs such as c1 collide between
    // tabs, new Conversation instances and page reloads.
    // getRandomValues also works on a trusted local-network HTTP deployment,
    // where randomUUID/subtle may be unavailable outside a secure context.
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
    const status: MessageDelivery = { id, type: cmd.type, state: 'sending', updatedAt: Date.now() };
    this.deliveryRecords.set(id, { status, fingerprint, sessionId, scope });
    this.delivery = status;
    this.persistDeliveries();
    // Keep unknown receipts available for safety; discard only settled entries.
    if (this.deliveryRecords.size > 64) {
      for (const [key, record] of this.deliveryRecords) {
        if (this.deliveryRecords.size <= 64) break;
        if (record.status.state === 'accepted' || record.status.state === 'failed') this.deliveryRecords.delete(key);
      }
    }
    this.emit();
    try {
      const result = await this.sendRequest({ ...payload, deliveryId: id });
      const record = this.deliveryRecords.get(id);
      if (record) record.result = retainedDeliveryData(result);
      this.updateDelivery(id, 'accepted');
      return result;
    } catch (cause) {
      if (cause instanceof CommandOutcomeUnknownError) {
        this.updateDelivery(id, 'unknown');
        throw new DeliveryUnknownError(id);
      }
      this.updateDelivery(id, 'failed', cause instanceof Error ? cause.message : String(cause));
      throw cause;
    }
  }

  /** Only queries a receipt. Never resends a possibly accepted message. */
  checkDelivery(id = this.delivery?.id): Promise<Record<string, unknown> | undefined> {
    if (!id) return Promise.resolve(undefined);
    const existing = this.deliveryChecks.get(id);
    if (existing) return existing;
    const record = this.deliveryRecords.get(id);
    if (!record || record.sessionId !== this.snapshot?.sessionId)
      return Promise.reject(new DeliveryUnknownError(id));
    if (record.status.state === 'accepted') return Promise.resolve(record.result);
    if (record.status.state === 'failed') return Promise.reject(new Error(record.status.error ?? 'command failed'));
    const check = (async () => {
      try {
        const status = await this.sendRequest({ type: 'delivery_status', deliveryId: id });
        // A delayed initial ACK may arrive while the lookup itself is running.
        if (record.status.state === 'accepted') return record.result;
        if (record.status.state === 'failed') throw new Error(record.status.error ?? 'command failed');
        const result = status?.result as { ok?: boolean; error?: string; data?: Record<string, unknown> } | undefined;
        if (status?.state === 'accepted' && result?.ok === true) {
          record.result = retainedDeliveryData(result.data);
          this.updateDelivery(id, 'accepted');
          return result.data;
        }
        if (status?.state === 'failed' && result?.ok === false) {
          this.updateDelivery(id, 'failed', result.error ?? 'command failed');
          throw new Error(result.error ?? 'command failed');
        }
        this.updateDelivery(id, status?.state === 'sending' ? 'sending' : 'unknown');
      } catch (cause) {
        if (record.status.state === 'failed') throw cause;
        this.updateDelivery(id, 'unknown');
      }
      throw new DeliveryUnknownError(id);
    })().finally(() => this.deliveryChecks.delete(id));
    this.deliveryChecks.set(id, check);
    return check;
  }

  private recheckDelivery(): void {
    this.syncDeliveryScope();
    for (const delivery of this.unsettledDeliveries)
      void this.checkDelivery(delivery.id).catch(() => {});
  }

  private sendRequest(cmd: ClientCommand): Promise<Record<string, unknown> | undefined> {
    const ws = this.ws;
    if ((!this.connected && cmd.type !== 'abort') || !ws || ws.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("session is not ready"));
    const id = `c${++this.commandSeq}`;
    if ('deliveryId' in cmd && cmd.type !== 'delivery_status') {
      this.deliveryRequestIds.set(id, cmd.deliveryId!);
      // Keep late ACK recovery bounded even if every request times out on an
      // otherwise open socket. Receipts remain queryable after map eviction.
      if (this.deliveryRequestIds.size > 256) this.deliveryRequestIds.delete(this.deliveryRequestIds.keys().next().value!);
    }
    const timeoutMs = cmd.type === 'delivery_status' ? 10_000
      : cmd.type === "slash" ? 12 * 60_000 : COMMAND_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new CommandOutcomeUnknownError(
            `command ${cmd.type} timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ id, ...cmd }));
      } catch (cause) {
        clearTimeout(timer);
        this.pending.delete(id);
        this.deliveryRequestIds.delete(id);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  }
}
