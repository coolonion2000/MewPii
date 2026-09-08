import { statSync, watch, type FSWatcher } from "node:fs";
import {
  open as openFile,
  stat as statFile,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { ResourceWatch } from "./resource-watch.js";
import { createHash } from "node:crypto";
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
  type Extension,
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
  PiiMessage,
  ServerMessage,
  SessionSnapshot,
  UiRequest,
  WidgetState,
} from "./protocol.js";
import { WEB_BUILTIN_SLASH_COMMANDS, runNativeCommand, NATIVE_COMMANDS } from "./native-commands.js";
import { SessionQueueAdapter } from "./queue-adapter.js";

export const SESSION_HISTORY_MAX_MESSAGES = 50;
export const SESSION_HISTORY_MAX_BYTES = 256 * 1024;

const SESSION_PREVIEW_READ_CHUNK_BYTES = 128 * 1024;
const SESSION_PREVIEW_MAX_SCAN_BYTES = 4 * 1024 * 1024;
const SESSION_PREVIEW_MAX_HEADER_BYTES = 1024 * 1024;

const SLOW_EXTENSION_HANDLER_MS = 500;
const SLOW_BIND_MS = 1_000;
const SLOW_SNAPSHOT_MS = 25;
const ACTIVE_TOOL_OUTPUT_SNAPSHOT_CHARS = 128 * 1024;
const ACTIVE_TOOL_ARGS_SNAPSHOT_BYTES = 64 * 1024;
// Cumulative checkpoints grow geometrically, so their total wire size remains
// linear in the generated output instead of repeating the whole message for
// every token. A reconnect never waits for one: snapshots carry the latest
// in-flight message directly.
const STREAM_CHECKPOINT_INITIAL_CHARS = 4 * 1024;

type SessionLogValue = string | number | boolean | null | undefined;

interface WatchedFileStamp {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
}

function watchedFileStamp(file: string): WatchedFileStamp {
  const value = statSync(file);
  return {
    size: value.size,
    mtimeMs: value.mtimeMs,
    ctimeMs: value.ctimeMs,
    ino: value.ino,
  };
}

function sameWatchedFileStamp(
  left: WatchedFileStamp,
  right: WatchedFileStamp,
): boolean {
  return (
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.ino === right.ino
  );
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round((performance.now() - startedAt) * 10) / 10);
}

function logStage(
  key: string,
  stage: string,
  startedAt: number,
  fields: Record<string, SessionLogValue> = {},
): void {
  const suffix = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) =>
      `${name}=${typeof value === "string" ? JSON.stringify(value) : String(value)}`,
    )
    .join(" ");
  process.stdout.write(
    `[session] stage_complete key=${JSON.stringify(key)} stage=${stage} duration_ms=${elapsedMs(startedAt)}${suffix ? ` ${suffix}` : ""}\n`,
  );
}

function messageBytes(message: Record<string, unknown>): number {
  try {
    return Buffer.byteLength(JSON.stringify(message));
  } catch {
    return SESSION_HISTORY_MAX_BYTES;
  }
}

function normalizedMessage(
  message: Record<string, unknown>,
  entryId?: string,
): Record<string, unknown> {
  // Never mutate SDK-owned branch objects while normalizing legacy bare
  // string blocks for the wire protocol.
  const content = Array.isArray(message.content)
    ? message.content.map((block) => {
        if (typeof block === "string") return { type: "text", text: block };
        if (block && typeof block === "object") return block;
        return { type: "text", text: String(block ?? "") };
      })
    : message.content;
  return { ...message, content, _entryId: entryId };
}

interface MessagePage {
  from: number;
  messages: Record<string, unknown>[];
  bytes: number;
  oversize: boolean;
}

/** Select a backwards page without splitting a message or stalling pagination. */
function messagePage(
  messages: readonly Record<string, unknown>[],
  sizes: number[],
  beforeValue: number,
): MessagePage {
  const before = Math.max(0, Math.min(beforeValue, messages.length));
  let from = before;
  let bytes = 2; // JSON array brackets
  let count = 0;
  while (from > 0 && count < SESSION_HISTORY_MAX_MESSAGES) {
    let candidateBytes = sizes[from - 1];
    if (candidateBytes === undefined) {
      candidateBytes = messageBytes(messages[from - 1]);
      sizes[from - 1] = candidateBytes;
    }
    const separatorBytes = count === 0 ? 0 : 1;
    if (
      count > 0 &&
      bytes + separatorBytes + candidateBytes > SESSION_HISTORY_MAX_BYTES
    )
      break;
    from--;
    bytes += separatorBytes + candidateBytes;
    count++;
  }
  // One over-budget message must still advance the cursor. Truncating it here
  // would make the durable history impossible to recover through pagination.
  const oversize = count === 1 && bytes > SESSION_HISTORY_MAX_BYTES;
  return {
    from,
    messages: messages.slice(from, before),
    bytes,
    oversize,
  };
}

function firstUserText(messages: readonly Record<string, unknown>[]): string {
  const first = messages.find((message) => message.role === "user");
  if (!first) return "";
  if (typeof first.content === "string") return first.content;
  if (!Array.isArray(first.content)) return "";
  return (
    first.content.find(
      (block) =>
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    ) as { text?: string } | undefined
  )?.text ?? "";
}

function toolOutputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const content = (value as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type?: string; text?: string } =>
        Boolean(block) && typeof block === "object" && !Array.isArray(block),
    )
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

function snapshotToolArgs(
  value: Record<string, unknown>,
): Record<string, unknown> | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(value)) <=
      ACTIVE_TOOL_ARGS_SNAPSHOT_BYTES
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

/** Temporarily wrap startup handlers so a single slow extension is identifiable. */
function instrumentExtensionHandlers(
  key: string,
  extensions: readonly Extension[],
): () => void {
  const restores: Array<() => void> = [];
  for (const extension of extensions) {
    for (const event of ["session_start", "resources_discover"] as const) {
      const handlers = extension.handlers.get(event);
      if (!handlers) continue;
      handlers.forEach((handler, index) => {
        const wrapped = async (...args: unknown[]): Promise<unknown> => {
          const startedAt = performance.now();
          let failed = false;
          const slowTimer = setTimeout(() => {
            process.stdout.write(
              `[session] extension_handler_slow key=${JSON.stringify(key)} extension=${JSON.stringify(extension.path)} event=${event} handler=${index} duration_ms=${SLOW_EXTENSION_HANDLER_MS} status=running\n`,
            );
          }, SLOW_EXTENSION_HANDLER_MS);
          slowTimer.unref();
          try {
            return await handler(...args);
          } catch (cause) {
            failed = true;
            throw cause;
          } finally {
            clearTimeout(slowTimer);
            const duration = elapsedMs(startedAt);
            if (duration >= SLOW_EXTENSION_HANDLER_MS) {
              process.stdout.write(
                `[session] extension_handler_complete key=${JSON.stringify(key)} extension=${JSON.stringify(extension.path)} event=${event} handler=${index} duration_ms=${duration} status=${failed ? "error" : "ok"}\n`,
              );
            }
          }
        };
        handlers[index] = wrapped;
        restores.push(() => {
          // Reload may have replaced the array while binding was in flight.
          if (handlers[index] === wrapped) handlers[index] = handler;
        });
      });
    }
  }
  return () => {
    for (const restore of restores) restore();
  };
}

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

/**
 * Strip SDK-only partials and, ordinarily, the cumulative message from a
 * message_update. Keeping that message on every token makes the wire O(n^2).
 */
