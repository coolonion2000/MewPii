import type {
  ClientCommand,
  PiiMessage,
  ProjectGroup,
  ServerMessage,
  SessionSnapshot,
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
  update?: unknown;
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
  private pending = new Map<string, { resolve: (ok: boolean) => void; reject: (e: Error) => void }>();

  snapshot?: SessionSnapshot;
  /** Finalized messages (from snapshot / message_end). */
  messages: PiiMessage[] = [];
  /** In-flight assistant message being streamed. */
  streaming?: PiiMessage;
  /** Live tool execution states keyed by toolCallId. */
  tools = new Map<string, ToolActivity>();
  connected = false;
  error?: string;
  lastError?: string;

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
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws?cwd=${encodeURIComponent(this.cwd)}${
      this.sessionPath ? `&session=${encodeURIComponent(this.sessionPath)}` : ''
    }`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.error = undefined;
      this.emit();
    };
    ws.onclose = (ev) => {
      this.connected = false;
      if (ev.code !== 1000) this.error = `connection closed (${ev.code})`;
      this.emit();
    };
    ws.onerror = () => {
      this.error = 'connection error';
      this.emit();
    };
    ws.onmessage = (ev) => this.handleMessage(JSON.parse(String(ev.data)) as ServerMessage);
  }

  dispose(): void {
    this.ws?.close(1000);
    this.listeners.clear();
  }

  private handleMessage(msg: ServerMessage): void {
    if (msg.type === 'snapshot') {
      this.applySnapshot(msg.snapshot);
    } else if (msg.type === 'event') {
      this.applyEvent(msg.event);
    } else if (msg.type === 'command_result') {
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.ok) p.resolve(true);
        else p.reject(new Error(msg.error ?? 'command failed'));
      }
      if (!msg.ok && msg.error) this.lastError = msg.error;
    }
    this.emit();
  }

  private applySnapshot(snap: SessionSnapshot): void {
    this.snapshot = snap;
    this.messages = snap.messages;
    if (!snap.isStreaming) {
      this.streaming = undefined;
      for (const t of this.tools.values()) t.running = false;
    }
  }

  private applyEvent(event: Record<string, unknown>): void {
    const type = event.type as string;
    switch (type) {
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
        });
        this.tools = new Map(this.tools);
        break;
      }
      case 'tool_execution_update': {
        const id = String(event.toolCallId ?? '');
        const t = this.tools.get(id);
        if (t) {
          t.update = event.partialResult ?? event.update;
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
          this.tools = new Map(this.tools);
        }
        break;
      }
    }
  }

  send(cmd: ClientCommand): Promise<boolean> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('not connected'));
    const id = `c${++this.commandSeq}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, ...cmd }));
    });
  }
}
