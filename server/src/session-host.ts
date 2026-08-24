import { statSync, watch, type FSWatcher } from 'node:fs';
import type { WebSocket } from 'ws';
import {
  createAgentSessionFromServices,
  createBashTool,
  createCodingTools,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadOnlyTools,
  createWriteTool,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntime,
} from '@earendil-works/pi-coding-agent';
import type { ClientCommand, ServerMessage, SessionSnapshot, UiRequest, WidgetState } from './protocol.js';

/** Strip the huge `partial` message from streaming events; keep everything else JSON-passthrough. */
function serializeEvent(event: AgentSessionEvent): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(event, (key, value) => (key === 'partial' ? undefined : value)),
  ) as Record<string, unknown>;
}


/** Read the last JSONL entry's id without loading the whole file. */
async function lastEntryId(file: string): Promise<string | undefined> {
  const { open } = await import('node:fs/promises');
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, 8192);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    const lines = buf.toString('utf-8').split('\n').filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const e = JSON.parse(lines[i]) as { id?: string };
        if (e.id) return e.id;
      } catch {
        // partial tail line; keep looking
      }
    }
    return undefined;
  } finally {
    await fh.close();
  }
}

export interface SessionHostOptions {
  cwd: string;
  /** Existing session file to open; omit to create a fresh session. */
  sessionPath?: string;
  onEmpty?: (host: SessionHost) => void;
}

/**
 * One SessionHost owns one AgentSessionRuntime (one conversation) and fans
 * events out to any number of attached browser WebSockets.
 */
export class SessionHost {
  private constructor(
    public readonly key: string,
    private runtime: AgentSessionRuntime,
    private modelRegistry: ModelRegistry,
    private onEmpty?: (host: SessionHost) => void,
  ) {}

  private sockets = new Set<WebSocket>();
  private unsubscribe?: () => void;
  private idleTimer?: NodeJS.Timeout;
  /** Extension-provided widgets (string-lines form) keyed by widget key. */
  private widgets = new Map<string, WidgetState>();
  /** Extension-provided status bar entries. */
  private statuses = new Map<string, string>();
  /** Pending extension dialogs awaiting a browser answer. */
  private uiPending = new Map<string, (value: unknown) => void>();
  /** Last observed prompt queue (from queue_update events). */
  private queue = { steering: [] as string[], followUp: [] as string[] };
  /** Currently executing tool calls (toolCallId → name/args), for ui.custom dialogs. */
  private activeToolCalls = new Map<string, { toolName: string; args: Record<string, unknown> }>();
  /** Full branch message list from the latest snapshot (for history paging). */
  private lastBranch: Record<string, unknown>[] = [];
  private fileWatcher?: FSWatcher;
  private settledMtime = 0;
  private reloading = false;
  private cooldownUntil = 0;