export function serializeEvent(
  event: AgentSessionEvent,
  includeStreamingCheckpoint = false,
): Record<string, unknown> {
  try {
    const source = {
      ...(event as unknown as Record<string, unknown>),
    };
    if (event.type === "message_update" && !includeStreamingCheckpoint)
      delete source.message;
    const assistantEvent = source.assistantMessageEvent;
    if (
      assistantEvent &&
      typeof assistantEvent === "object" &&
      !Array.isArray(assistantEvent)
    ) {
      const { partial: _sdkPartial, ...publicAssistantEvent } =
        assistantEvent as Record<string, unknown>;
      source.assistantMessageEvent = publicAssistantEvent;
    }
    return JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
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
  /** Publish a read-only transcript before the full runtime is restored. */
  onPreview?: (snapshot: SessionSnapshot) => void | Promise<void>;
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

/** Lightweight projection for /api/runs; it never walks or normalizes a branch. */
export interface SessionRunView {
  sessionFile?: string;
  cwd: string;
  title: string;
  model?: string;
  modelName?: string;
  startedAt: number | null;
  isStreaming: boolean;
  queued: number;
  active: {
    toolName: string;
    summary: string;
    startedAt: number;
  }[];
}

interface LoginChoice {
  providerId: string;
  providerName: string;
  authType: "oauth" | "api_key";
  methodName: string;
  interactive: boolean;
}


function normalizedBranch(
  entries: readonly unknown[],
  initialHead?: string,
): { messages: Record<string, unknown>[]; branchHeadId?: string } {
  const messages: Record<string, unknown>[] = [];
  let branchHeadId = initialHead;
  for (const entry of entries) {
    const e = entry as { type?: string; id?: string; message?: unknown };
    if (e.id) branchHeadId = e.id;
    if (e.type !== "message" || !e.message || typeof e.message !== "object")
      continue;
    messages.push(
      normalizedMessage(e.message as Record<string, unknown>, e.id),
    );
  }
  return { messages, branchHeadId };
}

interface SessionPreviewData {
  snapshot: SessionSnapshot;
  messages: Record<string, unknown>[];
  messageSizes: number[];
  pageBytes: number;
}

interface RawSessionPreviewData extends SessionPreviewData {
  scannedBytes: number;
  branchComplete: boolean;
}

const transcriptPageKeyCache = new WeakMap<SessionSnapshot, string>();

function transcriptPageKey(snapshot: SessionSnapshot): string {
  const cached = transcriptPageKeyCache.get(snapshot);
  if (cached) return cached;
  const hash = createHash("sha256");
  hash.update(snapshot.sessionId);
  for (const message of snapshot.messages) {
    hash.update("\u0000");
    try {
      hash.update(JSON.stringify(message));
    } catch {
      hash.update(`unserializable:${messageBytes(message)}`);
    }
  }
  const key = `${snapshot.sessionId}\u0000${snapshot.messages.length}\u0000${hash.digest("hex")}`;
  transcriptPageKeyCache.set(snapshot, key);
  return key;
}

interface RawSessionHeader {
  type: "session";
  version?: number;
  id: string;
  cwd?: string;
}

function parsedRecord(raw: Buffer | string): Record<string, unknown> | undefined {
  const text = typeof raw === "string" ? raw : raw.toString("utf8");
  if (!text.trim()) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

async function readRawSessionHeader(
  handle: FileHandle,
  fileSize: number,
): Promise<RawSessionHeader | undefined> {
  const length = Math.min(fileSize, SESSION_PREVIEW_MAX_HEADER_BYTES);
  if (length === 0) return undefined;
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(buffer, 0, length, 0);
  const complete = buffer.subarray(0, bytesRead);
  let start = 0;
  for (let index = 0; index <= complete.length; index++) {
    const atBoundary = index === complete.length || complete[index] === 0x0a;
    if (!atBoundary) continue;
    // If the bounded read ended in the middle of a physical line, it cannot be
    // the header candidate yet. SessionManager has the same 1 MiB discovery
    // ceiling and will remain the authoritative fallback.
    if (
      index === complete.length &&
      bytesRead < fileSize &&
      complete.at(-1) !== 0x0a
    )
      break;
    const value = parsedRecord(complete.subarray(start, index));
    start = index + 1;
    if (!value) continue;
    if (value.type !== "session" || typeof value.id !== "string")
      return undefined;
    return value as unknown as RawSessionHeader;
  }
  return undefined;
}

/**
 * Read an accurate suffix of the durable leaf branch before SessionManager's
 * synchronous full-file restore. The preview deliberately reports only the
 * suffix as its temporary total; the authoritative snapshot patches paging
 * metadata once the runtime is available.
 */
export async function readRawSessionPreview(
  sessionPath: string,
  fallbackCwd: string,
): Promise<RawSessionPreviewData | undefined> {
  const handle = await openFile(sessionPath, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) return undefined;
    const header = await readRawSessionHeader(handle, info.size);
    // v1 entries receive generated IDs during SessionManager migration, so a
    // pre-open tree projection cannot safely identify their durable branch.
    if (!header || (header.version ?? 1) < 2) return undefined;

    const reversedMessages: Record<string, unknown>[] = [];
    const reversedSizes: number[] = [];
    let pageBytes = 2;
    let branchHeadId: string | undefined;
    let wantedParentId: string | null | undefined;
    let leafSelected = false;
    let branchComplete = false;
    let pageComplete = false;
    let thinkingLevel: string | undefined;
    let model: SessionSnapshot["model"];
    let name: string | undefined;
    let nameSeen = false;

    const inspectLine = (line: Buffer): void => {
      const entry = parsedRecord(line);
      if (!entry || entry.type === "session") return;

      // SessionManager resolves the title from physical order rather than the
      // active branch. Reverse scanning therefore finds the same latest entry.
      if (!nameSeen && entry.type === "session_info") {
        nameSeen = true;
        name = typeof entry.name === "string" && entry.name.trim()
          ? entry.name.trim()
          : undefined;
      }

      const id = typeof entry.id === "string" ? entry.id : undefined;
      if (!id) return;
      if (!leafSelected) {
        leafSelected = true;
        branchHeadId = id;
      } else if (wantedParentId !== id) {
        return;
      }

      const parentId = entry.parentId;
      wantedParentId = typeof parentId === "string" ? parentId : null;
      if (wantedParentId === null) branchComplete = true;

      if (
        thinkingLevel === undefined &&
        entry.type === "thinking_level_change" &&
        typeof entry.thinkingLevel === "string"
      )
        thinkingLevel = entry.thinkingLevel;
      if (
        !model &&
        entry.type === "model_change" &&
        typeof entry.provider === "string" &&
        typeof entry.modelId === "string"
      )
        model = {
          provider: entry.provider,
          id: entry.modelId,
          name: entry.modelId,
        };

      if (
        entry.type !== "message" ||
        !entry.message ||
        typeof entry.message !== "object" ||
        Array.isArray(entry.message)
      )
        return;
      const message = normalizedMessage(
        entry.message as Record<string, unknown>,
        id,
      );
      const size = messageBytes(message);
      const separatorBytes = reversedMessages.length === 0 ? 0 : 1;
      if (
        reversedMessages.length > 0 &&
        pageBytes + separatorBytes + size > SESSION_HISTORY_MAX_BYTES
      ) {
        pageComplete = true;
        return;
      }
      reversedMessages.push(message);
      reversedSizes.push(size);
      pageBytes += separatorBytes + size;
      if (reversedMessages.length >= SESSION_HISTORY_MAX_MESSAGES)
        pageComplete = true;
    };

    let position = info.size;
    let scannedBytes = 0;
    let carry = Buffer.alloc(0);
    while (
      position > 0 &&
      scannedBytes < SESSION_PREVIEW_MAX_SCAN_BYTES &&
      !pageComplete &&
      !branchComplete
    ) {
      const readLength = Math.min(
        SESSION_PREVIEW_READ_CHUNK_BYTES,
        position,
        SESSION_PREVIEW_MAX_SCAN_BYTES - scannedBytes,
      );
      const readPosition = position - readLength;
      const chunk = Buffer.allocUnsafe(readLength);
      const { bytesRead } = await handle.read(
        chunk,
        0,
        readLength,
        readPosition,
      );
      if (bytesRead === 0) break;
      scannedBytes += bytesRead;
      position = readPosition;
      const data = Buffer.concat([chunk.subarray(0, bytesRead), carry]);
      let lineEnd = data.length;
      for (let index = data.length - 1; index >= 0; index--) {
        if (data[index] !== 0x0a) continue;
        inspectLine(data.subarray(index + 1, lineEnd));
        lineEnd = index;
        if (pageComplete || branchComplete) break;
      }
      carry = Buffer.from(data.subarray(0, lineEnd));
    }
    if (
      position === 0 &&
      carry.length > 0 &&
      !pageComplete &&
      !branchComplete
    )
      inspectLine(carry);

    // A bounded window that cannot even reach one durable message is less
    // useful than the authoritative post-open fallback. Header-only files are
    // still safe to preview as an empty conversation.
    if (reversedMessages.length === 0 && position > 0) return undefined;

    const messages = reversedMessages.reverse();
    const messageSizes = reversedSizes.reverse();
    return {
      messages,
      messageSizes,
      pageBytes,
      scannedBytes,
      branchComplete,
      snapshot: {
        sessionId: header.id,
        sessionFile: sessionPath,
        branchHeadId,
        name,
        cwd: typeof header.cwd === "string" ? header.cwd : fallbackCwd,
        initializing: true,
        pagingProvisional: true,
        isStreaming: false,
        thinkingLevel: thinkingLevel ?? "off",
        model,
        messages: messages as SessionSnapshot["messages"],
        totalMessages: messages.length,
        historyFrom: 0,
        queue: { steering: [], followUp: [] },
        queueCapabilities: {
          revision: 0,
          reorder: false,
          remove: false,
          reason: "session is initializing",
        },
        tools: [],
        slashCommands: [...WEB_BUILTIN_SLASH_COMMANDS],
      },
    };
  } finally {
    await handle.close();
  }
}

/** Build the first visible frame without loading extensions, skills, or tools. */
function sessionPreview(sessionManager: SessionManager): SessionPreviewData {
  const branch = sessionManager.getBranch();
  const normalized = normalizedBranch(
    branch,
    sessionManager.getLeafId() ?? undefined,
  );
  // Size only the page we are about to send. Older entries are measured on
  // demand when the browser requests them instead of serializing an entire
  // multi-thousand-message branch during startup.
  const sizes = new Array<number>(normalized.messages.length);
  const page = messagePage(
    normalized.messages,
    sizes,
    normalized.messages.length,
  );
  let thinkingLevel = "off";
  let model: SessionSnapshot["model"];
  for (const value of branch) {
    const entry = value as {
      type?: string;
      thinkingLevel?: unknown;
      provider?: unknown;
      modelId?: unknown;
    };
    if (
      entry.type === "thinking_level_change" &&
      typeof entry.thinkingLevel === "string"
    )
      thinkingLevel = entry.thinkingLevel;
    if (
      entry.type === "model_change" &&
      typeof entry.provider === "string" &&
      typeof entry.modelId === "string"
    )
      model = {
        provider: entry.provider,
        id: entry.modelId,
        name: entry.modelId,
      };
  }
  return {
    messages: normalized.messages,
    messageSizes: sizes,
    pageBytes: page.bytes,
    snapshot: {
      sessionId: sessionManager.getSessionId(),
      sessionFile: sessionManager.getSessionFile(),
      branchHeadId: normalized.branchHeadId,
      name: sessionManager.getSessionName(),
      cwd: sessionManager.getCwd(),
      initializing: true,
      pagingProvisional: false,
      isStreaming: false,
      thinkingLevel,
      model,
      messages: page.messages as SessionSnapshot["messages"],
      totalMessages: normalized.messages.length,
      historyFrom: page.from,
      queue: { steering: [], followUp: [] },
      queueCapabilities: {
        revision: 0,
        reorder: false,
        remove: false,
        reason: "session is initializing",
      },
      tools: [],
      slashCommands: [...WEB_BUILTIN_SLASH_COMMANDS],
    },
  };
}

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
    private readonly stopSettleTimeoutMs = 10_000,
  ) {}

  private sockets = new Set<WebSocket>();
  /** New clients opt into metadata-only startup completion frames. */
  private readyDeltaSockets = new WeakSet<WebSocket>();
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
    {
      toolName: string;
      args: Record<string, unknown>;
      startedAt: number;
      liveOutput?: string;
    }
  >();
  /** Hook (set by index.ts) invoked on every tool execution start/end. */
  onToolExecution?: (toolName: string, phase: "start" | "end") => void;
  /** Full branch message list and leaf identity from the latest snapshot (for history paging). */
  private lastBranch: Record<string, unknown>[] = [];
  private lastBranchBytes: number[] = [];
  private lastBranchHeadId?: string;
  private branchCacheKey?: string;
  private statsCacheKey?: string;
  private statsCache?: SessionSnapshot["stats"];
  private resourceWatch?: ResourceWatch;
  private resourceReloadTimer?: NodeJS.Timeout;
  private resourcesDirty = false;
  private editorText = "";
  private slashCommandCache?: SessionSnapshot["slashCommands"];
  private runTitleCacheKey?: string;
  private runTitleText = "";
  private snapshotLogPending = true;
  /** Identity of the transcript page most recently delivered to attached viewers. */
  private deliveredTranscriptKey?: string;
  /** Direct constructor use in unit tests is ready; create() explicitly enters binding. */
  private readinessState: "binding" | "ready" = "ready";
  private readinessPromise: Promise<void> = Promise.resolve();
  private readinessGeneration = 0;
  private fileWatcher?: FSWatcher;
  private watchedFile?: string;
  private watchDebounceTimer?: NodeJS.Timeout;
  private watchRetryTimer?: NodeJS.Timeout;
  private pendingSnapshotTimer?: NodeJS.Timeout;
  /** Latest cumulative assistant state, sent only in snapshots/checkpoints. */
  private streamingMessage?: PiiMessage;
  private streamedDeltaChars = 0;
  private nextStreamCheckpointChars = STREAM_CHECKPOINT_INITIAL_CHARS;
  /** Current agent run start time (undefined when fully settled). */
  runStartedAt?: number;
  private settledMtime = 0;
  /** File state observed immediately after the initial synchronous restore. */
  private pendingWatchBaseline?: WatchedFileStamp;
  private reloading = false;
  private cooldownUntil = 0;
  private indexedSessionFile?: string;
  private disposePromise?: Promise<void>;
  private queueOperation: Promise<void> = Promise.resolve();
  private commandMutationChain: Promise<void> = Promise.resolve();
  /** Invalidates commands admitted before a stop request reaches the SDK. */
  private stopEpoch = 0;
  /** Coalesces concurrent stop requests and blocks new mutations until settled. */
  private stopPromise?: Promise<{
    ok: boolean;
    error?: string;
    data?: Record<string, unknown>;
  }>;
  /** Includes commands waiting in the cross-viewer mutation lane. */
  private pendingCommandMutations = 0;
  private emptyNotified = false;
  private readonly queueAdapter = new SessionQueueAdapter(() => this.session);

  static async create(
    key: string,
    opts: SessionHostOptions,
  ): Promise<SessionHost> {
    let initialSessionManager: SessionManager | undefined;
    let openedFileStamp: WatchedFileStamp | undefined;
    const createRuntime: CreateAgentSessionRuntimeFactory = async ({
      cwd,
      sessionManager,
      sessionStartEvent,
    }) => {
      const servicesStartedAt = performance.now();
      let extensionsFinishedAt: number | undefined;
      let extensionCount = 0;
      let extensionErrors = 0;
      try {
        const services = await createAgentSessionServices({
          cwd,
          resourceLoaderOptions: {
            extensionsOverride(base) {
              extensionsFinishedAt = performance.now();
              extensionCount = base.extensions.length;
              extensionErrors = base.errors.length;
              logStage(key, "extensions", servicesStartedAt, {
                cwd,
                extensions: extensionCount,
                errors: extensionErrors,
                status: "ok",
              });
              return base;
            },
          },
        });
        logStage(key, "resources", extensionsFinishedAt ?? servicesStartedAt, {
          cwd,
          skills: services.resourceLoader.getSkills().skills.length,
          prompts: services.resourceLoader.getPrompts().prompts.length,
          status: "ok",
        });
        logStage(key, "services", servicesStartedAt, {
          cwd,
          extensions: extensionCount,
          extension_errors: extensionErrors,
          status: "ok",
        });
        let effectiveSessionManager = sessionManager;
        if (
          opts.sessionPath &&
          initialSessionManager === sessionManager &&
          openedFileStamp
        ) {
          try {
            const currentStamp = watchedFileStamp(opts.sessionPath);
            if (!sameWatchedFileStamp(openedFileStamp, currentStamp)) {
              const refreshStartedAt = performance.now();
              effectiveSessionManager = SessionManager.open(opts.sessionPath);
              openedFileStamp = watchedFileStamp(opts.sessionPath);
              logStage(key, "restore_refresh", refreshStartedAt, {
                reason: "file_changed_during_services",
                status: "ok",
              });
            }
          } finally {
            // The factory is retained for future /new and /resume operations;
            // only the original restore needs this race-window verification.
            initialSessionManager = undefined;
          }
        }
        return {
          ...(await createAgentSessionFromServices({
            services,
            sessionManager: effectiveSessionManager,
            sessionStartEvent,
          })),
          services,
          diagnostics: services.diagnostics,
        };
      } catch (cause) {
        logStage(key, "services", servicesStartedAt, {
          cwd,
          status: "error",
          error: cause instanceof Error ? cause.message : String(cause),
        });
        throw cause;
      }
    };

    let sessionManager: SessionManager;
    let previewData: SessionPreviewData | undefined;
    let deliveredPreview: SessionSnapshot | undefined;
    if (opts.onPreview && opts.sessionPath) {
      const rawPreviewStartedAt = performance.now();
      try {
        const rawPreview = await readRawSessionPreview(
          opts.sessionPath,
          opts.cwd,
        );
        if (rawPreview) {
          await opts.onPreview(rawPreview.snapshot);
          deliveredPreview = rawPreview.snapshot;
          logStage(key, "preview_raw", rawPreviewStartedAt, {
            messages: rawPreview.snapshot.messages.length,
            page_bytes: rawPreview.pageBytes,
            scanned_bytes: rawPreview.scannedBytes,
            branch_complete: rawPreview.branchComplete,
            status: "ok",
          });
          // A synchronous SessionManager.open() follows. Give the websocket a
          // turn to flush and the browser a chance to paint the preview first.
          await new Promise<void>((resolvePromise) =>
            setImmediate(resolvePromise),
          );
        }
      } catch (cause) {
        logStage(key, "preview_raw", rawPreviewStartedAt, {
          status: "error",
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }

    const openStartedAt = performance.now();
    try {
      sessionManager = opts.sessionPath
        ? SessionManager.open(opts.sessionPath)
        : SessionManager.create(opts.cwd);
      initialSessionManager = sessionManager;
      const openedFile = sessionManager.getSessionFile();
      if (opts.sessionPath && openedFile) {
        try {
          openedFileStamp = watchedFileStamp(openedFile);
        } catch {
          // The runtime restore remains authoritative; watcher setup retries.
        }
      }
      logStage(key, "open", openStartedAt, {
        mode: opts.sessionPath ? "existing" : "new",
        status: "ok",
      });
    } catch (cause) {
      logStage(key, "open", openStartedAt, {
        mode: opts.sessionPath ? "existing" : "new",
        status: "error",
        error: cause instanceof Error ? cause.message : String(cause),
      });
      throw cause;
    }
    // Service discovery does not depend on authoritative transcript
    // normalization. Start both after the durable restore so warm extension
    // loads can overlap the full branch/page pass instead of waiting behind it.
    const runtimePromise = createAgentSessionRuntime(createRuntime, {
      cwd: sessionManager.getCwd(),
      agentDir: getAgentDir(),
      sessionManager,
    });
    // The preview callback may briefly wait for websocket backpressure. Attach
    // a rejection handler now so an early runtime failure is never reported as
    // unhandled before the authoritative preview has finished.
    void runtimePromise.catch(() => undefined);

    if (opts.onPreview) {
      const previewStartedAt = performance.now();
      try {
        previewData = sessionPreview(sessionManager);
        const changed =
          !deliveredPreview ||
          transcriptPageKey(deliveredPreview) !==
            transcriptPageKey(previewData.snapshot);
        if (changed) {
          await opts.onPreview(previewData.snapshot);
          deliveredPreview = previewData.snapshot;
        }
        logStage(key, "preview", previewStartedAt, {
          messages: previewData.snapshot.messages.length,
          total_messages: previewData.snapshot.totalMessages,
          page_bytes: previewData.pageBytes,
          delivery: changed ? "full" : "reused_raw",
          status: "ok",
        });
      } catch (cause) {
        logStage(key, "preview", previewStartedAt, {
          status: "error",
          error: cause instanceof Error ? cause.message : String(cause),
        });
        console.error(
          `[session] preview_failed key=${JSON.stringify(key)}`,
          cause,
        );
      }
    }
    const runtime = await runtimePromise;
    if (
      previewData &&
      runtime.session.sessionManager !== sessionManager
    ) {
      const reconcileStartedAt = performance.now();
      previewData = sessionPreview(runtime.session.sessionManager);
      if (
        opts.onPreview &&
        (!deliveredPreview ||
          transcriptPageKey(deliveredPreview) !==
            transcriptPageKey(previewData.snapshot))
      ) {
        await opts.onPreview(previewData.snapshot);
        deliveredPreview = previewData.snapshot;
      }
      logStage(key, "preview_reconcile", reconcileStartedAt, {
        messages: previewData.snapshot.messages.length,
        total_messages: previewData.snapshot.totalMessages,
        status: "ok",
      });
    }
    const runtimeFile = runtime.session.sessionFile;
    if (runtimeFile) {
      try {
        openedFileStamp = watchedFileStamp(runtimeFile);
      } catch {
        openedFileStamp = undefined;
      }
    }

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
    host.pendingWatchBaseline = openedFileStamp;
    if (previewData) {
      let liveMessageCount = -1;
      try {
        liveMessageCount = runtime.session.messages.length;
      } catch {
        // Keep the same conservative fallback used by refreshBranchCache().
      }
      const leafId =
        runtime.session.sessionManager.getLeafId() ?? undefined;
      host.lastBranch = previewData.messages;
      host.lastBranchBytes = previewData.messageSizes;
      host.lastBranchHeadId = leafId;
      host.branchCacheKey = `${runtime.session.sessionId}\u0000${runtime.session.sessionFile ?? ""}\u0000${leafId ?? ""}\u0000${liveMessageCount}`;
      host.runTitleCacheKey = host.branchCacheKey;
      host.runTitleText = firstUserText(previewData.messages);
    }
    host.indexedSessionFile = runtime.session.sessionFile;

    runtime.setBeforeSessionInvalidate(() => host.teardownSessionUi("rebind"));
    runtime.setRebindSession(async (session) => {
      const previousFile = host.indexedSessionFile;
      host.invalidateSnapshotCaches(true);
      host.modelRegistry = new ModelRegistry(
        host.runtime.services.modelRuntime,
      );
      host.bindSession();
      host.restartFileWatch();
      host.indexedSessionFile = session.sessionFile;
      await host.onSessionChanged?.(host, previousFile, session.sessionFile);
      const binding = host.startExtensionBinding(session);
      host.broadcastSnapshot();
      await binding;
    });
    host.bindSession();
    host.restartFileWatch();
    // Do not await: session_start may open an interactive UI request. Returning
    // the host first lets index.ts attach a socket and answer it immediately.
    void host.startExtensionBinding(runtime.session);
    return host;
  }

  /** True after extension session_start/resource discovery has settled. */
  get isReady(): boolean {
    return this.readinessState === "ready";
  }

  /**
   * Wait for the current extension bind. Binding errors are reported in logs
   * but resolve this promise, matching the existing optional-extension policy.
   */
  whenReady(): Promise<void> {
    return this.readinessPromise;
  }

  private invalidateSnapshotCaches(includeCommands = false): void {
    this.branchCacheKey = undefined;
    this.statsCacheKey = undefined;
    this.statsCache = undefined;
    this.runTitleCacheKey = undefined;
    this.runTitleText = "";
    this.snapshotLogPending = true;
    if (includeCommands) this.slashCommandCache = undefined;
  }

  /** Start a bind without making host creation wait on extension-owned UI. */
  private startExtensionBinding(session: AgentSession): Promise<void> {
    const generation = ++this.readinessGeneration;
    this.readinessState = "binding";
    this.slashCommandCache = undefined;
    this.snapshotLogPending = true;
    const startedAt = performance.now();
    let restoreHandlers: () => void = () => undefined;
    try {
      restoreHandlers = instrumentExtensionHandlers(
        this.key,
        session.resourceLoader.getExtensions().extensions,
      );
    } catch (cause) {
      console.error(
        `[session] extension_instrument_failed key=${JSON.stringify(this.key)}`,
        cause,
      );
    }
    const slowTimer = setTimeout(() => {
      process.stdout.write(
        `[session] bind_slow key=${JSON.stringify(this.key)} duration_ms=${SLOW_BIND_MS} status=running\n`,
      );
    }, SLOW_BIND_MS);
    slowTimer.unref();

    const binding = (async () => {
      let status = "ok";
      let error: string | undefined;
      try {
        await this.bindExtensionUi(session);
      } catch (cause) {
        status = "error";
        error = cause instanceof Error ? cause.message : String(cause);
        console.error(
          `[session] bind_failed key=${JSON.stringify(this.key)} error=${JSON.stringify(error)}`,
          cause,
        );
      } finally {
        clearTimeout(slowTimer);
        restoreHandlers();
        logStage(this.key, "bind", startedAt, {
          status,
          error,
          extensions: (() => {
            try {
              return session.resourceLoader.getExtensions().extensions.length;
            } catch {
              return undefined;
            }
          })(),
        });
        if (generation === this.readinessGeneration) {
          this.readinessState = "ready";
          this.slashCommandCache = undefined;
          this.snapshotLogPending = true;
          this.broadcastReadyState();
          this.restartResourceWatch();
        }
      }
    })();
    this.readinessPromise = binding;
    return binding;
  }

  private restartResourceWatch(): void {
    this.resourceWatch?.close();
    if (this.disposed || !this.runtime.services?.agentDir) return;
    const files = this.session.resourceLoader.getExtensions().extensions.map(extension => extension.path);
    this.resourceWatch = new ResourceWatch([
      this.runtime.services.agentDir, join(this.cwd, ".pi"),
      join(this.cwd, ".agents"), join(homedir(), ".agents"),
    ], files, () => {
      this.resourcesDirty = true;
      this.scheduleResourceReload();
    });
  }

  private get resourceReloadBlocked(): boolean {
    const s = this.session;
    return Boolean(s.isStreaming || s.isCompacting || s.isRetrying || s.isBashRunning
      || this.stopPromise || this.reloading || this.activeToolCalls.size
      || this.uiPending.size || this.customUi.isActive);
  }

  private scheduleResourceReload(): void {
    clearTimeout(this.resourceReloadTimer);
    if (this.disposed || !this.resourcesDirty) return;
    this.resourceReloadTimer = setTimeout(() => {
      if (this.disposed) return;
      if (!this.isReady || this.resourceReloadBlocked || this.pendingCommandMutations > 0 || this.sockets.size === 0) {
        this.scheduleResourceReload();
        return;
      }
      this.resourcesDirty = false;
      void this.withCommandMutation(async () => {
        // Recheck admission after waiting for another browser's command.
        if (this.resourceReloadBlocked) {
          this.resourcesDirty = true;
          return { ok: true };
        }
        console.log(`[session] resource_reload_started key=${JSON.stringify(this.key)}`);
        const result = await this.runSlash("/reload");
        if (!result.ok) this.broadcast({ type: "toast", message: `插件自动重载失败：${result.error}；可执行 /reload 重试。`, level: "warning" });
        return result;
      }).catch(cause => {
        console.error(`[session] resource_reload_failed key=${JSON.stringify(this.key)}`, cause);
        this.broadcast({ type: "toast", message: `插件自动重载失败：${cause instanceof Error ? cause.message : String(cause)}；可执行 /reload 重试。`, level: "warning" });
        this.slashCommandCache = undefined;
        this.broadcastSnapshot();
      }).finally(() => this.scheduleResourceReload());
    }, 1_000);
    this.resourceReloadTimer.unref();
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
      const installedStamp = watchedFileStamp(file);
      const restoreStamp = this.pendingWatchBaseline;
      this.pendingWatchBaseline = undefined;
      this.settledMtime = installedStamp.mtimeMs;
      this.watchedFile = file;
      this.fileWatcher = watch(file, () => this.scheduleExternalReload(1500));
      const knownLeaf = this.runtime.session.sessionManager.getLeafId();
      if (
        restoreStamp &&
        !sameWatchedFileStamp(restoreStamp, installedStamp)
      ) {
        process.stdout.write(
          `[watch] restore_window_change file=${JSON.stringify(file)} action=reload\n`,
        );
        this.scheduleExternalReload(0);
      } else {
        void this.verifyWatchBaseline(file, installedStamp, knownLeaf);
      }
    } catch {
      // Brand-new sessions are watched lazily after their first persisted entry.
    }
  }

  /** Close the stat→watch race and detect appends during runtime creation. */
  private async verifyWatchBaseline(
    file: string,
    installedStamp: WatchedFileStamp,
    knownLeaf: string | null,
  ): Promise<void> {
    try {
      const [value, tailId] = await Promise.all([
        statFile(file),
        lastEntryId(file),
      ]);
      if (this.disposed || this.watchedFile !== file) return;
      const after: WatchedFileStamp = {
        size: value.size,
        mtimeMs: value.mtimeMs,
        ctimeMs: value.ctimeMs,
        ino: value.ino,
      };
      if (
        !sameWatchedFileStamp(installedStamp, after) ||
        (tailId !== undefined && tailId !== knownLeaf)
      ) {
        process.stdout.write(
          `[watch] install_window_change file=${JSON.stringify(file)} action=reload\n`,
        );
        this.scheduleExternalReload(0);
      }
    } catch {
      // The normal watch retry path handles replacement/disappearance.
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
    if (this.isRunning || this.reloading) {
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
          pasteToEditor(text: string) {
            host.editorText += text;
            host.broadcast({ type: "editor_text", text, mode: "append" });
          },
          setEditorText(text: string) {
            host.editorText = text;
            host.broadcast({ type: "editor_text", text, mode: "replace" });
          },
          getEditorText() { return host.editorText; },
          editor(title: string, prefill?: string) {
            return host.uiRequest<string | undefined>({ kind: "editor", title, content: prefill });
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
    } catch (cause) {
      // The readiness owner records the failure and deliberately settles. Keep
      // this contextual log, but rethrow so bind status cannot be reported ok.
      console.error(
        `[session] extension_bind_failed key=${JSON.stringify(this.key)}`,
        cause,
      );
      throw cause;
    }
  }

  private enqueueUi<T>(open: () => Promise<T>): Promise<T> {
    const admittedEpoch = this.stopEpoch;
    const result = this.uiQueue.then(() => {
      if (this.disposed) throw new Error("session disposed");
      if (this.stopPromise || admittedEpoch !== this.stopEpoch)
        throw new Error("session operation was cancelled by stop");
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
    const staleTools = [...this.activeToolCalls.values()];
    this.activeToolCalls.clear();
    for (const tool of staleTools)
      this.onToolExecution?.(tool.toolName, "end");
    this.streamingMessage = undefined;
    this.streamedDeltaChars = 0;
    this.nextStreamCheckpointChars = STREAM_CHECKPOINT_INITIAL_CHARS;
    this.runStartedAt = undefined;
    const session = this.runtime.session;
    this.unsubscribe = session.subscribe((event) => {
      if (
        event.type === "entry_appended" ||
        event.type === "agent_settled" ||
        event.type === "compaction_end"
      ) {
        this.invalidateSnapshotCaches();
      } else if (event.type === "session_info_changed") {
        this.statsCacheKey = undefined;
        this.statsCache = undefined;
        this.snapshotLogPending = true;
      }
      let includeStreamingCheckpoint = false;
      if (event.type === "agent_start") {
        this.streamingMessage = undefined;
        this.streamedDeltaChars = 0;
        this.nextStreamCheckpointChars = STREAM_CHECKPOINT_INITIAL_CHARS;
      } else if (event.type === "message_start") {
        const message = (event as unknown as { message?: PiiMessage }).message;
        if (message?.role === "assistant") {
          this.streamingMessage = message;
          this.streamedDeltaChars = 0;
          this.nextStreamCheckpointChars = STREAM_CHECKPOINT_INITIAL_CHARS;
        }
      } else if (event.type === "message_update") {
        const update = event as unknown as {
          message?: PiiMessage;
          assistantMessageEvent?: { delta?: unknown };
        };
        if (update.message?.role === "assistant")
          this.streamingMessage = update.message;
        const delta = update.assistantMessageEvent?.delta;
        if (typeof delta === "string") {
          this.streamedDeltaChars += delta.length;
          if (
            update.message?.role === "assistant" &&
            this.streamedDeltaChars >= this.nextStreamCheckpointChars
          ) {
            includeStreamingCheckpoint = true;
            while (
              this.nextStreamCheckpointChars <= this.streamedDeltaChars &&
              this.nextStreamCheckpointChars <= Number.MAX_SAFE_INTEGER / 2
            ) {
              this.nextStreamCheckpointChars *= 2;
            }
          }
        }
      }
      const serializedEvent = serializeEvent(
        event,
        includeStreamingCheckpoint,
      );
      if (event.type === "queue_update") {
        const queue = this.queueAdapter.view();
        serializedEvent.steering = queue.steering;
        serializedEvent.followUp = queue.followUp;
        serializedEvent.queueCapabilities = queue.capabilities;
      }
      this.broadcast({ type: "event", event: serializedEvent });
      if (
        event.type === "message_end" ||
        event.type === "agent_end" ||
        event.type === "agent_settled"
      ) {
        this.streamingMessage = undefined;
        this.streamedDeltaChars = 0;
        this.nextStreamCheckpointChars = STREAM_CHECKPOINT_INITIAL_CHARS;
      }
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
      if (event.type === "tool_execution_update") {
        const e = event as unknown as {
          toolCallId?: string;
          partialResult?: unknown;
          update?: unknown;
        };
        const active = e.toolCallId
          ? this.activeToolCalls.get(e.toolCallId)
          : undefined;
        if (active) {
          const output = toolOutputText(e.partialResult ?? e.update);
          active.liveOutput = output.slice(-ACTIVE_TOOL_OUTPUT_SNAPSHOT_CHARS);
        }
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
    return this.withCommandMutation(async () => {
      // Re-check after waiting for an earlier mutation: another viewer may
      // have attached while the REST upload was being parsed.
      if (this.sockets.size > 1)
        return {
          ok: false,
          error: "当前会话在多个窗口中打开；请只保留一个窗口后再导入会话。",
        };
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
    });
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

  attach(
    ws: WebSocket,
    preview?: SessionSnapshot,
    supportsReadyDelta = true,
  ): void {
    if (this.disposed || this.disposePromise) {
      process.stdout.write(
        `[session] attach_rejected key=${JSON.stringify(this.key)} reason=disposing_or_disposed\n`,
      );
      throw new Error("session host is disposing or disposed");
    }
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.retainedForBackgroundWork = false;
    this.sockets.add(ws);
    if (supportsReadyDelta) this.readyDeltaSockets.add(ws);
    const snapshot = this.snapshot();
    const transcriptKey = this.transcriptKey(snapshot);
    if (
      preview &&
      transcriptPageKey(preview) === transcriptPageKey(snapshot)
    ) {
      this.deliveredTranscriptKey = transcriptKey;
      if (this.isReady) {
        if (supportsReadyDelta) {
          const { messages: _messages, ...readySnapshot } = snapshot;
          this.send(ws, { type: "session_ready", snapshot: readySnapshot });
        } else {
          this.send(ws, { type: "snapshot", snapshot });
        }
      }
      process.stdout.write(
        `[session] snapshot_delivery key=${JSON.stringify(this.key)} delivery=attach_reuse snapshot_bytes=0 viewers=${this.sockets.size}\n`,
      );
    } else {
      const snapshotWire = JSON.stringify({ type: "snapshot", snapshot });
      this.sendSerialized(ws, snapshotWire);
      this.deliveredTranscriptKey = transcriptKey;
      process.stdout.write(
        `[session] snapshot_delivery key=${JSON.stringify(this.key)} delivery=attach snapshot_bytes=${Buffer.byteLength(snapshotWire)} viewers=${this.sockets.size}\n`,
      );
    }
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
    this.readyDeltaSockets.delete(ws);
    if (!this.disposed && this.sockets.size === 0)
      this.scheduleIdleCheck(this.idleGraceMs);
  }

  private scheduleIdleCheck(delayMs: number): void {
    if (this.disposed) return;
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
    // Remove the host from the shared index before disposal awaits. A socket
    // arriving in that window must create a replacement instead of attaching
    // to a runtime that is already closing.
    this.notifyEmpty();
    try {
      await this.dispose();
    } catch (cause) {
      console.error(
        `[session] detached_dispose_failed key=${JSON.stringify(this.key)}`,
        cause,
      );
    }
  }

  private notifyEmpty(): void {
    if (this.emptyNotified) return;
    this.emptyNotified = true;
    try {
      this.onEmpty?.(this);
    } catch (cause) {
      console.error(
        `[session] detached_remove_failed key=${JSON.stringify(this.key)}`,
        cause,
      );
    }
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
    if (this.disposed) return false;
    const session = this.session;
    return Boolean(
      !this.isReady ||
        this.reloading ||
        this.stopPromise ||
        this.pendingCommandMutations > 0 ||
        session.isStreaming ||
        session.isCompacting ||
        session.isRetrying ||
        session.isBashRunning ||
        this.activeToolCalls.size > 0 ||
        this.uiPending.size > 0 ||
        this.customUi.isActive,
    );
  }

  private slashCommands(): SessionSnapshot["slashCommands"] {
    if (this.slashCommandCache) return this.slashCommandCache;
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
      if (session.settingsManager?.getEnableSkillCommands?.() !== false) {
        for (const skill of session.resourceLoader.getSkills().skills)
          add(`skill:${skill.name}`, skill.description, "skill");
      }
    } catch (cause) {
      console.error(`[session] slash_commands_failed key=${this.key}`, cause);
    }
    this.slashCommandCache = commands;
    return this.slashCommandCache;
  }

  private refreshBranchCache(session: AgentSession): boolean {
    let leafId: string | undefined;
    try {
      leafId = session.sessionManager.getLeafId() ?? undefined;
    } catch {
      leafId = undefined;
    }
    let liveMessageCount = -1;
    try {
      liveMessageCount = session.messages.length;
    } catch {
      // A session manager leaf is normally sufficient; this only weakens the
      // fallback cache key for test doubles and partially initialized sessions.
    }
    const cacheKey = `${session.sessionId}\u0000${session.sessionFile ?? ""}\u0000${leafId ?? ""}\u0000${liveMessageCount}`;
    if (this.branchCacheKey === cacheKey) return true;

    let messages: Record<string, unknown>[] = [];
    let branchHeadId = leafId;
    try {
      const normalized = normalizedBranch(
        session.sessionManager.getBranch(),
        branchHeadId,
      );
      messages = normalized.messages;
      branchHeadId = normalized.branchHeadId;
    } catch (cause) {
      console.error(
        `[session] branch_read_failed key=${JSON.stringify(this.key)}`,
        cause,
      );
    }
    if (messages.length === 0) {
      try {
        // SAFETY: structuredClone preserves the JSON-safe AgentMessage layout.
        messages = structuredClone(session.messages) as unknown as Record<
          string,
          unknown
        >[];
      } catch {
        messages = [];
      }
    }

    this.lastBranch = messages;
    // Keep a sparse per-entry size cache. messagePage() fills it one requested
    // page at a time, which keeps ordinary snapshots proportional to the
    // visible tail rather than the full durable history.
    this.lastBranchBytes = new Array<number>(messages.length);
    this.lastBranchHeadId = branchHeadId;
    this.branchCacheKey = cacheKey;
    this.statsCacheKey = undefined;
    this.statsCache = undefined;
    this.runTitleCacheKey = cacheKey;
    this.runTitleText = firstUserText(messages);
    return false;
  }

  private syncIndexedSessionFile(session: AgentSession): void {
    if (session.sessionFile === this.indexedSessionFile) return;
    const previousFile = this.indexedSessionFile;
    this.indexedSessionFile = session.sessionFile;
    void Promise.resolve(
      this.onSessionChanged?.(this, previousFile, session.sessionFile),
    ).catch((cause) =>
      console.error(`[session] index_update_failed key=${this.key}`, cause),
    );
  }

  snapshot(): SessionSnapshot {
    const startedAt = performance.now();
    const s = this.session;
    const model = s.model;
    this.syncIndexedSessionFile(s);

    const branchCacheHit = this.refreshBranchCache(s);
    const total = this.lastBranch.length;
    const page = messagePage(
      this.lastBranch,
      this.lastBranchBytes,
      total,
    );

    let stats: SessionSnapshot["stats"];
    if (this.isReady) {
      if (this.statsCacheKey !== this.branchCacheKey) {
        try {
          const st = s.getSessionStats();
          this.statsCache = {
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
          this.statsCache = undefined;
        }
        this.statsCacheKey = this.branchCacheKey;
      }
      stats = this.statsCache;
    }

    // Brand-new sessions have no file at host creation; attach the watcher
    // lazily once the file exists.
    if (
      (!this.fileWatcher || this.watchedFile !== s.sessionFile) &&
      s.sessionFile
    )
      this.restartFileWatch();

    const queue = this.queueAdapter.view();
    const snapshot: SessionSnapshot = {
      sessionId: s.sessionId,
      sessionFile: s.sessionFile,
      branchHeadId: this.lastBranchHeadId,
      name: s.sessionName,
      cwd: this.runtime.cwd,
      initializing: !this.isReady,
      pagingProvisional: false,
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
      messages: page.messages as SessionSnapshot["messages"],
      totalMessages: total,
      historyFrom: page.from,
      queue: {
        steering: queue.steering,
        followUp: queue.followUp,
      },
      queueCapabilities: queue.capabilities,
      stats,
      // Discovery is complete before bindExtensions emits session_start. These
      // may be displayed while initializing, but handleCommand still prevents
      // execution until readiness settles.
      tools: s.getActiveToolNames(),
      activeToolCalls: [...this.activeToolCalls].map(([toolCallId, tool]) => ({
        toolCallId,
        toolName: tool.toolName,
        args: snapshotToolArgs(tool.args),
        startedAt: tool.startedAt,
        liveOutput: tool.liveOutput,
      })),
      streamingMessage:
        s.isStreaming && this.streamingMessage?.role === "assistant"
          ? this.streamingMessage
          : null,
      slashCommands: this.slashCommands(),
    };
    const duration = elapsedMs(startedAt);
    if (
      this.snapshotLogPending ||
      duration >= SLOW_SNAPSHOT_MS ||
      page.oversize
    ) {
      logStage(this.key, "snapshot", startedAt, {
        cache: branchCacheHit ? "hit" : "miss",
        messages: page.messages.length,
        total_messages: total,
        page_bytes: page.bytes,
        oversize: page.oversize,
        initializing: !this.isReady,
      });
      this.snapshotLogPending = false;
    }
    return snapshot;
  }

  runView(): SessionRunView {
    const s = this.session;
    let messageCount = -1;
    try {
      messageCount = s.messages.length;
    } catch {
      // Partial test doubles may not expose messages.
    }
    const titleKey = `${s.sessionId}\u0000${messageCount}`;
    if (this.runTitleCacheKey !== titleKey) {
      this.runTitleCacheKey = titleKey;
      try {
        this.runTitleText = firstUserText(
          s.messages as unknown as Record<string, unknown>[],
        );
      } catch {
        this.runTitleText = "";
      }
    }
    const queue = this.queueAdapter.view();
    return {
      sessionFile: s.sessionFile,
      cwd: this.cwd,
      title: s.sessionName || this.runTitleText.slice(0, 60) || "(新会话)",
      model: s.model ? `${s.model.provider}/${s.model.id}` : undefined,
      modelName: s.model?.name,
      startedAt: this.runStartedAt ?? null,
      isStreaming: this.isRunning,
      queued: queue.steering.length + queue.followUp.length,
      active: this.activeExecutions,
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

  /** Pick up models.json edits made while this conversation was already open. */
  private async findModel(provider: string, modelId: string) {
    let model = this.modelRegistry.find(provider, modelId);
    if (model) return model;
    try {
      await this.modelRegistry.refresh({
        allowNetwork: false,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      console.error(
        `[models] session_refresh_failed key=${JSON.stringify(this.key)} provider=${JSON.stringify(provider)} model=${JSON.stringify(modelId)} error=${JSON.stringify(error)}`,
      );
    }
    model = this.modelRegistry.find(provider, modelId);
    return model;
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
    const parsed = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text);
    const name = parsed?.[1] ?? "";
    const arg = parsed?.[2]?.trim() ?? "";
    const out = (o: string) => ({ ok: true, data: { output: o } });
    if (["new", "fork", "clone", "resume", "import", "tree"].includes(name) && this.sockets.size > 1) {
      return {
        ok: false,
        error: `当前会话在多个窗口中打开；请只保留一个窗口后再执行 /${name}。`,
      };
    }
    if (
      (s.isStreaming || s.isCompacting) &&
      (Object.hasOwn(NATIVE_COMMANDS, name) && !["session", "copy", "changelog", "hotkeys", "quit"].includes(name))
    ) {
      return {
        ok: false,
        error: `当前回复仍在运行，暂不能执行 /${name}；请先停止或等待完成。`,
      };
    }
    // Built-in TUI components and plugin custom() use one serialized UI lane.
    if (!(name === "model" && arg.includes("/"))) {
      try {
        const result = await runNativeCommand(name, arg, {
          session: s, runtime: this.runtime,
          assertCanReplace: () => {
            if (this.sockets.size > 1) throw new Error("当前会话在多个窗口中打开，请只保留一个窗口后再切换会话。");
            if (this.disposed || this.stopPromise || this.session !== s) throw new Error("会话操作已取消。");
          },
          ui: request => this.uiRequest(request),
          custom: factory => this.customUiRequest(factory),
        });
        if (result) {
          this.invalidateSnapshotCaches(true);
          this.broadcastSnapshot();
          return { ok: true, data: { ...result } };
        }
      } catch (cause) {
        return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
      }
    }
    switch (name) {
      case "compact":
        await s.compact(arg || undefined);
        return out("已触发上下文压缩。");
      case "name":
        if (!arg) return out(s.sessionName ? `当前会话名：${s.sessionName}` : "用法: /name <会话名>");
        s.setSessionName(arg);
        this.broadcastSnapshot();
        return out(`会话已命名为：${arg}`);
      case "session": {
        const st = s.sessionName ?? "";
        const model = s.model ? `${s.model.provider}/${s.model.id}` : "-";
        return out(
          `会话: ${st || "(未命名)"}\n模型: ${model}\n流式: ${s.isStreaming ? "是" : "否"}\n${JSON.stringify(s.getSessionStats(), null, 2)}`,
        );
      }
      case "new": {
        const result = await this.runtime.newSession();
        this.broadcastSnapshot();
        return out(result.cancelled ? "已取消。" : "已新建会话。");
      }
      case "reload":
        if (s.isStreaming)
          return { ok: false, error: "请等待当前回复结束后再执行 /reload。" };
        if (s.isCompacting)
          return { ok: false, error: "请等待上下文压缩结束后再执行 /reload。" };
        if (this.pendingUiRequest || this.customUi.isActive)
          return { ok: false, error: "请先关闭当前弹窗，再执行 /reload。" };
        console.log(`[session] reload_started key=${this.key}`);
        this.slashCommandCache = undefined;
        try {
          await s.reload({
            beforeSessionStart: () => {
              this.widgets.clear();
              this.statuses.clear();
              this.broadcastWidgets();
              this.broadcastStatuses();
            },
          });
        } finally {
          this.slashCommandCache = undefined;
        }
        this.restartResourceWatch();
        this.broadcastSnapshot();
        console.log(`[session] reload_completed key=${this.key}`);
        return out("已重新加载扩展、技能、提示词、设置和上下文文件。");
      case "model": {
        // /model <provider/modelId> — resolve current within the model registry
        const [prov, ...mid] = arg.split("/");
        if (!prov || mid.length === 0)
          return { ok: false, error: "用法: /model <provider/modelId>" };
        const model = await this.findModel(prov, mid.join("/"));
        if (!model) return { ok: false, error: `模型未找到: ${arg}` };
        await s.setModel(model, { persist: false });
        this.statsCacheKey = undefined;
        this.statsCache = undefined;
        this.broadcastSnapshot();
        return out(`已切换模型：${model.name ?? model.id}`);
      }
      case "login":
        return out(await this.runLoginCommand(arg || undefined));
      case "logout":
        return out(await this.runLogoutCommand(arg || undefined));
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
          const wasStreaming = s.isStreaming;
          await s.prompt(`/${text}`, {
            streamingBehavior: wasStreaming ? "steer" : undefined,
          });
          // AgentSession emits queue_update before both of its queue mirrors are
          // stable. Publish one settled snapshot so mutation controls recover.
          this.slashCommandCache = undefined;
          this.broadcastSnapshot();
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

  private withQueueOperation(
    operation: () => Promise<{
      ok: boolean;
      error?: string;
      data?: Record<string, unknown>;
    }>,
  ): Promise<{
    ok: boolean;
    error?: string;
    data?: Record<string, unknown>;
  }> {
    const admittedEpoch = this.stopEpoch;
    const result = this.queueOperation.then(() => {
      if (this.disposed)
        return { ok: false, error: "session host is disposed" };
      if (this.stopPromise || admittedEpoch !== this.stopEpoch)
        return {
          ok: false,
          error: "session operation was cancelled by stop",
        };
      return operation();
    });
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

  /**
   * Cancel every operation owned by the current session as one stop boundary.
   * Queue clearing happens on both sides of settlement so a racing SDK queue
   * update cannot resurrect work after the user pressed stop.
   */
  private stopAll(): Promise<{
    ok: boolean;
    error?: string;
    data?: Record<string, unknown>;
  }> {
    if (this.stopPromise) return this.stopPromise;
    const epoch = ++this.stopEpoch;
    const initialSession = this.session;
    const startedAt = performance.now();
    const deadline = startedAt + this.stopSettleTimeoutMs;
    const queueBarrier = this.queueOperation;
    const mutationBarrier = this.commandMutationChain;
    const hadPendingMutations = this.pendingCommandMutations > 0;
    const failures: string[] = [];
    let clearedQueue = 0;
    let closedUi = 0;

    const recordFailure = (operation: string, cause: unknown): void => {
      const error = cause instanceof Error ? cause.message : String(cause);
      failures.push(`${operation}: ${error}`);
      console.error(
        `[session] stop_operation_failed key=${JSON.stringify(this.key)} operation=${operation} error=${JSON.stringify(error)}`,
      );
    };
    const clearQueue = (session: AgentSession, phase: string): void => {
      try {
        const cleared = session.clearQueue();
        clearedQueue +=
          (Array.isArray(cleared?.steering) ? cleared.steering.length : 0) +
          (Array.isArray(cleared?.followUp) ? cleared.followUp.length : 0);
      } catch (cause) {
        recordFailure(`clear_queue_${phase}`, cause);
      }
    };
    const invoke = (operation: string, action: (() => void) | undefined): void => {
      if (!action) return;
      try {
        action();
      } catch (cause) {
        recordFailure(operation, cause);
      }
    };
    const closeUi = (): void => {
      closedUi += this.uiPending.size + (this.customUi.isActive ? 1 : 0);
      for (const id of [...this.uiPending.keys()])
        this.closeUiRequest(id, "dispose", undefined);
      this.pendingUiRequest = undefined;
      this.customUi.dispose();
    };
    const abortSession = (session: AgentSession, prefix: string): Promise<void> => {
      const stoppable = session as AgentSession & {
        abortRetry?: () => void;
        abortCompaction?: () => void;
        abortBranchSummary?: () => void;
        abortBash?: () => void;
        agent?: { abort?: () => void };
      };
      invoke(`${prefix}abort_retry`, stoppable.abortRetry?.bind(stoppable));
      invoke(
        `${prefix}abort_compaction`,
        stoppable.abortCompaction?.bind(stoppable),
      );
      invoke(
        `${prefix}abort_branch_summary`,
        stoppable.abortBranchSummary?.bind(stoppable),
      );
      invoke(`${prefix}abort_bash`, stoppable.abortBash?.bind(stoppable));
      invoke(
        `${prefix}agent_abort`,
        stoppable.agent?.abort?.bind(stoppable.agent),
      );
      try {
        return Promise.resolve(session.abort());
      } catch (cause) {
        recordFailure(`${prefix}abort`, cause);
        return Promise.resolve();
      }
    };
    const settleUntilDeadline = async (
      operations: { name: string; promise: Promise<unknown> }[],
      timeoutOperation: string,
    ): Promise<boolean> => {
      const remaining = Math.max(0, deadline - performance.now());
      if (remaining <= 0) {
        recordFailure(
          timeoutOperation,
          new Error(`did not settle within ${this.stopSettleTimeoutMs}ms`),
        );
        return false;
      }
      const settlement = Promise.allSettled(
        operations.map((operation) => operation.promise),
      );
      let timeout: NodeJS.Timeout | undefined;
      const timedOut = Symbol("stop settlement timeout");
      const settled = await Promise.race([
        settlement,
        new Promise<typeof timedOut>((resolvePromise) => {
          timeout = setTimeout(() => resolvePromise(timedOut), remaining);
        }),
      ]);
      clearTimeout(timeout);
      if (settled === timedOut) {
        recordFailure(
          timeoutOperation,
          new Error(`did not settle within ${this.stopSettleTimeoutMs}ms`),
        );
        return false;
      }
      settled.forEach((result, index) => {
        if (result.status === "rejected")
          recordFailure(operations[index].name, result.reason);
      });
      return true;
    };

    const openUiCount =
      this.uiPending.size + (this.customUi.isActive ? 1 : 0);
    process.stdout.write(
      `[session] stop_started key=${JSON.stringify(this.key)} epoch=${epoch} streaming=${Boolean(initialSession.isStreaming)} compacting=${Boolean(initialSession.isCompacting)} queued=${this.queueAdapter.view().steering.length + this.queueAdapter.view().followUp.length} open_ui=${openUiCount} pending_mutations=${this.pendingCommandMutations}\n`,
    );

    // Synchronous boundary: no command admitted before this point can enqueue
    // after stopEpoch changed, and dialogs blocking a tool are released first.
    clearQueue(initialSession, "before");
    closeUi();
    const abortPromise = abortSession(initialSession, "");

    const operation = (async () => {
      await settleUntilDeadline(
        [
          { name: "abort", promise: abortPromise },
          { name: "queue_settlement", promise: queueBarrier },
          { name: "mutation_settlement", promise: mutationBarrier },
        ],
        "settlement_timeout",
      );

      // A mutation admitted before stop can start work after the first abort,
      // or replace AgentSessionRuntime.session entirely. Sweep the current
      // session once more after the mutation barrier so stop remains atomic.
      closeUi();
      const currentSession = this.session;
      const sessionReplaced = currentSession !== initialSession;
      if (hadPendingMutations || sessionReplaced) {
        clearQueue(currentSession, "final_before");
        await settleUntilDeadline(
          [{ name: "final_abort", promise: abortSession(currentSession, "final_") }],
          "final_settlement_timeout",
        );
      }
      clearQueue(currentSession, "after");

      // Tool end events normally remove these. Clear only leftovers so the run
      // list cannot remain permanently busy after a successful stop.
      const staleTools = [...this.activeToolCalls.values()];
      this.activeToolCalls.clear();
      for (const tool of staleTools)
        this.onToolExecution?.(tool.toolName, "end");
      this.runStartedAt = undefined;
      this.broadcastSnapshot();

      const duration = elapsedMs(startedAt);
      process.stdout.write(
        `[session] stop_completed key=${JSON.stringify(this.key)} epoch=${epoch} duration_ms=${duration} queue_cleared=${clearedQueue} ui_closed=${closedUi} stale_tools=${staleTools.length} session_replaced=${sessionReplaced} status=${failures.length === 0 ? "ok" : "partial"}\n`,
      );
      if (failures.length > 0) {
        return {
          ok: false,
          error: `stop incomplete: ${failures.join("; ")}`,
          data: { clearedQueue, closedUi },
        };
      }
      return {
        ok: true,
        data: { clearedQueue, closedUi },
      };
    })();
    let tracked!: typeof operation;
    tracked = operation.finally(() => {
      if (this.stopPromise === tracked) this.stopPromise = undefined;
    });
    this.stopPromise = tracked;
    return tracked;
  }

  /**
   * A runtime replacement can finish after the user-visible stop deadline.
   * It still owns the old stop epoch and runs ahead of every newer serialized
   * mutation, so quiesce that exact late result before releasing the lane.
   */
  private async quiesceLateMutation(admittedEpoch: number): Promise<void> {
    if (admittedEpoch === this.stopEpoch || this.disposed) return;
    const session = this.session;
    const failures: string[] = [];
    const invoke = (operation: string, action: (() => void) | undefined) => {
      if (!action) return;
      try {
        action();
      } catch (cause) {
        failures.push(
          `${operation}: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    };
    const clearQueue = (phase: string) => {
      try {
        session.clearQueue();
      } catch (cause) {
        failures.push(
          `clear_queue_${phase}: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    };

    clearQueue("before");
    for (const id of [...this.uiPending.keys()])
      this.closeUiRequest(id, "dispose", undefined);
    this.pendingUiRequest = undefined;
    this.customUi.dispose();

    const stoppable = session as AgentSession & {
      abortRetry?: () => void;
      abortCompaction?: () => void;
      abortBranchSummary?: () => void;
      abortBash?: () => void;
      agent?: { abort?: () => void };
    };
    invoke("abort_retry", stoppable.abortRetry?.bind(stoppable));
    invoke("abort_compaction", stoppable.abortCompaction?.bind(stoppable));
    invoke(
      "abort_branch_summary",
      stoppable.abortBranchSummary?.bind(stoppable),
    );
    invoke("abort_bash", stoppable.abortBash?.bind(stoppable));
    invoke("agent_abort", stoppable.agent?.abort?.bind(stoppable.agent));

    let abortPromise: Promise<unknown>;
    try {
      abortPromise = Promise.resolve(session.abort());
    } catch (cause) {
      abortPromise = Promise.reject(cause);
    }
    let timer: NodeJS.Timeout | undefined;
    const timedOut = Symbol("late mutation abort timeout");
    const outcome = await Promise.race([
      abortPromise.then(
        () => undefined,
        (cause) => {
          failures.push(
            `abort: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        },
      ),
      new Promise<typeof timedOut>((resolvePromise) => {
        timer = setTimeout(
          () => resolvePromise(timedOut),
          this.stopSettleTimeoutMs,
        );
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
    if (outcome === timedOut)
      failures.push(
        `abort: did not settle within ${this.stopSettleTimeoutMs}ms`,
      );
    clearQueue("after");

    const staleTools = [...this.activeToolCalls.values()];
    this.activeToolCalls.clear();
    for (const tool of staleTools)
      this.onToolExecution?.(tool.toolName, "end");
    this.runStartedAt = undefined;
    this.broadcastSnapshot();
    process.stdout.write(
      `[session] stale_mutation_quiesced key=${JSON.stringify(this.key)} admitted_epoch=${admittedEpoch} current_epoch=${this.stopEpoch} stale_tools=${staleTools.length} status=${failures.length === 0 ? "ok" : "partial"}${failures.length > 0 ? ` failures=${JSON.stringify(failures)}` : ""}\n`,
    );
  }

  /**
   * Serialize every session mutation, including REST imports, and make a stop
   * request a hard admission boundary for work that was still waiting.
   */
  private withCommandMutation<T extends { ok: boolean; error?: string }>(
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const rejected = (error: string): T => ({ ok: false, error } as T);
    if (this.disposed)
      return Promise.resolve(rejected("session host is disposed"));
    if (this.stopPromise)
      return Promise.resolve(
        rejected("session is stopping; command was not accepted"),
      );
    const admittedEpoch = this.stopEpoch;
    this.pendingCommandMutations += 1;
    const result = this.commandMutationChain.then(async () => {
      if (this.disposed)
        return rejected("session host is disposed");
      if (this.stopPromise || admittedEpoch !== this.stopEpoch)
        return rejected("session operation was cancelled by stop");
      try {
        const value = await operation();
        if (admittedEpoch !== this.stopEpoch) {
          await this.quiesceLateMutation(admittedEpoch);
          return rejected(
            "session operation completed after stop and was stopped",
          );
        }
        return value;
      } catch (cause) {
        if (admittedEpoch !== this.stopEpoch)
          await this.quiesceLateMutation(admittedEpoch);
        throw cause;
      }
    });
    this.commandMutationChain = result.then(() => undefined, () => undefined);
    return result.finally(() => {
      this.pendingCommandMutations = Math.max(
        0,
        this.pendingCommandMutations - 1,
      );
    });
  }

  /** Serialize mutations across every browser attached to this Host. */
  handleOrdered(
    cmd: ClientCommand & { id?: string },
  ): Promise<{ ok: boolean; error?: string; data?: Record<string, unknown> }> {
    const bypass =
      cmd.type === "abort" ||
      cmd.type === "editor_state" ||
      cmd.type === "ui_response" ||
      cmd.type === "custom_ui_input" ||
      cmd.type === "custom_ui_resize" ||
      cmd.type === "custom_ui_cancel";
    if (bypass) return this.handleCommand(cmd);
    return this.withCommandMutation(() => this.handleCommand(cmd));
  }

  async handleCommand(
    cmd: ClientCommand & { id?: string },
  ): Promise<{ ok: boolean; error?: string; data?: Record<string, unknown> }> {
    if (this.disposed) return { ok: false, error: "session host is disposed" };
    if (this.stopPromise && cmd.type !== "abort")
      return { ok: false, error: "session is stopping; command was not accepted" };
    const initializationResponse =
      cmd.type === "abort" ||
      cmd.type === "editor_state" ||
      cmd.type === "ui_response" ||
      cmd.type === "custom_ui_input" ||
      cmd.type === "custom_ui_resize" ||
      cmd.type === "custom_ui_cancel";
    if (!this.isReady && !initializationResponse) {
      return {
        ok: false,
        error: "session is initializing; wait for extensions to become ready",
      };
    }
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
    if (
      this.sockets.size > 1 &&
      (cmd.type === "newSession" ||
        cmd.type === "fork" ||
        cmd.type === "branch")
    ) {
      return {
        ok: false,
        error: `当前会话在多个窗口中打开；请只保留一个窗口后再执行 ${cmd.type}。`,
      };
    }
    if ((s.isStreaming || s.isCompacting) && idleOnlyMutation) {
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
          return this.stopAll();
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
          const model = await this.findModel(cmd.provider, cmd.modelId);
          if (!model)
            return {
              ok: false,
              error: `model not found: ${cmd.provider}/${cmd.modelId}`,
            };
          await s.setModel(model, { persist: false });
          this.statsCacheKey = undefined;
          this.statsCache = undefined;
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
        case "editor_state":
          if (typeof cmd.text !== "string" || cmd.text.length > 256 * 1024) return { ok: false, error: "invalid editor state" };
          this.editorText = cmd.text;
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
    const page = messagePage(
      this.lastBranch,
      this.lastBranchBytes,
      before,
    );
    this.send(ws, {
      type: "history",
      requestId,
      sessionId: this.session.sessionId,
      branchHeadId: this.lastBranchHeadId,
      messages: page.messages as SessionSnapshot["messages"],
      before: page.from,
    });
  }

  broadcast(msg: ServerMessage): void {
    if (this.sockets.size === 0) return;
    const wire = JSON.stringify(msg);
    for (const ws of this.sockets) this.sendSerialized(ws, wire);
  }

  /**
   * Metadata may change while extensions bind, but the transcript usually does
   * not. Avoid sending and parsing the same history page twice at startup. If
   * an extension did append a durable entry, fall back to the full snapshot.
   */
  private broadcastReadyState(): void {
    if (this.sockets.size === 0) {
      this.syncIndexedSessionFile(this.session);
      return;
    }
    const snapshot = this.snapshot();
    const transcriptKey = this.transcriptKey(snapshot);
    if (transcriptKey !== this.deliveredTranscriptKey) {
      this.broadcastSnapshotValue(snapshot, "ready_changed");
      return;
    }
    const { messages: _messages, ...readySnapshot } = snapshot;
    const readyWire = JSON.stringify({
      type: "session_ready",
      snapshot: readySnapshot,
    } satisfies ServerMessage);
    let fullWire: string | undefined;
    let deltaViewers = 0;
    for (const ws of this.sockets) {
      if (this.readyDeltaSockets.has(ws)) {
        deltaViewers += 1;
        this.sendSerialized(ws, readyWire);
      } else {
        fullWire ??= JSON.stringify({ type: "snapshot", snapshot });
        this.sendSerialized(ws, fullWire);
      }
    }
    process.stdout.write(
      `[session] snapshot_delivery key=${JSON.stringify(this.key)} delivery=ready_delta snapshot_bytes=${Buffer.byteLength(readyWire)} delta_viewers=${deltaViewers} legacy_viewers=${this.sockets.size - deltaViewers}\n`,
    );
  }

  private transcriptKey(snapshot: SessionSnapshot): string {
    return `${snapshot.totalMessages}\u0000${snapshot.historyFrom}\u0000${transcriptPageKey(snapshot)}`;
  }

  private broadcastSnapshotValue(
    snapshot: SessionSnapshot,
    delivery: string,
  ): void {
    const wire = JSON.stringify({ type: "snapshot", snapshot });
    this.deliveredTranscriptKey = this.transcriptKey(snapshot);
    for (const ws of this.sockets) this.sendSerialized(ws, wire);
    process.stdout.write(
      `[session] snapshot_delivery key=${JSON.stringify(this.key)} delivery=${delivery} snapshot_bytes=${Buffer.byteLength(wire)} viewers=${this.sockets.size}\n`,
    );
  }

  broadcastSnapshot(): void {
    if (this.sockets.size === 0) {
      // Preserve session-index updates without paying for a full detached
      // snapshot that has no recipient.
      this.syncIndexedSessionFile(this.session);
      return;
    }
    const snapshot = this.snapshot();
    this.broadcastSnapshotValue(snapshot, "broadcast");
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    this.sendSerialized(ws, JSON.stringify(msg));
  }

  private sendSerialized(ws: WebSocket, wire: string): void {
    if (ws.readyState === ws.OPEN) ws.send(wire);
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    const startedAt = performance.now();
    process.stdout.write(
      `[session] dispose_started key=${JSON.stringify(this.key)} viewers=${this.sockets.size}\n`,
    );
    this.disposePromise = (async () => {
      clearTimeout(this.idleTimer);
      clearTimeout(this.resourceReloadTimer);
      this.resourceWatch?.close();
      clearTimeout(this.watchDebounceTimer);
      clearTimeout(this.watchRetryTimer);
      clearTimeout(this.pendingSnapshotTimer);
      this.pendingSnapshotTimer = undefined;
      this.streamingMessage = undefined;
      this.teardownSessionUi("dispose");
      this.fileWatcher?.close();
      this.fileWatcher = undefined;
      this.watchedFile = undefined;
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      let disposeFailed = false;
      let disposeError: unknown;
      try {
        await this.runtime.dispose();
      } catch (cause) {
        disposeFailed = true;
        disposeError = cause;
      } finally {
        for (const ws of this.sockets) ws.close(1000, "session disposed");
        this.sockets.clear();
      }
      process.stdout.write(
        `[session] dispose_completed key=${JSON.stringify(this.key)} duration_ms=${elapsedMs(startedAt)} status=${disposeFailed ? "error" : "ok"}\n`,
      );
      if (disposeFailed) throw disposeError;
    })();
    return this.disposePromise;
  }
}
