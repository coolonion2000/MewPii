import type {
  ClientCommand,
  PiiMessage,
  ProjectGroup,
  ServerMessage,
  SessionSnapshot,
  UiRequest,
  WidgetState,
} from './types';

export async function fetchProjects(): Promise<ProjectGroup[]> {
  const res = await fetch('/api/sessions');
  if (!res.ok) throw new Error(`sessions: ${res.status}`);
  const data = (await res.json()) as { projects: ProjectGroup[] };
  return data.projects;
}

export async function deleteSession(path: string): Promise<void> {
  const res = await fetch(`/api/sessions?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`delete: ${res.status}`);
}

export interface ModelsResponse {
  providers: { id: string; name: string; configured: boolean; authSource?: string; modelCount: number }[];
  models: import('./types').ModelInfoLite[];
}

export async function fetchModels(): Promise<ModelsResponse> {
  const res = await fetch('/api/models');
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
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const content = (value as { content?: unknown }).content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((b) => (b as { type?: string; text?: string }))
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('\n');
    }
  }
  return '';
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:\[[0-9;?]*[a-zA-Z]|\][^\x07]*\x07|\([0-9A-B])/g;
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

interface StreamSub {
  type: string;
  contentIndex?: number;
  delta?: string;
  content?: string;
  toolCall?: { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> };
  message?: PiiMessage;
}

export class Conversation {
  private ws?: WebSocket;
  private listeners = new Set<() => void>();
  private commandSeq = 0;
  private pending = new Map<string, { resolve: (data: Record<string, unknown> | undefined) => void; reject: (e: Error) => void }>();

  snapshot?: SessionSnapshot;
  /** Finalized messages (from snapshot / message_end). */
  messages: PiiMessage[] = [];
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
  runStats: RunStats = { llmMs: 0, toolMs: 0, turns: 0, steps: 0, outputChars: 0 };
  /** Rolling delta samples {t, chars} for a recent-window rate. */
  deltaSamples: { t: number; n: number }[] = [];
  queue = { steering: [] as string[], followUp: [] as string[] };
  /** Index of the oldest loaded message within the full branch (0 = all loaded). */
  historyFrom = 0;
  totalMessages = 0;
  /** Active while a context compaction is running. */
  compaction?: { reason: string };
  widgets: WidgetState[] = [];
  statuses: Record<string, string> = {};
  uiRequest?: UiRequest;
  toasts: { id: number; message: string; level: string }[] = [];
  private toastSeq = 0;

  constructor(
    public readonly cwd: string,
    public readonly sessionPath?: string,
  ) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  connect(): void {
    if (this.closedIntentionally) return;
    clearTimeout(this.reconnectTimer);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws?cwd=${encodeURIComponent(this.cwd)}${
      this.sessionPath ? `&session=${encodeURIComponent(this.sessionPath)}` : ''
    }`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.reconnecting = false;
      this.reconnectAttempts = 0;
      this.error = undefined;
      this.emit();
    };
    ws.onclose = (ev) => {
      const wasConnected = this.connected;
      this.connected = false;
      // fail all in-flight commands so the UI unblocks
      for (const [, p] of this.pending) p.reject(new Error('connection closed'));
      this.pending.clear();
      if (!this.closedIntentionally) {
        if (ev.code !== 1000 || wasConnected) this.scheduleReconnect();
        else this.error = `connection closed (${ev.code})`;
      }
      this.emit();
    };
    ws.onerror = () => {
      // onclose follows; handled there
    };
    ws.onmessage = (ev) => this.handleMessage(JSON.parse(String(ev.data)) as ServerMessage);
  }

  private scheduleReconnect(): void {
    this.reconnecting = true;
    this.reconnectAttempts += 1;
    const delay = Math.min(15000, 800 * 2 ** Math.min(this.reconnectAttempts, 5)) + Math.random() * 400;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  dispose(): void {
    this.closedIntentionally = true;
    clearTimeout(this.reconnectTimer);
    this.ws?.close(1000);
    this.listeners.clear();
  }

  private handleMessage(msg: ServerMessage): void {
    if (msg.type === 'snapshot') {
      this.applySnapshot(msg.snapshot);
    } else if (msg.type === 'event') {
      this.applyEvent(msg.event);
    } else if (msg.type === 'widgets') {
      this.widgets = msg.widgets;
    } else if (msg.type === 'statuses') {
      this.statuses = msg.statuses;
    } else if (msg.type === 'toast') {
      const id = ++this.toastSeq;
      this.toasts = [...this.toasts, { id, message: msg.message, level: msg.level }];
      setTimeout(() => {
        this.toasts = this.toasts.filter((t) => t.id !== id);
        this.emit();
      }, 5000);
    } else if (msg.type === 'history') {
      // prepend older page
      this.messages = [...msg.messages, ...this.messages];
      this.historyFrom = msg.before;
    } else if (msg.type === 'ui_request') {
      this.uiRequest = msg.request;
    } else if (msg.type === 'command_result') {
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.data);
        else p.reject(new Error(msg.error ?? 'command failed'));
      }
      if (!msg.ok && msg.error) this.lastError = msg.error;
    }
    this.emit();
  }

  private applySnapshot(snap: SessionSnapshot): void {
    this.snapshot = snap;
    this.messages = snap.messages;
    this.historyFrom = snap.historyFrom ?? 0;
    this.totalMessages = snap.totalMessages ?? snap.messages.length;
    this.queue = { steering: [...(snap.queue?.steering ?? [])], followUp: [...(snap.queue?.followUp ?? [])] };
    if (!snap.isStreaming) {
      this.streaming = undefined;
      for (const t of this.tools.values()) t.running = false;
    }
  }

  private applyEvent(event: Record<string, unknown>): void {
    const type = event.type as string;
    const now = Date.now();
    switch (type) {
      case 'compaction_start':
        this.compaction = { reason: String(event.reason ?? 'manual') };
        break;
      case 'compaction_end':
        this.compaction = undefined;
        break;
      case 'queue_update':
        this.queue = {
          steering: [...((event.steering as string[]) ?? [])],
          followUp: [...((event.followUp as string[]) ?? [])],
        };
        break;
      case 'agent_start':
        this.runStats = { agentStartedAt: now, llmMs: 0, toolMs: 0, turns: 0, steps: 0, outputChars: 0 };
        this.deltaSamples = [];
        break;
      case 'turn_start':
        this.runStats.turns += 1;
        break;
      case 'message_start': {
        const message = event.message as PiiMessage | undefined;
        if (!message) break;
        if (message.role === 'assistant') {
          this.streaming = { ...message, content: [] };
        }
        break;
      }
      case 'message_update': {
        const sub = event.assistantMessageEvent as StreamSub | undefined;
        if (!sub || !this.streaming) break;
        const content = (this.streaming.content as Record<string, unknown>[]) ?? [];
        const idx = sub.contentIndex ?? 0;
        if (sub.type === 'text_start' || sub.type === 'thinking_start') {
          content[idx] =
            sub.type === 'text_start' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' };
        } else if (sub.type === 'text_delta' || sub.type === 'thinking_delta') {
          const block = content[idx] as Record<string, unknown> | undefined;
          const key = sub.type === 'text_delta' ? 'text' : 'thinking';
          if (block) block[key] = String(block[key] ?? '') + (sub.delta ?? '');
          if (!this.runStats.firstDeltaAt) this.runStats.firstDeltaAt = now;
          this.runStats.outputChars += (sub.delta ?? '').length;
          this.deltaSamples.push({ t: now, n: (sub.delta ?? '').length });
          if (this.deltaSamples.length > 400) this.deltaSamples.splice(0, this.deltaSamples.length - 400);
        } else if (sub.type === 'toolcall_start') {
          content[idx] = { type: 'toolCall', id: `pending-${idx}`, name: '', arguments: {} };
        } else if (sub.type === 'toolcall_end' && sub.toolCall) {
          content[idx] = sub.toolCall;
        }
        this.streaming = { ...this.streaming, content: [...content] };
        break;
      }
      case 'message_end': {
        const message = event.message as PiiMessage | undefined;
        if (!message) break;
        if (message.role === 'assistant') this.streaming = undefined;
        // Avoid duplicates when a snapshot already carried this message.
        const last = this.messages[this.messages.length - 1];
        const dup =
          last &&
          last.role === message.role &&
          (last as { timestamp?: number }).timestamp === (message as { timestamp?: number }).timestamp;
        if (!dup) this.messages = [...this.messages, message];
        break;
      }
      case 'tool_execution_start': {
        const id = String(event.toolCallId ?? '');
        this.tools.set(id, {
          toolCallId: id,
          toolName: String(event.toolName ?? ''),
          args: event.args as Record<string, unknown>,
          running: true,
          startedAt: now,
        });
        this.tools = new Map(this.tools);
        break;
      }
      case 'tool_execution_update': {
        const id = String(event.toolCallId ?? '');
        const t = this.tools.get(id);
        if (t) {
          t.liveOutput = stripAnsi(extractText(event.partialResult ?? event.update));
          this.tools = new Map(this.tools);
        }
        break;
      }
      case 'tool_execution_end': {
        const id = String(event.toolCallId ?? '');
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
      case 'agent_end':
        if (this.runStats.agentStartedAt) {
          this.runStats.llmMs = Math.max(0, now - this.runStats.agentStartedAt - this.runStats.toolMs);
        }
        break;
    }
  }

  /** Surface an error to the message area. */
  reportError(message: string): void {
    this.lastError = message;
    this.emit();
  }

  /** Transient toast. */
  toast(message: string, level = 'info'): void {
    const id = ++this.toastSeq;
    this.toasts = [...this.toasts, { id, message, level }];
    setTimeout(() => {
      this.toasts = this.toasts.filter((t) => t.id !== id);
      this.emit();
    }, 4000);
    this.emit();
  }

  answerUi(value: unknown): void {
    const req = this.uiRequest;
    if (!req) return;
    this.uiRequest = undefined;
    void this.send({ type: 'ui_response', requestId: req.id, value }).catch(() => undefined);
  }

  loadOlder(): void {
    if (this.historyFrom > 0) void this.send({ type: 'history', before: this.historyFrom }).catch(() => undefined);
  }

  send(cmd: ClientCommand): Promise<Record<string, unknown> | undefined> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('not connected'));
    const id = `c${++this.commandSeq}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, ...cmd }));
    });
  }
}
