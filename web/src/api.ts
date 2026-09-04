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
import {
  appendPartialEvent,
  isBatchablePartialEvent,
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
let modelsGeneration = 0;

/** Deduplicate Composer/Settings model discovery across rapid view changes. */
export async function fetchModels(force = false): Promise<ModelsResponse> {
  if (force) {
    modelsCache = undefined;
    modelsRequest = undefined;
    modelsGeneration += 1;
  }
  if (
    modelsCache &&
    Date.now() - modelsCache.loadedAt < MODELS_CACHE_TTL_MS
  )
    return modelsCache.value;
  if (modelsRequest) return modelsRequest;
  const generation = modelsGeneration;
  const loading = fetch("/api/models").then(async (res) => {
    if (!res.ok) throw new Error(`models: ${res.status}`);
    const value = (await res.json()) as ModelsResponse;
    if (generation === modelsGeneration)
      modelsCache = { value, loadedAt: Date.now() };
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
  firstDeltaAt?: number;
  llmMs: number;
  toolMs: number;
  turns: number;
  steps: number;
  outputChars: number;
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
  private historySeq = 0;
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
  customUi?: CustomUiFrame;
  /** Browser-only notifications; extension command output never enters this list. */
  toasts: { id: number; message: string; level: string }[] = [];
  private toastSeq = 0;

  constructor(
    public readonly cwd: string,
    public readonly sessionPath?: string,
    public readonly agent: string | undefined = getAgent(),
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
    if (this.error) return Promise.reject(new Error(this.error));
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
    clearTimeout(this.reconnectTimer);
    const proto = location.protocol === "https:" ? "wss" : "ws";
    let url = `${proto}://${location.host}/ws?snapshotDelta=1&cwd=${encodeURIComponent(this.cwd)}${
      this.sessionPath ? `&session=${encodeURIComponent(this.sessionPath)}` : ""
    }`;
    url = withAgent(url, this.agent);
    const ws = new WebSocket(url);
    this.ws = ws;
    this.connected = false;
    ws.onopen = () => {
      // The transport is open, but commands remain blocked until a ready
      // snapshot arrives. An earlier initializing snapshot may still carry UI.
      this.error = undefined;
      this.emit();
    };
    ws.onclose = (ev) => {
      this.flushPendingPartialEvents(false);
      const wasConnected = this.connected;
      this.connected = false;
      // fail all in-flight commands so the UI unblocks
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("connection closed"));
      }
      this.pending.clear();
      this.historyInFlight = false;
      this.historyRequestId = undefined;
      if (!this.closedIntentionally) {
        this.error = `connection closed (${ev.code})`;
        this.readyWaiters.rejectAll(new Error(this.error));
        if (ev.code !== 1000 || wasConnected) this.scheduleReconnect();
      }
      this.emit();
    };
    ws.onerror = () => {
      // onclose follows; handled there
    };
    ws.onmessage = (ev) => {
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
    this.reconnecting = true;
    this.reconnectAttempts += 1;
    const delay =
      Math.min(15000, 800 * 2 ** Math.min(this.reconnectAttempts, 5)) +
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
    const state: CachedConversationState = {
      snapshot: this.snapshot,
      optimistic: this.optimistic.map((item) => ({
        ...item,
        message: { ...item.message },
      })),
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

  dispose(): void {
    this.flushPendingPartialEvents(false);
    this.cacheCurrentState();
    this.closedIntentionally = true;
    clearTimeout(this.reconnectTimer);
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("conversation disposed"));
    }
    this.pending.clear();
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
      this.connected = true;
      this.reconnecting = false;
      this.reconnectAttempts = 0;
      this.applySnapshot(msg.snapshot);
      if (isSessionSnapshotReady(msg.snapshot)) this.readyWaiters.resolveAll();
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
      this.cacheCurrentState();
      this.readyWaiters.resolveAll();
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
      this.historyInFlight = false;
      this.historyRequestId = undefined;
      if (
        msg.sessionId !== this.snapshot?.sessionId ||
        msg.branchHeadId !== this.snapshot?.branchHeadId
      ) {
        this.emit();
        return;
      }
      this.messages = mergeHistoryMessages(this.messages, msg.messages);
      this.historyFrom = msg.before;
      this.syncSnapshotMessages();
      this.cacheCurrentState();
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
    }
    // Preserve A under A's canonical path before an in-host newSession rebinds
    // this Conversation to B.
    if (previousSessionId && previousSessionId !== snap.sessionId) {
      this.cacheCurrentState();
    }
    const staleSnapshot = isStaleConversationSnapshot(
      previousSessionId,
      previousBranchHeadId,
      previousTotalMessages,
      snap,
    );
    const merged = staleSnapshot
      ? { messages: this.messages, historyFrom: this.historyFrom }
      : mergeSnapshotMessages(this.messages, previousSessionId, snap);
    this.messages = merged.messages;
    this.historyFrom = merged.historyFrom;
    this.snapshot = {
      ...snap,
      messages: this.messages,
      historyFrom: this.historyFrom,
    };
    this.totalMessages = staleSnapshot
      ? previousTotalMessages
      : (snap.totalMessages ?? snap.messages.length);
    this.queue = {
      steering: [...(snap.queue?.steering ?? [])],
      followUp: [...(snap.queue?.followUp ?? [])],
    };
    if (!snap.isStreaming) {
      this.streaming = undefined;
      this.runStats.agentStartedAt = undefined;
      this.deltaSamples = [];
      this.tools = new Map(
        [...this.tools].map(([id, activity]) => [
          id,
          activity.running ? { ...activity, running: false } : activity,
        ]),
      );
    }
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
        break;
      case "compaction_end":
        this.compaction = undefined;
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
          this.streaming = { ...message, content: [] };
        }
        break;
      }
      case "message_update": {
        const sub = event.assistantMessageEvent as StreamSub | undefined;
        if (!sub || !this.streaming) break;
        const content =
          (this.streaming.content as Record<string, unknown>[]) ?? [];
        const idx = sub.contentIndex ?? 0;
        if (sub.type === "text_start" || sub.type === "thinking_start") {
          content[idx] =
            sub.type === "text_start"
              ? { type: "text", text: "" }
              : { type: "thinking", thinking: "" };
        } else if (sub.type === "text_delta" || sub.type === "thinking_delta") {
          const block = content[idx] as Record<string, unknown> | undefined;
          const key = sub.type === "text_delta" ? "text" : "thinking";
          if (block) block[key] = String(block[key] ?? "") + (sub.delta ?? "");
          if (!this.runStats.firstDeltaAt) this.runStats.firstDeltaAt = now;
          this.runStats.outputChars += (sub.delta ?? "").length;
          this.deltaSamples.push({ t: now, n: (sub.delta ?? "").length });
          if (this.deltaSamples.length > 400)
            this.deltaSamples.splice(0, this.deltaSamples.length - 400);
        } else if (sub.type === "toolcall_start") {
          content[idx] = {
            type: "toolCall",
            id: `pending-${idx}`,
            name: "",
            arguments: {},
          };
        } else if (sub.type === "toolcall_end" && sub.toolCall) {
          content[idx] = sub.toolCall;
        }
        this.streaming = { ...this.streaming, content: [...content] };
        break;
      }
      case "message_end": {
        const message = event.message as PiiMessage | undefined;
        if (!message) break;
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
          this.runStats.llmMs = Math.max(
            0,
            now - this.runStats.agentStartedAt - this.runStats.toolMs,
          );
        }
        break;
      case "agent_settled":
        this.runStats.agentStartedAt = undefined;
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

  private sendNotification(cmd: ClientCommand): void {
    const ws = this.ws;
    if (this.connected && ws?.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify(cmd));
  }

  loadOlder(): void {
    if (this.historyFrom <= 0 || this.historyInFlight || !this.snapshot) return;
    const requestId = `history-${++this.historySeq}`;
    this.historyInFlight = true;
    this.historyRequestId = requestId;
    void this.send({
      type: "history",
      before: this.historyFrom,
      requestId,
    }).catch(() => {
      if (this.historyRequestId !== requestId) return;
      this.historyInFlight = false;
      this.historyRequestId = undefined;
      this.emit();
    });
    this.emit();
  }

  send(cmd: ClientCommand): Promise<Record<string, unknown> | undefined> {
    const ws = this.ws;
    if (!this.connected || !ws || ws.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("session is not ready"));
    const id = `c${++this.commandSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `command ${cmd.type} timed out after ${COMMAND_TIMEOUT_MS}ms`,
          ),
        );
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ id, ...cmd }));
      } catch (cause) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  }
}
