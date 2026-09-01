import { statSync, watch, type FSWatcher } from "node:fs";
import type { WebSocket } from "ws";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  AuthUiComponent,
  type WebAuthEvent,
  type WebAuthPrompt,
} from "./auth-ui.js";
import {
  CustomUiBridge,
  PLAIN_THEME,
  type CustomUiFactory,
  type CustomUiOptions,
} from "./custom-ui-bridge.js";
import type {
  ClientCommand,
  ServerMessage,
  SessionSnapshot,
  UiRequest,
  WidgetState,
} from "./protocol.js";
import { SessionQueueAdapter } from "./queue-adapter.js";

/** Short human-readable summary of a tool call's main argument. */
function toolSummary(toolName: string, args: Record<string, unknown>): string {
  const pick = (k: string) =>
    typeof args[k] === "string" ? String(args[k]) : undefined;
  switch (toolName) {
    case "bash":
      return pick("command") ?? "";
    case "read":
    case "write":
    case "edit":
      return pick("path") ?? pick("file_path") ?? "";
    case "grep":
      return pick("pattern") ?? "";
    case "find":
      return pick("pattern") ?? pick("path") ?? "";
    case "ls":
      return pick("path") ?? ".";
    default:
      return "";
  }
}

/** Minimal JSON decoder returning [value, bytesConsumed] (handles concatenated JSON). */
class JSONDecoder {
  private source = "";
  decode(input: string): [unknown, number] {
    this.source = input;
    try {
      const value = JSON.parse(this.readValue());
      return [value, this.consumed];
    } catch (cause) {
      throw new Error("invalid JSON stream value", { cause });
    }
  }
  private consumed = 0;
  private readValue(): string {
    let depth = 0;
    let inStr = false;
    let esc = false;
    // find the end of one JSON value
    let i = 0;
    while (i < this.source.length) {
      const ch = this.source[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
      i++;
    }
    this.consumed = i;
    return this.source.slice(0, i);
  }
}

/** Strip the huge `partial` message from streaming events; keep everything else JSON-passthrough. */
function serializeEvent(event: AgentSessionEvent): Record<string, unknown> {
  try {
    return JSON.parse(
      JSON.stringify(event, (key, value) =>
        key === "partial" ? undefined : value,
      ),
    ) as Record<string, unknown>;
  } catch (cause) {
    console.error(`[session] event_serialize_failed type=${event.type}`, cause);
    return { type: event.type };
  }
}

/** Read the last JSONL entry's id without loading the whole file. */
async function lastEntryId(file: string): Promise<string | undefined> {
  const { open } = await import("node:fs/promises");
  const fh = await open(file, "r");
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, 8192);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    const lines = buf
      .toString("utf-8")
      .split("\n")
      .filter((l) => l.trim());
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
  onSessionChanged?: (
    host: SessionHost,
    previousFile: string | undefined,
    nextFile: string | undefined,
  ) => void | Promise<void>;
  /** Keep detached sessions alive while owned background work is active. */
  hasBackgroundWork?: (host: SessionHost) => boolean | Promise<boolean>;
  /** Override lifecycle delays in deterministic tests. */
  idleGraceMs?: number;
  activeRecheckMs?: number;
}

interface LoginChoice {
  providerId: string;
  providerName: string;
  authType: "oauth" | "api_key";
  methodName: string;
  interactive: boolean;
}

const WEB_BUILTIN_SLASH_COMMANDS = [
  { name: "compact", description: "压缩当前会话上下文", source: "builtin" },
  {
    name: "model",
    description: "切换模型（provider/model）",
    source: "builtin",
  },
  {
    name: "reload",
    description: "重新加载扩展、技能、提示词和设置",
    source: "builtin",
  },
  { name: "login", description: "登录模型提供商", source: "builtin" },
  { name: "logout", description: "退出模型提供商", source: "builtin" },
  { name: "name", description: "设置当前会话名称", source: "builtin" },
  { name: "session", description: "查看当前会话信息", source: "builtin" },
  { name: "new", description: "新建会话", source: "builtin" },
] satisfies SessionSnapshot["slashCommands"];