  static async create(key: string, opts: SessionHostOptions): Promise<SessionHost> {
    const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }: {
      cwd: string;
      sessionManager: SessionManager;
      sessionStartEvent?: never;
    }) => {
      const services = await createAgentSessionServices({ cwd });
      return {
        ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
        services,
        diagnostics: services.diagnostics,
      };
    };

    const runtime = await createAgentSessionRuntime(createRuntime as never, {
      cwd: opts.cwd,
      agentDir: getAgentDir(),
      sessionManager: opts.sessionPath
        ? SessionManager.open(opts.sessionPath, undefined, opts.cwd)
        : SessionManager.create(opts.cwd),
    });

    const modelRegistry = new ModelRegistry(runtime.services.modelRuntime);
    const host = new SessionHost(key, runtime, modelRegistry, opts.onEmpty);

    runtime.setRebindSession(async (session) => {
      host.bindSession();
      host.broadcastSnapshot();
      await host.bindExtensionUi(session);
    });
    host.bindSession();
    await host.bindExtensionUi(runtime.session);
    host.startFileWatch();
    return host;
  }

  /** Reload from disk when an external process (e.g. pi CLI) writes our file. */
  private startFileWatch(): void {
    const file = this.runtime.session.sessionFile;
    if (!file) return;
    try {
      // Baseline is the file's current mtime — anything newer is external.
      const { mtimeMs } = statSync(file);
      this.settledMtime = mtimeMs;
      let timer: NodeJS.Timeout | undefined;
      this.fileWatcher = watch(file, () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          void this.reloadIfExternal();
        }, 1500);
      });
    } catch {
      // file may not exist yet (brand-new session)
    }
  }

  private async reloadIfExternal(): Promise<void> {
    const file = this.runtime.session.sessionFile;
    if (!file || this.runtime.session.isStreaming || this.reloading) return;
    if (Date.now() < this.cooldownUntil) return;
    this.reloading = true;
    try {
      const { mtimeMs } = await import('node:fs/promises').then((fs) => fs.stat(file));
      // isStreaming already covers our own writes; any newer mtime is external.
      if (mtimeMs <= this.settledMtime + 10) return;
      // Content check: the file's last entry must be one we don't already have.
      // Our own reload/append side-effects share our known leaf id — skip those.
      const tailId = await lastEntryId(file);
      const knownLeaf = this.runtime.session.sessionManager.getLeafId();
      if (tailId && tailId === knownLeaf) {
        this.settledMtime = mtimeMs;
        return;
      }
      console.log('[watch] external change detected, reloading', file);
      await this.runtime.switchSession(file);
      const after = await import('node:fs/promises').then((fs) => fs.stat(file));
      this.settledMtime = Math.max(after.mtimeMs, Date.now());
      // blind window: the reload's own side-effects settle here; external bursts
      // (e.g. a pi CLI run) debounce to one reload per burst.
      this.cooldownUntil = Date.now() + 2000;
      this.broadcastSnapshot();
    } catch (err) {
      console.log('[watch] reload failed:', err instanceof Error ? err.message : String(err));
    } finally {
      this.reloading = false;
    }
  }

  /** Bridge pi's extension UI surface (widgets, status, dialogs, toasts) to web clients. */
  private async bindExtensionUi(session: AgentSession): Promise<void> {
    const host = this;
    try {
      await session.bindExtensions({
        mode: 'tui',
        uiContext: {
          custom: async () => {
            // Tool-aware custom dialog: the extension tool executing right now
            // tells us its args; render the matching web dialog and answer with
            // the shape the tool expects.
            const active = [...host.activeToolCalls.values()].pop();
            if (!active) return null;
            if (active.toolName === 'question') {
              const args = active.args as { question?: string; options?: { label: string; description?: string }[] };
              const answer = await host.uiRequest<unknown>({
                kind: 'question',
                title: args.question ?? 'question',
                payload: { question: args.question, options: args.options ?? [] },
              });
              return answer ?? null;
            }
            if (active.toolName === 'questionnaire') {
              const args = active.args as { questions?: { label?: string; prompt: string; options: { label: string; description?: string }[]; allowOther?: boolean }[] };
              const questions = (args.questions ?? []).map((q, i) => ({
                label: q.label ?? `Q${i + 1}`,
                prompt: q.prompt,
                options: q.options ?? [],
                allowOther: q.allowOther !== false,
              }));
              const answer = await host.uiRequest<unknown>({
                kind: 'questionnaire',
                title: 'questionnaire',
                payload: { questions },
              });
              if (!answer) return { questions, answers: [], cancelled: true };
              return answer;
            }
            return null;
          },
          select(title: string, options: readonly string[], opts?: { timeout?: number }) {
            return host.uiRequest<string | undefined>({ kind: 'select', title, options: [...options] }, opts?.timeout);
          },
          async confirm(title: string, message: string, opts?: { timeout?: number }) {
            const v = await host.uiRequest<string | boolean | undefined>({ kind: 'confirm', title, message }, opts?.timeout);
            return v === true;
          },
          async input(title: string, placeholder: string | undefined, opts?: { timeout?: number }) {
            const v = await host.uiRequest<string | undefined>({ kind: 'input', title, placeholder }, opts?.timeout);
            return typeof v === 'string' ? v : undefined;
          },
          notify(message: string, type?: 'info' | 'warning' | 'error') {
            host.broadcast({ type: 'toast', message, level: type ?? 'info' });
          },
          onTerminalInput() {
            return () => undefined;
          },
          setStatus(key: string, text: string | undefined) {
            if (text === undefined) host.statuses.delete(key);
            else host.statuses.set(key, text);
            host.broadcastStatuses();
          },
          setWorkingMessage() {},
          setFooter() {},
          setHeader() {},
          setTitle() {},
          setWorkingVisible() {},
          setWorkingIndicator() {},
          setHiddenThinkingLabel() {},
          setWidget(key: string, content: unknown, options?: { placement?: 'aboveEditor' | 'belowEditor' }) {
            if (Array.isArray(content) && content.every((l) => typeof l === 'string')) {
              host.widgets.set(key, { key, lines: content as string[], placement: options?.placement ?? 'aboveEditor' });
            } else {
              // undefined clears; TUI component factories cannot render on web
              host.widgets.delete(key);
            }
            host.broadcastWidgets();
          },
        } as never,
      });
    } catch {
      // Extensions are optional; a failing binding must not break the session.
    }
  }

  private uiRequest<T>(req: Omit<UiRequest, 'id'>, timeoutMs?: number): Promise<T> {
    const id = crypto.randomUUID();
    return new Promise<T>((resolvePromise) => {
      const timer = setTimeout(() => {
        this.uiPending.delete(id);
        resolvePromise(undefined as T);
      }, timeoutMs ?? 5 * 60_000);
      this.uiPending.set(id, (value) => {
        clearTimeout(timer);
        resolvePromise(value as T);
      });
      this.broadcast({ type: 'ui_request', request: { id, ...req } });
    });
  }

  private broadcastWidgets(): void {
    this.broadcast({ type: 'widgets', widgets: [...this.widgets.values()] });
  }

  private broadcastStatuses(): void {
    this.broadcast({ type: 'statuses', statuses: Object.fromEntries(this.statuses) });
  }

  private bindSession(): void {
    this.unsubscribe?.();
    const session = this.runtime.session;
    let pendingSnapshot: NodeJS.Timeout | undefined;
    this.unsubscribe = session.subscribe((event) => {
      this.broadcast({ type: 'event', event: serializeEvent(event) });
      // Keep late-joining clients consistent after meaningful state changes.
      // agent_end fires before the session manager finishes appending entries,
      // so defer the snapshot slightly; agent_settled marks full quiescence.
      if (event.type === 'agent_end') {
        clearTimeout(pendingSnapshot);
        pendingSnapshot = setTimeout(() => {
          this.settledMtime = Date.now();
          this.broadcastSnapshot();
        }, 150);
      } else if (
        event.type === 'agent_settled' ||
        event.type === 'session_info_changed' ||
        event.type === 'thinking_level_changed' ||
        event.type === 'compaction_end'
      ) {
        clearTimeout(pendingSnapshot);
        this.broadcastSnapshot();
      }
      // Track the prompt queue so snapshots reflect it for late joiners.
      if (event.type === 'tool_execution_start') {
        const e = event as unknown as { toolCallId?: string; toolName?: string; args?: Record<string, unknown> };
        if (e.toolCallId) this.activeToolCalls.set(e.toolCallId, { toolName: e.toolName ?? '', args: e.args ?? {} });
      }
      if (event.type === 'tool_execution_end') {
        const e = event as unknown as { toolCallId?: string };
        if (e.toolCallId) this.activeToolCalls.delete(e.toolCallId);
      }
      if (event.type === 'queue_update') {
        const q = event as unknown as { steering?: readonly string[]; followUp?: readonly string[] };
        this.queue = {
          steering: [...(q.steering ?? [])],
          followUp: [...(q.followUp ?? [])],
        };
      }
    });
  }

  get session(): AgentSession {
    return this.runtime.session;
  }

  /** Import a JSONL session into this host's runtime. */
  async runtime_import(inputPath: string): Promise<{ ok: boolean; sessionFile?: string; error?: string }> {
    try {
      const r = await this.runtime.importFromJsonl(inputPath);
      this.broadcastSnapshot();
      return { ok: !r.cancelled, sessionFile: this.runtime.session.sessionFile, error: r.cancelled ? 'cancelled' : undefined };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  get cwd(): string {
    return this.runtime.cwd;
  }

  get services(): AgentSessionRuntime['services'] {
    return this.runtime.services;
  }

  attach(ws: WebSocket): void {
    clearTimeout(this.idleTimer);
    this.sockets.add(ws);
    this.send(ws, { type: 'snapshot', snapshot: this.snapshot() });
    this.send(ws, { type: 'widgets', widgets: [...this.widgets.values()] });
    this.send(ws, { type: 'statuses', statuses: Object.fromEntries(this.statuses) });
  }

  detach(ws: WebSocket): void {
    this.sockets.delete(ws);
    if (this.sockets.size === 0) {
      // Dispose the runtime after a grace period with no viewers.
      this.idleTimer = setTimeout(() => {
        if (this.sockets.size === 0) {
          void this.dispose().finally(() => this.onEmpty?.(this));
        }
      }, 5 * 60_000);
    }
  }

  get isRunning(): boolean {
    return this.session.isStreaming;
  }

  snapshot(): SessionSnapshot {
    const s = this.session;
    const model = s.model;

    // Build the visible message list from session-file entries so each
    // message carries its entry id (needed for fork / branch actions).
    let messages: Record<string, unknown>[] = [];
    try {
      const branch = s.sessionManager.getBranch();
      for (const entry of branch) {
        const e = entry as { type?: string; id?: string; message?: unknown };
        if (e.type === 'message' && e.message && typeof e.message === 'object') {
          messages.push({ ...(e.message as Record<string, unknown>), _entryId: e.id });
        }
      }
    } catch {
      // fall through to agent state
    }
    if (messages.length === 0) {
      messages = JSON.parse(JSON.stringify(s.messages)) as Record<string, unknown>[];
    }

    // Keep the full branch around for history paging.
    this.lastBranch = messages;
    const total = messages.length;
    const from = Math.max(0, total - 150);
    const page = messages.slice(from);

    let stats: SessionSnapshot['stats'];
    try {
      const st = s.getSessionStats();
      stats = {
        userMessages: st.userMessages,
        assistantMessages: st.assistantMessages,
        toolCalls: st.toolCalls,
        tokens: { ...st.tokens },
        cost: st.cost,
        contextTokens: st.contextUsage?.tokens ?? null,
        contextWindow: st.contextUsage?.contextWindow ?? null,
        contextPercent: st.contextUsage?.percent ?? null,
      };
    } catch {
      stats = undefined;
    }

    return {
      sessionId: s.sessionId,
      sessionFile: s.sessionFile,
      name: s.sessionName,
      cwd: this.runtime.cwd,
      isStreaming: s.isStreaming,
      thinkingLevel: s.thinkingLevel,
      model: model
        ? { provider: model.provider, id: model.id, name: model.name ?? model.id }
        : undefined,
      messages: page as SessionSnapshot['messages'],
      totalMessages: total,
      historyFrom: from,
      queue: {
        steering: [...s.getSteeringMessages()],
        followUp: [...s.getFollowUpMessages()],
      },
      stats,
      tools: s.agent.state.tools.map((tool) => tool.name),
    };
  }

  async handleCommand(cmd: ClientCommand & { id?: string }): Promise<{ ok: boolean; error?: string; data?: Record<string, unknown> }> {
    const s = this.session;
    try {
      switch (cmd.type) {
        case 'prompt':
          await s.prompt(cmd.message, {
            images: cmd.images?.map((img) => ({ type: 'image' as const, data: img.data, mimeType: img.mimeType })),
            streamingBehavior: s.isStreaming ? cmd.streamingBehavior ?? 'steer' : undefined,
          });
          return { ok: true };
        case 'steer':
          await s.steer(cmd.message);
          return { ok: true };
        case 'followUp':
          await s.followUp(cmd.message);
          return { ok: true };
        case 'abort':
          await s.abort();
          return { ok: true };
        case 'newSession': {
          const r = await this.runtime.newSession();
          this.broadcastSnapshot();
          return { ok: !r.cancelled, error: r.cancelled ? 'cancelled' : undefined };
        }
        case 'fork': {
          const r = await this.runtime.fork(cmd.entryId, { position: cmd.position ?? 'at' });
          this.broadcastSnapshot();
          return {
            ok: !r.cancelled,
            error: r.cancelled ? 'cancelled' : undefined,
            data: { sessionFile: this.runtime.session.sessionFile },
          };
        }
        case 'setModel': {
          const model = this.modelRegistry.find(cmd.provider, cmd.modelId);
          if (!model) return { ok: false, error: `model not found: ${cmd.provider}/${cmd.modelId}` };
          await s.setModel(model);
          this.broadcastSnapshot();
          return { ok: true };
        }
        case 'setThinkingLevel':
          s.setThinkingLevel(cmd.level as never);
          this.broadcastSnapshot();
          return { ok: true };
        case 'setSessionName':
          s.setSessionName(cmd.name);
          return { ok: true };
        case 'branch': {
          const r = await s.navigateTree(cmd.entryId, { summarize: cmd.summarize ?? false });
          this.broadcastSnapshot();
          return {
            ok: !r.cancelled,
            error: r.cancelled ? 'cancelled' : undefined,
            data: { editorText: r.editorText },
          };
        }
        case 'compact':
          await s.compact();
          return { ok: true };
        case 'queue_remove': {
          const current = [...(cmd.queue === 'steering' ? s.getSteeringMessages() : s.getFollowUpMessages())];
          if (cmd.index < 0 || cmd.index >= current.length) return { ok: false, error: 'index out of range' };
          current.splice(cmd.index, 1);
          s.clearQueue();
          for (const m of current) {
            if (cmd.queue === 'steering') await s.steer(m);
            else await s.followUp(m);
          }
          this.broadcastSnapshot();
          return { ok: true };
        }
        case 'queue_move': {
          const src = [...(cmd.from === 'steering' ? s.getSteeringMessages() : s.getFollowUpMessages())];
          if (cmd.index < 0 || cmd.index >= src.length) return { ok: false, error: 'index out of range' };
          const [moved] = src.splice(cmd.index, 1);
          const dst = [...(cmd.to === 'steering' ? s.getSteeringMessages() : s.getFollowUpMessages())];
          dst.push(moved);
          s.clearQueue();
          for (const m of src) {
            if (cmd.from === 'steering') await s.steer(m);
            else await s.followUp(m);
          }
          for (const m of dst) {
            if (cmd.to === 'steering') await s.steer(m);
            else await s.followUp(m);
          }
          this.broadcastSnapshot();
          return { ok: true };
        }
        case 'setToolMode': {
          const BUILTIN = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];
          const cwd = this.runtime.cwd;
          let defs: { name: string }[];
          if (cmd.mode === 'off') defs = [];
          else if (cmd.mode === 'read-only') defs = createReadOnlyTools(cwd);
          else if (cmd.mode === 'default') defs = createCodingTools(cwd);
          else defs = [createBashTool(cwd), createEditTool(cwd), createWriteTool(cwd), createGrepTool(cwd), createFindTool(cwd), createLsTool(cwd), ...createCodingTools(cwd).filter((tool) => tool.name === 'read')];
          // preserve extension/custom tools, replace the builtin set
          const preserved = s.agent.state.tools.filter((tool) => !BUILTIN.includes(tool.name));
          s.agent.state.tools = [...preserved, ...(defs as never[])];
          this.broadcastSnapshot();
          return { ok: true };
        }
        case 'history': {
          const before = Math.max(0, Math.min(cmd.before, this.lastBranch.length));
          const from = Math.max(0, before - 150);
          const page = this.lastBranch.slice(from, before);
          this.broadcast({ type: 'history', messages: page as never, before: from });
          return { ok: true };
        }
        case 'queue_clear':
          s.clearQueue();
          this.broadcastSnapshot();
          return { ok: true };
        case 'ui_response': {
          const resolve = this.uiPending.get(cmd.requestId);
          if (!resolve) return { ok: false, error: 'no pending request' };
          this.uiPending.delete(cmd.requestId);
          resolve(cmd.value);
          return { ok: true };
        }
        default:
          return { ok: false, error: `unknown command` };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  broadcast(msg: ServerMessage): void {
    for (const ws of this.sockets) this.send(ws, msg);
  }

  broadcastSnapshot(): void {
    this.broadcast({ type: 'snapshot', snapshot: this.snapshot() });
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  async dispose(): Promise<void> {
    clearTimeout(this.idleTimer);
    this.fileWatcher?.close();
    this.unsubscribe?.();
    await this.runtime.dispose();
    for (const ws of this.sockets) ws.close(1000, 'session disposed');
    this.sockets.clear();
  }
}
