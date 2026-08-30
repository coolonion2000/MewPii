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
  clearMatchingRequest,
  fixedAgentUrl,
  mergeHistoryMessages,
  mergeSnapshotMessages,
} from "./state-utils";

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

export async function fetchProjects(signal?: AbortSignal): Promise<ProjectGroup[]> {
  const res = await fetch("/api/sessions", { signal });
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

export async function fetchModels(): Promise<ModelsResponse> {
  const res = await fetch("/api/models");
  if (!res.ok) throw new Error(`models: ${res.status}`);
  return (await res.json()) as ModelsResponse;
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

// Last-known snapshot per conversation, shown instantly on revisit while the
// fresh snapshot streams in (stale-while-revalidate).
const snapshotCache = new Map<string, SessionSnapshot>();
const COMMAND_TIMEOUT_MS = 120_000;

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

  snapshot?: SessionSnapshot;
  /** Finalized messages (from snapshot / message_end). */
  messages: PiiMessage[] = [];
  /** Optimistically rendered user messages awaiting server echo (remote latency). */
  optimistic: { key: number; text: string; message: PiiMessage }[] = [];
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
  uiRequest?: UiRequest;
  customUi?: CustomUiFrame;
  toasts: { id: number; message: string; level: string }[] = [];
  private toastSeq = 0;

  constructor(
    public readonly cwd: string,
    public readonly sessionPath?: string,
    public readonly agent: string | undefined = getAgent(),
  ) {
    // Agent identity is immutable for this Conversation; reconnects must never
    // jump to local or another remote workspace.
    const cached = snapshotCache.get(
      `${agent ?? "local"}|${cwd}|${sessionPath ?? ""}`,
    );
    if (cached) this.applySnapshot(cached);
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getRevision = (): number => this.revision;

  private emit(): void {
    this.revision++;
    for (const fn of this.listeners) fn();
  }

  connect(): void {
    if (this.closedIntentionally) return;
    clearTimeout(this.reconnectTimer);
    const proto = location.protocol === "https:" ? "wss" : "ws";
    let url = `${proto}://${location.host}/ws?cwd=${encodeURIComponent(this.cwd)}${
      this.sessionPath ? `&session=${encodeURIComponent(this.sessionPath)}` : ""
    }`;
    url = withAgent(url, this.agent);
    const ws = new WebSocket(url);
    this.ws = ws;
    this.connected = false;
    ws.onopen = () => {
      // The transport is open, but commands remain blocked until the host's
      // first snapshot proves that session initialization completed.
      this.error = undefined;
      this.emit();
    };
    ws.onclose = (ev) => {
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
        if (ev.code !== 1000 || wasConnected) this.scheduleReconnect();
        else this.error = `connection closed (${ev.code})`;
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

  dispose(): void {
    this.closedIntentionally = true;
    clearTimeout(this.reconnectTimer);
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("conversation disposed"));
    }
    this.pending.clear();
    this.ws?.close(1000);
    this.listeners.clear();
  }

  private handleMessage(msg: ServerMessage): void {
    if (msg.type === "snapshot") {
      this.connected = true;
      this.reconnecting = false;
      this.reconnectAttempts = 0;
      this.applySnapshot(msg.snapshot);
      const cacheKey = this.agent ?? "local";
      snapshotCache.set(
        `${cacheKey}|${this.cwd}|${this.sessionPath ?? ""}`,
        this.snapshot!,
      );
      if (msg.snapshot.sessionFile) {
        snapshotCache.set(
          `${cacheKey}|${this.cwd}|${msg.snapshot.sessionFile}`,
          this.snapshot!,
        );
      }
    } else if (msg.type === "event") {
      this.applyEvent(msg.event);
    } else if (msg.type === "widgets") {
      this.widgets = msg.widgets;
    } else if (msg.type === "statuses") {
      this.statuses = msg.statuses;
    } else if (msg.type === "toast") {
      const id = ++this.toastSeq;
      this.toasts = [
        ...this.toasts,
        { id, message: msg.message, level: msg.level },
      ];
      setTimeout(() => {
        this.toasts = this.toasts.filter((t) => t.id !== id);
        this.emit();
      }, 5000);
    } else if (msg.type === "history") {
      if (msg.requestId !== this.historyRequestId) return;
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
      if (this.snapshot)
        this.snapshot = {
          ...this.snapshot,
          messages: this.messages,
          historyFrom: this.historyFrom,
        };
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
      if (!msg.ok && msg.error) this.lastError = msg.error;
    }
    this.emit();
  }

  private applySnapshot(snap: SessionSnapshot): void {
    const previousSessionId = this.snapshot?.sessionId;
    const previousBranchHeadId = this.snapshot?.branchHeadId;
    if (
      this.historyInFlight &&
      (previousSessionId !== snap.sessionId ||
        previousBranchHeadId !== snap.branchHeadId)
    ) {
      this.historyInFlight = false;
      this.historyRequestId = undefined;
    }
    const merged = mergeSnapshotMessages(
      this.messages,
      previousSessionId,
      snap,
    );
    this.messages = merged.messages;
    this.historyFrom = merged.historyFrom;
    this.snapshot = {
      ...snap,
      messages: this.messages,
      historyFrom: this.historyFrom,
    };
    this.totalMessages = snap.totalMessages ?? snap.messages.length;
    this.queue = {
      steering: [...(snap.queue?.steering ?? [])],
      followUp: [...(snap.queue?.followUp ?? [])],
    };
    if (!snap.isStreaming) {
      this.streaming = undefined;
      this.runStats.agentStartedAt = undefined;
      this.deltaSamples = [];
      for (const t of this.tools.values()) t.running = false;
    }
  }

  private applyEvent(event: Record<string, unknown>): void {
    const type = event.type as string;
    const now = Date.now();
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
      case "queue_update":
        this.queue = {
          steering: [...((event.steering as string[]) ?? [])],
          followUp: [...((event.followUp as string[]) ?? [])],
        };
        break;
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
            this.optimistic = [
              ...this.optimistic.slice(0, idx),
              ...this.optimistic.slice(idx + 1),
            ];
          }
        }
        if (message.role === "assistant") this.streaming = undefined;
        // Avoid duplicates when a snapshot already carried this message.
        const last = this.messages[this.messages.length - 1];
        const dup =
          last &&
          last.role === message.role &&
          (last as { timestamp?: number }).timestamp ===
            (message as { timestamp?: number }).timestamp;
        if (!dup) this.messages = [...this.messages, message];
        break;
      }
      case "tool_execution_start": {
        const id = String(event.toolCallId ?? "");
        this.tools.set(id, {
          toolCallId: id,
          toolName: String(event.toolName ?? ""),
          args: event.args as Record<string, unknown>,
          running: true,
          startedAt: now,
        });
        this.tools = new Map(this.tools);
        break;
      }
      case "tool_execution_update": {
        const id = String(event.toolCallId ?? "");
        const t = this.tools.get(id);
        if (t) {
          t.liveOutput = stripAnsi(
            extractText(event.partialResult ?? event.update),
          );
          this.tools = new Map(this.tools);
        }
        break;
      }
      case "tool_execution_end": {
        const id = String(event.toolCallId ?? "");
        const t = this.tools.get(id);
        if (t) {
          t.running = false;
          t.isError = Boolean(event.isError);
          t.endedAt = now;
          this.runStats.steps += 1;
          if (t.startedAt) this.runStats.toolMs += now - t.startedAt;
          this.tools = new Map(this.tools);
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
    this.lastError = message;
    this.emit();
  }

  /** Dismiss the persistent message-area error without changing connection state. */
  clearError(): void {
    if (!this.lastError) return;
    this.lastError = undefined;
    this.emit();
  }

  /** Transient toast. */
  toast(message: string, level = "info"): void {
    const id = ++this.toastSeq;
    this.toasts = [...this.toasts, { id, message, level }];
    setTimeout(() => {
      this.toasts = this.toasts.filter((t) => t.id !== id);
      this.emit();
    }, 4000);
    this.emit();
  }

  /** Immediately render a user message locally; deduped when the server echoes it. */
  addOptimistic(
    text: string,
    images?: { data: string; mimeType: string }[],
  ): number {
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
        message: {
          role: "user",
          content,
          timestamp: Date.now(),
          _pending: true,
        } as PiiMessage,
      },
    ];
    this.emit();
    return key;
  }

  removeOptimistic(key: number): void {
    this.optimistic = this.optimistic.filter((o) => o.key !== key);
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