export function activeToolsForMode(
  allNames: readonly string[],
  mode: "off" | "read-only" | "default" | "full",
): string[] {
  const available = new Set(allNames);
  const explicitReadOnly = ["read", "grep", "find", "ls"].filter((name) => available.has(name));
  const explicitDefault = ["read", "bash", "edit", "write"].filter((name) => available.has(name));
  if (mode === "off") return [];
  if (mode === "read-only") return explicitReadOnly;
  if (mode === "default") return explicitDefault;
  return [...allNames];
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
    private onSessionChanged?: SessionHostOptions["onSessionChanged"],
    private hasBackgroundWork?: SessionHostOptions["hasBackgroundWork"],
    private readonly idleGraceMs = 5 * 60_000,
    private readonly activeRecheckMs = 30_000,
  ) {}

  private sockets = new Set<WebSocket>();
  private unsubscribe?: () => void;
  private idleTimer?: NodeJS.Timeout;
  private retainedForBackgroundWork = false;
  /** Extension-provided widgets (string-lines form) keyed by widget key. */
  private widgets = new Map<string, WidgetState>();
  /** Extension-provided status bar entries. */
  private statuses = new Map<string, string>();
  /** Pending extension dialogs awaiting a browser answer. */
  private uiPending = new Map<string, (value: unknown) => void>();
  /** The ui_request currently awaiting an answer (re-sent to new attaches). */
  private pendingUiRequest?: UiRequest;
  private pendingUiTimer?: NodeJS.Timeout;
  /** Standard dialogs and custom components share one lane so concurrent tools cannot overwrite UI state. */
  private uiQueue: Promise<void> = Promise.resolve();
  private customUi = new CustomUiBridge((message) => this.broadcast(message));
  private disposed = false;
  /** Currently executing tool calls (toolCallId → name/args/startedAt), for ui.custom dialogs. */
  private activeToolCalls = new Map<
    string,
    { toolName: string; args: Record<string, unknown>; startedAt: number }
  >();
  /** Hook (set by index.ts) invoked on every tool execution start/end. */
  onToolExecution?: (toolName: string, phase: "start" | "end") => void;
  /** Full branch message list and leaf identity from the latest snapshot (for history paging). */
  private lastBranch: Record<string, unknown>[] = [];
  private lastBranchHeadId?: string;
  private fileWatcher?: FSWatcher;
  private watchedFile?: string;
  private watchDebounceTimer?: NodeJS.Timeout;
  private watchRetryTimer?: NodeJS.Timeout;
  private pendingSnapshotTimer?: NodeJS.Timeout;
  /** Current agent run start time (undefined when fully settled). */
  runStartedAt?: number;
  private settledMtime = 0;
  private reloading = false;
  private cooldownUntil = 0;
  private indexedSessionFile?: string;
  private disposePromise?: Promise<void>;
  private queueOperation: Promise<void> = Promise.resolve();
  private commandMutationChain: Promise<void> = Promise.resolve();
  private readonly queueAdapter = new SessionQueueAdapter(() => this.session);

  static async create(
    key: string,
    opts: SessionHostOptions,
  ): Promise<SessionHost> {
    const createRuntime: CreateAgentSessionRuntimeFactory = async ({
      cwd,
      sessionManager,
      sessionStartEvent,
    }) => {
      const services = await createAgentSessionServices({ cwd });
      return {
        ...(await createAgentSessionFromServices({
          services,
          sessionManager,
          sessionStartEvent,
        })),
        services,
        diagnostics: services.diagnostics,
      };
    };

    const sessionManager = opts.sessionPath
      ? SessionManager.open(opts.sessionPath)
      : SessionManager.create(opts.cwd);
    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: sessionManager.getCwd(),
      agentDir: getAgentDir(),
      sessionManager,
    });

    const modelRegistry = new ModelRegistry(runtime.services.modelRuntime);
    const host = new SessionHost(
      key,
      runtime,
      modelRegistry,
      opts.onEmpty,
      opts.onSessionChanged,
      opts.hasBackgroundWork,
      opts.idleGraceMs,
      opts.activeRecheckMs,
    );
    host.indexedSessionFile = runtime.session.sessionFile;

    runtime.setBeforeSessionInvalidate(() => host.teardownSessionUi("rebind"));
    runtime.setRebindSession(async (session) => {
      const previousFile = host.indexedSessionFile;
      host.modelRegistry = new ModelRegistry(
        host.runtime.services.modelRuntime,
      );
      host.bindSession();
      host.restartFileWatch();
      host.indexedSessionFile = session.sessionFile;
      await host.onSessionChanged?.(host, previousFile, session.sessionFile);
      await host.bindExtensionUi(session);
      host.broadcastSnapshot();
    });
    host.bindSession();
    await host.bindExtensionUi(runtime.session);
    host.restartFileWatch();
    return host;
  }

  /** Bind the watcher to the runtime's current file, replacing any stale binding. */
  private restartFileWatch(): void {
    clearTimeout(this.watchDebounceTimer);
    clearTimeout(this.watchRetryTimer);
    this.fileWatcher?.close();
    this.fileWatcher = undefined;
    this.watchedFile = undefined;
    const file = this.runtime.session.sessionFile;
    if (!file) return;
    try {
      const { mtimeMs } = statSync(file);
      this.settledMtime = mtimeMs;
      this.watchedFile = file;
      this.fileWatcher = watch(file, () => this.scheduleExternalReload(1500));
    } catch {
      // Brand-new sessions are watched lazily after their first persisted entry.
    }
  }

  private scheduleExternalReload(delayMs: number): void {
    if (this.disposed) return;
    clearTimeout(this.watchRetryTimer);
    this.watchRetryTimer = setTimeout(
      () => void this.reloadIfExternal(),
      delayMs,
    );
  }

  /**
   * Repair a session file whose lines got merged by concurrent writes (pi's
   * append can interleave a `thinking_level_change`/`custom_message` onto the
   * previous line when the file is opened right after an import). Splits every
   * line into one JSON object per line so the file always parses.
   */
  private static async healIfMerged(file: string): Promise<boolean> {
    try {
      const fs = await import("node:fs/promises");
      const raw = await fs.readFile(file, "utf8");
      const lines = raw.split("\n");
      let changed = false;
      const out: string[] = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const decoder = new JSONDecoder();
          let rest = line;
          let first = true;
          while (rest.trim()) {
            const [obj, end] = decoder.decode(rest.trim());
            out.push(JSON.stringify(obj));
            rest = rest.trim().slice(end).trim();
            if (first) first = false;
            else changed = true; // found a merged line
          }
        } catch {
          out.push(line);
        }
      }
      if (changed) {
        await fs.writeFile(file, out.join("\n") + "\n");
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private async reloadIfExternal(): Promise<void> {
    const file = this.runtime.session.sessionFile;
    if (!file || this.disposed) return;
    if (file !== this.watchedFile) {
      this.restartFileWatch();
      return;
    }
    if (this.runtime.session.isStreaming || this.reloading) {
      this.scheduleExternalReload(250);
      return;
    }
    if (Date.now() < this.cooldownUntil) {
      this.scheduleExternalReload(this.cooldownUntil - Date.now() + 50);
      return;
    }
    this.reloading = true;
    try {
      const { mtimeMs } = await import("node:fs/promises").then((fs) =>
        fs.stat(file),
      );
      // isStreaming already covers our own writes; any newer mtime is external.
      if (mtimeMs < this.settledMtime) return;
      // Content check: the file's last entry must be one we don't already have.
      // Our own reload/append side-effects share our known leaf id — skip those.
      // heal merged lines from concurrent writes before re-reading
      await SessionHost.healIfMerged(file);
      const tailId = await lastEntryId(file);
      const knownLeaf = this.runtime.session.sessionManager.getLeafId();
      if (tailId && tailId === knownLeaf) {
        this.settledMtime = mtimeMs;
        return;
      }
      console.log("[watch] external change detected, reloading", file);
      await this.runtime.switchSession(file);
      const after = await import("node:fs/promises").then((fs) =>
        fs.stat(file),
      );
      this.settledMtime = Math.max(after.mtimeMs, Date.now());
      // blind window: the reload's own side-effects settle here; external bursts
      // (e.g. a pi CLI run) debounce to one reload per burst.
      this.cooldownUntil = Date.now() + 2000;
      this.broadcastSnapshot();
    } catch (err) {
      console.log(
        "[watch] reload failed:",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      this.reloading = false;
    }
  }

  /** Synchronously detach UI owned by the runtime before its extensions become stale. */
  private teardownSessionUi(reason: "rebind" | "dispose" = "rebind"): void {
    for (const id of [...this.uiPending.keys()]) this.closeUiRequest(id, reason, undefined);
    this.pendingUiRequest = undefined;
    this.customUi.dispose();
    this.widgets.clear();
    this.statuses.clear();
    this.broadcastWidgets();
    this.broadcastStatuses();
  }

  /** Bridge pi's extension UI surface (widgets, status, dialogs, toasts) to web clients. */
  private async bindExtensionUi(session: AgentSession): Promise<void> {
    const host = this;
    try {
      // SAFETY: the headless bridge implements the ExtensionUIContext surface used by web extensions;
      // its TUI/Theme structural adapters intentionally omit terminal-only internals.
      await session.bindExtensions({
        mode: "tui",
        uiContext: {
          // Pass-through theme: extension components keep their layout while the browser owns colors.
          theme: PLAIN_THEME,
          async custom<T>(
            factory: CustomUiFactory<T>,
            options?: CustomUiOptions,
          ) {
            // Keep tool-aware question UIs native on the web; bridge every other TUI component generically.
            const active = [...host.activeToolCalls.values()].pop();
            if (active?.toolName === "question") {
              const args = active.args as {
                question?: string;
                options?: { label: string; description?: string }[];
              };
              const answer = await host.uiRequest<unknown>({
                kind: "question",
                title: args.question ?? "question",
                payload: {
                  question: args.question,
                  options: args.options ?? [],
                },
              });
              // SAFETY: the question tool owns this custom() call and expects its documented answer shape.
              return (answer ?? null) as T;
            }
            if (active?.toolName === "questionnaire") {
              const args = active.args as {
                questions?: {
                  label?: string;
                  prompt: string;
                  options: { label: string; description?: string }[];
                  allowOther?: boolean;
                }[];
              };
              const questions = (args.questions ?? []).map((q, i) => ({
                label: q.label ?? `Q${i + 1}`,
                prompt: q.prompt,
                options: q.options ?? [],
                allowOther: q.allowOther !== false,
              }));
              const answer = await host.uiRequest<unknown>({
                kind: "questionnaire",
                title: "questionnaire",
                payload: { questions },
              });
              const value = answer ?? {
                questions,
                answers: [],
                cancelled: true,
              };
              // SAFETY: the questionnaire tool owns this custom() call and expects its documented answer shape.
              return value as T;
            }
            return host.customUiRequest(factory, options);
          },
          select(
            title: string,
            options: readonly string[],
            opts?: { timeout?: number },
          ) {
            return host.uiRequest<string | undefined>(
              { kind: "select", title, options: [...options] },
              opts?.timeout,
            );
          },
          async confirm(
            title: string,
            message: string,
            opts?: { timeout?: number },
          ) {
            const v = await host.uiRequest<string | boolean | undefined>(
              { kind: "confirm", title, message },
              opts?.timeout,
            );
            return v === true;
          },
          async input(
            title: string,
            placeholder: string | undefined,
            opts?: { timeout?: number },
          ) {
            const v = await host.uiRequest<string | undefined>(
              { kind: "input", title, placeholder },
              opts?.timeout,
            );
            return typeof v === "string" ? v : undefined;
          },
          notify(message: string, type?: "info" | "warning" | "error") {
            host.broadcast({ type: "toast", message, level: type ?? "info" });
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
          // remaining ExtensionUIContext members (no-ops on web; some extensions
          // like pi-subagents call these unconditionally)
          pasteToEditor() {},
          setEditorText() {},
          getEditorText() {
            return "";
          },
          editor() {
            return Promise.resolve(undefined);
          },
          addAutocompleteProvider() {},
          setEditorComponent() {},
          getEditorComponent() {
            return undefined;
          },
          getAllThemes() {
            return [];
          },
          getTheme() {
            return undefined;
          },
          setTheme() {
            return { success: false };
          },
          getToolsExpanded() {
            return false;
          },
          setToolsExpanded() {},
          setWidget(
            key: string,
            content: unknown,
            options?: { placement?: "aboveEditor" | "belowEditor" },
          ) {
            if (
              Array.isArray(content) &&
              content.every((l) => typeof l === "string")
            ) {
              host.widgets.set(key, {
                key,
                lines: content as string[],
                placement: options?.placement ?? "aboveEditor",
              });
            } else {
              // undefined clears; TUI component factories cannot render on web
              host.widgets.delete(key);
            }
            host.broadcastWidgets();
          },
        } as unknown as ExtensionUIContext,
      });
    } catch (err) {
      // Extensions are optional; a failing binding must not break the session.
      // Log it though — silent swallow makes "why doesn't my extension load"
      // impossible to debug (e.g. pi-codex-multi throwing at module load).
      console.log(
        "[ext] bindExtensionUi error:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private enqueueUi<T>(open: () => Promise<T>): Promise<T> {
    const result = this.uiQueue.then(() => {
      if (this.disposed) throw new Error("session disposed");
      return open();
    });
    this.uiQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private uiRequest<T>(
    req: Omit<UiRequest, "id">,
    timeoutMs?: number,
  ): Promise<T> {
    return this.enqueueUi(() => this.openUiRequest<T>(req, timeoutMs));
  }

  private openUiRequest<T>(
    req: Omit<UiRequest, "id">,
    timeoutMs?: number,
  ): Promise<T> {
    const id = crypto.randomUUID();
    return new Promise<T>((resolvePromise) => {
      // Long-running fallback: unanswered dialogs resolve as cancelled so the agent never hangs.
      const timeout = timeoutMs ?? 10 * 60_000;
      this.pendingUiRequest = { id, ...req };
      this.pendingUiTimer = setTimeout(() => {
        this.closeUiRequest(id, "timeout", undefined);
      }, timeout);
      this.uiPending.set(id, (value) => {
        // SAFETY: the matching UI request defines T and the browser returns that request's value.
        resolvePromise(value as T);
      });
      console.log(`[ui] dialog_opened requestId=${id} kind=${req.kind}`);
      this.broadcast({ type: "ui_request", request: { id, ...req } });
    });
  }

  private closeUiRequest(
    id: string,
    reason: "answered" | "timeout" | "rebind" | "dispose",
    value: unknown,
  ): boolean {
    const resolvePromise = this.uiPending.get(id);
    if (!resolvePromise) return false;
    this.uiPending.delete(id);
    clearTimeout(this.pendingUiTimer);
    this.pendingUiTimer = undefined;
    if (this.pendingUiRequest?.id === id) this.pendingUiRequest = undefined;
    this.broadcast({ type: "ui_close", requestId: id, reason });
    console.log(`[ui] dialog_closed requestId=${id} reason=${reason}`);
    resolvePromise(value);
    return true;
  }

  private customUiRequest<T>(
    factory: CustomUiFactory<T>,
    options?: CustomUiOptions,
  ): Promise<T> {
    return this.enqueueUi(() => this.customUi.request(factory, options));
  }

  private broadcastWidgets(): void {
    this.broadcast({ type: "widgets", widgets: [...this.widgets.values()] });
  }

  private broadcastStatuses(): void {
    this.broadcast({
      type: "statuses",
      statuses: Object.fromEntries(this.statuses),
    });
  }

  private bindSession(): void {
    clearTimeout(this.pendingSnapshotTimer);
    this.pendingSnapshotTimer = undefined;
    this.unsubscribe?.();
    const session = this.runtime.session;
    this.unsubscribe = session.subscribe((event) => {
      const serializedEvent = serializeEvent(event);
      if (event.type === "queue_update") {
        const queue = this.queueAdapter.view();
        serializedEvent.steering = queue.steering;
        serializedEvent.followUp = queue.followUp;
        serializedEvent.queueCapabilities = queue.capabilities;
      }
      this.broadcast({ type: "event", event: serializedEvent });
      // Keep late-joining clients consistent after meaningful state changes.
      // agent_end fires before the session manager finishes appending entries,
      // so defer the snapshot slightly; agent_settled marks full quiescence.
      if (event.type === "agent_start") {
        // isStreaming must flip live: the composer stop button, queue-mode
        // chips and the waiting-for-model indicator all read snapshot state
        this.runStartedAt = Date.now();
        this.broadcastSnapshot();
      }
      if (event.type === "agent_end") {
        clearTimeout(this.pendingSnapshotTimer);
        this.pendingSnapshotTimer = setTimeout(() => {
          this.pendingSnapshotTimer = undefined;
          this.settledMtime = Date.now();
          this.broadcastSnapshot();
        }, 150);
      } else if (
        event.type === "agent_settled" ||
        event.type === "session_info_changed" ||
        event.type === "thinking_level_changed" ||
        event.type === "compaction_end"
      ) {
        if (event.type === "agent_settled") {
          this.runStartedAt = undefined;
          this.scheduleExternalReload(100);
        }
        clearTimeout(this.pendingSnapshotTimer);
        this.pendingSnapshotTimer = undefined;
        this.broadcastSnapshot();
      }
      // Track the prompt queue so snapshots reflect it for late joiners.
      if (event.type === "tool_execution_start") {
        // SAFETY: AgentSessionEvent's upstream union omits tool fields even though this event always carries them.
        const e = event as unknown as {
          toolCallId?: string;
          toolName?: string;
          args?: Record<string, unknown>;
        };
        if (e.toolCallId)
          this.activeToolCalls.set(e.toolCallId, {
            toolName: e.toolName ?? "",
            args: e.args ?? {},
            startedAt: Date.now(),
          });
        this.onToolExecution?.(e.toolName ?? "", "start");
      }
      if (event.type === "tool_execution_end") {
        // SAFETY: AgentSessionEvent's upstream union omits tool fields even though this event always carries them.
        const e = event as unknown as {
          toolCallId?: string;
          toolName?: string;
        };
        if (e.toolCallId) this.activeToolCalls.delete(e.toolCallId);
        const name = e.toolName ?? "";
        this.onToolExecution?.(name, "end");
      }
    });
  }

  get session(): AgentSession {
    return this.runtime.session;
  }

  /** Import a JSONL session into this host's runtime. */
  async runtime_import(
    inputPath: string,
  ): Promise<{ ok: boolean; sessionFile?: string; error?: string }> {
    try {
      const r = await this.runtime.importFromJsonl(inputPath);
      this.broadcastSnapshot();
      return {
        ok: !r.cancelled,
        sessionFile: this.runtime.session.sessionFile,
        error: r.cancelled ? "cancelled" : undefined,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  get cwd(): string {
    return this.runtime.cwd;
  }

  get services(): AgentSessionRuntime["services"] {
    return this.runtime.services;
  }

  get viewerCount(): number {
    return this.sockets.size;
  }

  applySettings(settings: {
    steeringMode?: "all" | "one-at-a-time";
    followUpMode?: "all" | "one-at-a-time";
  }): void {
    if (settings.steeringMode)
      this.session.setSteeringMode(settings.steeringMode);
    if (settings.followUpMode)
      this.session.setFollowUpMode(settings.followUpMode);
    this.broadcastSnapshot();
  }

  attach(ws: WebSocket): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.retainedForBackgroundWork = false;
    this.sockets.add(ws);
    this.send(ws, { type: "snapshot", snapshot: this.snapshot() });
    this.send(ws, { type: "widgets", widgets: [...this.widgets.values()] });
    this.send(ws, {
      type: "statuses",
      statuses: Object.fromEntries(this.statuses),
    });
    // re-deliver an unanswered extension dialog to the newly attached browser
    if (this.pendingUiRequest) {
      this.send(ws, { type: "ui_request", request: this.pendingUiRequest });
    }
    const customFrame = this.customUi.frame;
    if (customFrame)
      this.send(ws, { type: "custom_ui_frame", frame: customFrame });
  }

  detach(ws: WebSocket): void {
    this.sockets.delete(ws);
    if (this.sockets.size === 0) this.scheduleIdleCheck(this.idleGraceMs);
  }

  private scheduleIdleCheck(delayMs: number): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      void this.checkDetachedActivity();
    }, delayMs);
    this.idleTimer.unref();
  }

  private async checkDetachedActivity(): Promise<void> {
    if (this.disposed || this.sockets.size > 0) return;
    const parentRunning = this.isRunning;
    let backgroundRunning = false;
    try {
      backgroundRunning = parentRunning
        ? false
        : Boolean(await this.hasBackgroundWork?.(this));
    } catch (cause) {
      // Fail safe: a detector failure must not abort work that may still run.
      console.error(
        `[session] background_check_failed key=${JSON.stringify(this.key)}`,
        cause,
      );
      backgroundRunning = true;
    }
    if (this.disposed || this.sockets.size > 0) return;
    if (parentRunning || backgroundRunning) {
      if (!this.retainedForBackgroundWork)
        process.stdout.write(
          `[session] detached_keepalive key=${JSON.stringify(this.key)} parent_running=${parentRunning} background_running=${backgroundRunning}\n`,
        );
      this.retainedForBackgroundWork = true;
      this.scheduleIdleCheck(this.activeRecheckMs);
      return;
    }
    if (this.retainedForBackgroundWork) {
      this.retainedForBackgroundWork = false;
      process.stdout.write(
        `[session] detached_work_completed key=${JSON.stringify(this.key)} idle_grace_ms=${this.idleGraceMs}\n`,
      );
      this.scheduleIdleCheck(this.idleGraceMs);
      return;
    }
    await this.dispose();
    this.onEmpty?.(this);
  }

  /** Active tool executions in this session (what is literally running right now). */
  get activeExecutions(): {
    toolName: string;
    summary: string;
    startedAt: number;
  }[] {
    return [...this.activeToolCalls.values()].map((t) => ({
      toolName: t.toolName,
      summary: toolSummary(t.toolName, t.args),
      startedAt: t.startedAt,
    }));
  }

  get isRunning(): boolean {
    return this.session.isStreaming;
  }

  private slashCommands(): SessionSnapshot["slashCommands"] {
    const commands: SessionSnapshot["slashCommands"] = [
      ...WEB_BUILTIN_SLASH_COMMANDS,
    ];
    const names = new Set(commands.map((command) => command.name));
    const add = (
      name: string,
      description: string | undefined,
      source: "extension" | "prompt" | "skill",
    ) => {
      if (names.has(name)) return;
      names.add(name);
      commands.push({ name, description, source });
    };
    try {
      const session = this.session;
      for (const command of session.extensionRunner.getRegisteredCommands())
        add(command.invocationName, command.description, "extension");
      for (const prompt of session.promptTemplates)
        add(prompt.name, prompt.description, "prompt");
      for (const skill of session.resourceLoader.getSkills().skills)
        add(`skill:${skill.name}`, skill.description, "skill");
    } catch (cause) {
      console.error(`[session] slash_commands_failed key=${this.key}`, cause);
    }
    return commands;
  }

  snapshot(): SessionSnapshot {
    const s = this.session;
    const model = s.model;
    if (s.sessionFile !== this.indexedSessionFile) {
      const previousFile = this.indexedSessionFile;
      this.indexedSessionFile = s.sessionFile;
      void Promise.resolve(
        this.onSessionChanged?.(this, previousFile, s.sessionFile),
      ).catch((cause) =>
        console.error(`[session] index_update_failed key=${this.key}`, cause),
      );
    }

    // Build the visible message list from session-file entries so each
    // message carries its entry id (needed for fork / branch actions).
    let messages: Record<string, unknown>[] = [];
    let branchHeadId: string | undefined;
    try {
      const branch = s.sessionManager.getBranch();
      for (const entry of branch) {
        const e = entry as { type?: string; id?: string; message?: unknown };
        if (e.id) branchHeadId = e.id;
        if (
          e.type === "message" &&
          e.message &&
          typeof e.message === "object"
        ) {
          const msg = e.message as Record<string, unknown>;
          // some sessions carry bare-string content blocks ({ "A" } instead of
          // {type:'text'}); normalize so rendering & tool cards don't choke
          if (Array.isArray(msg.content)) {
            msg.content = msg.content.map((b) => {
              if (typeof b === "string") return { type: "text", text: b };
              if (b && typeof b === "object") return b;
              return { type: "text", text: String(b ?? "") };
            });
          }
          messages.push({ ...msg, _entryId: e.id });
        }
      }
    } catch {
      // fall through to agent state
    }
    if (messages.length === 0) {
      try {
        // SAFETY: structuredClone preserves the JSON-safe AgentMessage field layout used by the wire protocol.
        messages = structuredClone(s.messages) as unknown as Record<
          string,
          unknown
        >[];
      } catch {
        messages = [];
      }
    }

    // Keep the full branch around for history paging.
    this.lastBranch = messages;
    this.lastBranchHeadId = branchHeadId;
    const total = messages.length;
    const from = Math.max(0, total - 150);
    const page = messages.slice(from);

    let stats: SessionSnapshot["stats"];
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

    // brand-new sessions have no file at host creation; attach the watcher
    // lazily once the file exists
    if (
      (!this.fileWatcher || this.watchedFile !== s.sessionFile) &&
      s.sessionFile
    )
      this.restartFileWatch();

    const queue = this.queueAdapter.view();
    return {
      sessionId: s.sessionId,
      sessionFile: s.sessionFile,
      branchHeadId,
      name: s.sessionName,
      cwd: this.runtime.cwd,
      isStreaming: s.isStreaming,
      thinkingLevel: s.thinkingLevel,
      availableThinkingLevels: (() => {
        try {
          return s.getAvailableThinkingLevels();
        } catch {
          return undefined;
        }
      })(),
      model: model
        ? {
            provider: model.provider,
            id: model.id,
            name: model.name ?? model.id,
          }
        : undefined,
      messages: page as SessionSnapshot["messages"],
      totalMessages: total,
      historyFrom: from,
      queue: {
        steering: queue.steering,
        followUp: queue.followUp,
      },
      queueCapabilities: queue.capabilities,
      stats,
      tools: s.getActiveToolNames(),
      slashCommands: this.slashCommands(),
    };
  }

  private loginChoices(providerRef?: string): LoginChoice[] {
    const normalized = providerRef?.trim().toLowerCase();
    const choices: LoginChoice[] = [];
    for (const provider of this.session.modelRuntime.getProviders()) {
      if (
        normalized &&
        provider.id.toLowerCase() !== normalized &&
        provider.name.toLowerCase() !== normalized
      )
        continue;
      if (provider.auth.oauth) {
        choices.push({
          providerId: provider.id,
          providerName: provider.name,
          authType: "oauth",
          methodName: provider.auth.oauth.name,
          interactive: true,
        });
      }
      if (provider.auth.apiKey) {
        choices.push({
          providerId: provider.id,
          providerName: provider.name,
          authType: "api_key",
          methodName: provider.auth.apiKey.name,
          interactive: Boolean(provider.auth.apiKey.login),
        });
      }
    }
    return choices.sort(
      (a, b) =>
        a.providerName.localeCompare(b.providerName) ||
        a.authType.localeCompare(b.authType),
    );
  }

  private async chooseLogin(
    providerRef?: string,
  ): Promise<LoginChoice | undefined> {
    const choices = this.loginChoices(providerRef);
    if (choices.length === 0)
      throw new Error(
        providerRef
          ? `没有找到登录 Provider：${providerRef}`
          : "没有可用的登录方式。",
      );
    if (choices.length === 1) return choices[0];
    const labels = choices.map(
      (choice) =>
        `${choice.providerName} (${choice.providerId}) · ${choice.authType === "oauth" ? "OAuth" : "API key"} — ${choice.methodName}`,
    );
    const selected = await this.uiRequest<string | undefined>({
      kind: "select",
      title: providerRef
        ? `选择 ${choices[0].providerName} 的登录方式`
        : "选择 Provider 和登录方式",
      options: labels,
    });
    const index = selected ? labels.indexOf(selected) : -1;
    return index >= 0 ? choices[index] : undefined;
  }

  private async runLoginCommand(providerRef?: string): Promise<string> {
    if (this.session.isStreaming)
      throw new Error("请等待当前回复完成后再登录。");
    const choice = await this.chooseLogin(providerRef);
    if (!choice) return "已取消登录。";
    if (!choice.interactive) {
      throw new Error(
        `${choice.providerName} 的 ${choice.methodName} 需要在服务器环境或配置文件中设置，不能交互输入。`,
      );
    }
    console.log(
      `[auth] login_started provider=${choice.providerId} type=${choice.authType}`,
    );
    const result = await this.customUiRequest<{
      ok: boolean;
      cancelled?: boolean;
      error?: string;
    }>((tui, _theme, _keybindings, done) => {
      const component = new AuthUiComponent(
        tui,
        choice.providerName,
        choice.methodName,
      );
      void this.session.modelRuntime
        .login(choice.providerId, choice.authType, {
          signal: component.signal,
          // SAFETY: WebAuthPrompt/WebAuthEvent mirror pi-ai's public AuthInteraction structures.
          prompt: (prompt) => component.prompt(prompt as WebAuthPrompt),
          notify: (event) => component.notify(event as WebAuthEvent),
        })
        .then(() => {
          component.markCompleted();
          done({ ok: true });
        })
        .catch((cause) => {
          const error = cause instanceof Error ? cause.message : String(cause);
          component.markCompleted();
          done({
            ok: false,
            cancelled: component.signal.aborted || error === "Login cancelled",
            error,
          });
        });
      return component;
    });
    if (result.cancelled) return "已取消登录。";
    if (!result.ok)
      throw new Error(result.error ?? `${choice.providerName} 登录失败。`);
    this.broadcastSnapshot();
    console.log(
      `[auth] login_completed provider=${choice.providerId} type=${choice.authType}`,
    );
    return `${choice.providerName} 登录成功。凭据已保存。`;
  }

  private async runLogoutCommand(providerRef?: string): Promise<string> {
    if (this.session.isStreaming)
      throw new Error("请等待当前回复完成后再退出登录。");
    const credentials = await this.session.modelRuntime.listCredentials({
      signal: AbortSignal.timeout(15_000),
    });
    const normalized = providerRef?.trim().toLowerCase();
    const matches = credentials.filter((credential) => {
      const provider = this.session.modelRuntime.getProvider(
        credential.providerId,
      );
      return (
        !normalized ||
        credential.providerId.toLowerCase() === normalized ||
        provider?.name.toLowerCase() === normalized
      );
    });
    if (matches.length === 0)
      throw new Error(
        providerRef
          ? `没有找到已保存的 Provider 凭据：${providerRef}`
          : "没有可移除的已保存凭据。",
      );
    const labels = matches.map((credential) => {
      const provider = this.session.modelRuntime.getProvider(
        credential.providerId,
      );
      return `${provider?.name ?? credential.providerId} (${credential.providerId}) · ${credential.type}`;
    });
    let index = 0;
    if (matches.length > 1) {
      const selected = await this.uiRequest<string | undefined>({
        kind: "select",
        title: "选择要退出登录的 Provider",
        options: labels,
      });
      if (!selected) return "已取消退出登录。";
      index = labels.indexOf(selected);
    }
    const credential = matches[index];
    if (!credential) return "已取消退出登录。";
    await this.session.modelRuntime.logout(credential.providerId, {
      signal: AbortSignal.timeout(15_000),
    });
    this.broadcastSnapshot();
    console.log(
      `[auth] logout_completed provider=${credential.providerId} type=${credential.type}`,
    );
    return `${this.session.modelRuntime.getProvider(credential.providerId)?.name ?? credential.providerId} 已退出登录。`;
  }

  /** Parse and execute a pi slash command typed in the web composer. */
  async runSlash(
    raw: string,
  ): Promise<{ ok: boolean; error?: string; data?: Record<string, unknown> }> {
    const s = this.session;
    const text = raw.replace(/^\s*\/+\s*/, "").trim();
    const [name, ...args] = text.split(/\s+/);
    const arg = args.join(" ").trim();
    const out = (o: string) => ({ ok: true, data: { output: o } });
    if (
      s.isStreaming &&
      ["compact", "name", "new", "model", "login", "logout"].includes(name)
    ) {
      return {
        ok: false,
        error: `当前回复仍在运行，暂不能执行 /${name}；请先停止或等待完成。`,
      };
    }
    switch (name) {
      case "compact":
        await s.compact();
        return out("已触发上下文压缩。");
      case "name":
        if (!arg) return { ok: false, error: "用法: /name <会话名>" };
        s.setSessionName(arg);
        this.broadcastSnapshot();
        return out(`会话已命名为：${arg}`);
      case "session": {
        const st = s.sessionName ?? "";
        const model = s.model ? `${s.model.provider}/${s.model.id}` : "-";
        return out(
          `会话: ${st || "(未命名)"}\n模型: ${model}\n流式: ${s.isStreaming ? "是" : "否"}`,
        );
      }
      case "new":
        await this.runtime.newSession();
        this.broadcastSnapshot();
        return out("已新建会话。");
      case "reload":
        if (s.isStreaming)
          return { ok: false, error: "请等待当前回复结束后再执行 /reload。" };
        if (s.isCompacting)
          return { ok: false, error: "请等待上下文压缩结束后再执行 /reload。" };
        if (this.pendingUiRequest || this.customUi.isActive)
          return { ok: false, error: "请先关闭当前弹窗，再执行 /reload。" };
        console.log(`[session] reload_started key=${this.key}`);
        await s.reload({
          beforeSessionStart: () => {
            this.widgets.clear();
            this.statuses.clear();
            this.broadcastWidgets();
            this.broadcastStatuses();
          },
        });
        this.broadcastSnapshot();
        console.log(`[session] reload_completed key=${this.key}`);
        return out("已重新加载扩展、技能、提示词、设置和上下文文件。");
      case "model": {
        // /model <provider/modelId> — resolve current within the model registry
        const [prov, ...mid] = arg.split("/");
        if (!prov || mid.length === 0)
          return { ok: false, error: "用法: /model <provider/modelId>" };
        const model = this.modelRegistry.find(prov, mid.join("/"));
        if (!model) return { ok: false, error: `模型未找到: ${arg}` };
        await s.setModel(model);
        this.broadcastSnapshot();
        return out(`已切换模型：${model.name ?? model.id}`);
      }
      case "login":
        return out(await this.runLoginCommand(arg || undefined));
      case "logout":
        return out(await this.runLogoutCommand(arg || undefined));
      case "export":
        return { ok: false, error: "/export 请使用界面右上角的「导出」按钮。" };
      default: {
        const command = this.slashCommands().find(
          (candidate) =>
            candidate.name === name && candidate.source !== "builtin",
        );
        if (!command)
          return {
            ok: false,
            error: `未知命令 /${name}。输入 / 可查看当前会话支持的命令。`,
          };
        try {
          await s.prompt(`/${text}`, {
            streamingBehavior: s.isStreaming ? "steer" : undefined,
          });
          return out(`已执行 /${name}。`);
        } catch (err) {
          return {
            ok: false,
            error: `命令 /${name} 出错: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }
    }
  }

  private withQueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queueOperation.then(operation);
    this.queueOperation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Acknowledge a prompt as soon as the SDK accepts it instead of holding the
   * host mutation lane for the entire model run. The SDK keeps the run alive;
   * later steer/follow-up messages can then enter its live queue immediately.
   */
  private async acceptPrompt(
    text: string,
    options: Omit<
      NonNullable<Parameters<AgentSession["prompt"]>[1]>,
      "preflightResult"
    > = {},
  ): Promise<{
    ok: boolean;
    error?: string;
    data?: { accepted: true; delivery: "run" | "steer" | "followUp" };
  }> {
    let preflightResult: boolean | undefined;
    let resolvePreflight!: (accepted: boolean) => void;
    const preflight = new Promise<boolean>((resolvePromise) => {
      resolvePreflight = resolvePromise;
    });
    const settlePreflight = (accepted: boolean): void => {
      if (preflightResult !== undefined) return;
      preflightResult = accepted;
      resolvePreflight(accepted);
    };
    const runOutcome = this.session
      .prompt(text, { ...options, preflightResult: settlePreflight })
      .then(
        () => ({ ok: true as const }),
        (cause) => ({
          ok: false as const,
          error: cause instanceof Error ? cause.message : String(cause),
        }),
      );

    void runOutcome.then((result) => {
      // Defensive fallback for an SDK implementation that returns without
      // invoking preflightResult.
      if (preflightResult === undefined) {
        settlePreflight(result.ok);
        return;
      }
      if (preflightResult && !result.ok) {
        console.error(
          `[session] prompt_failed key=${JSON.stringify(this.key)} error=${JSON.stringify(result.error)}`,
        );
        this.broadcast({
          type: "toast",
          message: result.error,
          level: "error",
        });
      }
    });

    if (await preflight) {
      return {
        ok: true,
        data: {
          accepted: true,
          delivery: options.streamingBehavior ?? "run",
        },
      };
    }
    return runOutcome;
  }

  /** Serialize mutations across every browser attached to this Host. */
  handleOrdered(
    cmd: ClientCommand & { id?: string },
  ): Promise<{ ok: boolean; error?: string; data?: Record<string, unknown> }> {
    const bypass =
      cmd.type === "abort" ||
      cmd.type === "ui_response" ||
      cmd.type === "custom_ui_input" ||
      cmd.type === "custom_ui_resize" ||
      cmd.type === "custom_ui_cancel";
    if (bypass) return this.handleCommand(cmd);
    const result = this.commandMutationChain.then(() => this.handleCommand(cmd));
    this.commandMutationChain = result.then(() => undefined, () => undefined);
    return result;
  }

  async handleCommand(
    cmd: ClientCommand & { id?: string },
  ): Promise<{ ok: boolean; error?: string; data?: Record<string, unknown> }> {
    if (this.disposed) return { ok: false, error: "session host is disposed" };
    if (
      cmd.type === "prompt" ||
      cmd.type === "steer" ||
      cmd.type === "followUp" ||
      cmd.type === "queue_remove" ||
      cmd.type === "queue_move" ||
      cmd.type === "queue_clear"
    ) {
      return this.withQueueOperation(() => this.executeCommand(cmd));
    }
    return this.executeCommand(cmd);
  }

  private async executeCommand(
    cmd: ClientCommand & { id?: string },
  ): Promise<{ ok: boolean; error?: string; data?: Record<string, unknown> }> {
    const s = this.session;
    const idleOnlyMutation =
      cmd.type === "newSession" ||
      cmd.type === "fork" ||
      cmd.type === "setModel" ||
      cmd.type === "setThinkingLevel" ||
      cmd.type === "setSessionName" ||
      cmd.type === "branch" ||
      cmd.type === "compact" ||
      cmd.type === "setToolMode";
    if (s.isStreaming && idleOnlyMutation) {
      return {
        ok: false,
        error: `当前回复仍在运行，暂不能执行 ${cmd.type}；请先停止或等待完成。`,
      };
    }
    try {
      switch (cmd.type) {
        case "slash":
          return this.runSlash(cmd.raw);
        case "prompt": {
          if (s.isStreaming && (cmd.images?.length ?? 0) > 0) {
            return {
              ok: false,
              error:
                "当前 pi SDK 无法完整读取含图片的队列消息；请等待当前回复结束后再发送图片，输入与附件已保留。",
            };
          }
          const result = await this.acceptPrompt(cmd.message, {
            images: cmd.images?.map((img) => ({
              type: "image" as const,
              data: img.data,
              mimeType: img.mimeType,
            })),
            streamingBehavior: s.isStreaming
              ? (cmd.streamingBehavior ?? "steer")
              : undefined,
          });
          if (result.ok && result.data?.delivery !== "run")
            this.broadcastSnapshot();
          return result;
        }
        case "steer":
          await s.steer(cmd.message);
          this.broadcastSnapshot();
          return { ok: true };
        case "followUp":
          await s.followUp(cmd.message);
          this.broadcastSnapshot();
          return { ok: true };
        case "abort":
          await s.abort();
          return { ok: true };
        case "newSession": {
          const r = await this.runtime.newSession();
          this.broadcastSnapshot();
          return {
            ok: !r.cancelled,
            error: r.cancelled ? "cancelled" : undefined,
          };
        }
        case "fork": {
          const r = await this.runtime.fork(cmd.entryId, {
            position: cmd.position ?? "at",
          });
          this.broadcastSnapshot();
          return {
            ok: !r.cancelled,
            error: r.cancelled ? "cancelled" : undefined,
            data: { sessionFile: this.runtime.session.sessionFile },
          };
        }
        case "setModel": {
          const model = this.modelRegistry.find(cmd.provider, cmd.modelId);
          if (!model)
            return {
              ok: false,
              error: `model not found: ${cmd.provider}/${cmd.modelId}`,
            };
          await s.setModel(model);
          this.broadcastSnapshot();
          return { ok: true };
        }
        case "setThinkingLevel":
          s.setThinkingLevel(
            cmd.level as Parameters<AgentSession["setThinkingLevel"]>[0],
          );
          this.broadcastSnapshot();
          return { ok: true };
        case "setSessionName":
          s.setSessionName(cmd.name);
          this.broadcastSnapshot();
          return { ok: true };
        case "branch": {
          const r = await s.navigateTree(cmd.entryId, {
            summarize: cmd.summarize ?? false,
          });
          this.broadcastSnapshot();
          return {
            ok: !r.cancelled,
            error: r.cancelled ? "cancelled" : undefined,
            data: { editorText: r.editorText },
          };
        }
        case "compact":
          await s.compact();
          return { ok: true };
        case "queue_remove": {
          const removed = this.queueAdapter.remove(
            cmd.queue,
            cmd.index,
            cmd.expectedMessage,
            cmd.revision,
          );
          process.stdout.write(
            `[session] queue_remove key=${JSON.stringify(this.key)} queue=${cmd.queue} index=${cmd.index} chars=${removed.length}\n`,
          );
          return { ok: true, data: { removed } };
        }
        case "queue_move":
          this.queueAdapter.move(
            cmd.from,
            cmd.to,
            cmd.index,
            cmd.expectedMessage,
            cmd.revision,
          );
          process.stdout.write(
            `[session] queue_move key=${JSON.stringify(this.key)} from=${cmd.from} to=${cmd.to} index=${cmd.index}\n`,
          );
          return { ok: true };
        case "setToolMode": {
          const allNames = s.getAllTools().map((tool) => tool.name);
          s.setActiveToolsByName(activeToolsForMode(allNames, cmd.mode));
          this.broadcastSnapshot();
          return { ok: true };
        }
        case "history":
          return { ok: false, error: "history must be routed to its requesting socket" };
        case "queue_clear":
          s.clearQueue();
          this.broadcastSnapshot();
          return { ok: true };
        case "ui_response":
          return this.closeUiRequest(cmd.requestId, "answered", cmd.value)
            ? { ok: true }
            : { ok: false, error: "no pending request" };
        case "custom_ui_input":
          return this.customUi.input(cmd.requestId, cmd.data)
            ? { ok: true }
            : { ok: false, error: "no active custom UI request" };
        case "custom_ui_resize":
          return this.customUi.resize(cmd.requestId, cmd.width)
            ? { ok: true }
            : { ok: false, error: "no active custom UI request" };
        case "custom_ui_cancel":
          return this.customUi.cancel(cmd.requestId)
            ? { ok: true }
            : { ok: false, error: "no active custom UI request" };
        default:
          return { ok: false, error: `unknown command` };
      }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  sendHistory(ws: WebSocket, beforeValue: number, requestId: string): void {
    const before = Math.max(0, Math.min(beforeValue, this.lastBranch.length));
    const from = Math.max(0, before - 150);
    const page = this.lastBranch.slice(from, before) as SessionSnapshot["messages"];
    this.send(ws, {
      type: "history",
      requestId,
      sessionId: this.session.sessionId,
      branchHeadId: this.lastBranchHeadId,
      messages: page,
      before: from,
    });
  }

  broadcast(msg: ServerMessage): void {
    for (const ws of this.sockets) this.send(ws, msg);
  }

  broadcastSnapshot(): void {
    this.broadcast({ type: "snapshot", snapshot: this.snapshot() });
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = (async () => {
      clearTimeout(this.idleTimer);
      clearTimeout(this.watchDebounceTimer);
      clearTimeout(this.watchRetryTimer);
      clearTimeout(this.pendingSnapshotTimer);
      this.pendingSnapshotTimer = undefined;
      this.teardownSessionUi("dispose");
      this.fileWatcher?.close();
      this.fileWatcher = undefined;
      this.watchedFile = undefined;
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      await this.runtime.dispose();
      for (const ws of this.sockets) ws.close(1000, "session disposed");
      this.sockets.clear();
    })();
    return this.disposePromise;
  }
}
