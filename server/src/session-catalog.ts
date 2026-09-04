import { createReadStream } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  realpath,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { createHash, randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { getAgentDir, type SessionInfo } from "@earendil-works/pi-coding-agent";

export interface SessionCatalogSnapshot {
  readonly version: number;
  readonly sessions: readonly SessionInfo[];
  readonly canonicalPaths: ReadonlySet<string>;
}

interface SessionFileStamp {
  path: string;
  size: number;
  mtimeMs: number;
  ctimeMs?: number;
  ino?: number;
}

interface SessionCatalogRecord {
  stamp: SessionFileStamp;
  info: SessionInfo;
  canonicalPath?: string;
  checkpoint?: SessionFileCheckpoint;
}

interface SessionFileCheckpoint {
  offset: number;
  prefixHash: string;
  endedWithNewline: boolean;
}

interface CachedSessionCatalog extends SessionCatalogSnapshot {
  readonly loadedAt: number;
  readonly records: ReadonlyMap<string, SessionCatalogRecord>;
}

interface SessionCatalogOptions {
  scan?: () => Promise<SessionFileStamp[]>;
  readInfo?: (
    path: string,
    stamp: SessionFileStamp,
  ) => Promise<SessionInfo | undefined>;
  canonicalize?: (path: string) => Promise<string>;
  now?: () => number;
  maxAgeMs?: number;
  log?: (message: string) => void;
  readProjection?: () => Promise<string | undefined>;
  writeProjection?: (content: string) => Promise<void>;
}

const DEFAULT_MAX_AGE_MS = 30_000;
const FILE_IO_CONCURRENCY = 10;
const PROJECTION_SCHEMA_VERSION = 1;
const MAX_PROJECTION_BYTES = 16 * 1024 * 1024;
const MAX_APPEND_DELTA_BYTES = 32 * 1024 * 1024;
const FILE_HASH_CHUNK_BYTES = 256 * 1024;
const MAX_APPEND_LINE_BYTES = 4 * 1024 * 1024;
const DEFAULT_PROJECTION_PATH = join(
  getAgentDir(),
  "pii-session-catalog-v1.json",
);

interface PersistedSessionInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  parentSessionPath?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
}

interface PersistedSessionRecord {
  stamp: SessionFileStamp;
  info: PersistedSessionInfo;
  checkpoint?: SessionFileCheckpoint;
}

interface PersistedSessionProjection {
  schemaVersion: typeof PROJECTION_SCHEMA_VERSION;
  records: PersistedSessionRecord[];
}

function sameStamp(a: SessionFileStamp, b: SessionFileStamp): boolean {
  return (
    a.path === b.path &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.ino === b.ino
  );
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function parseProjection(
  content: string | undefined,
): Map<string, SessionCatalogRecord> | undefined {
  if (!content || Buffer.byteLength(content) > MAX_PROJECTION_BYTES)
    return undefined;
  try {
    const value = JSON.parse(content) as {
      schemaVersion?: unknown;
      records?: unknown;
    };
    if (
      value.schemaVersion !== PROJECTION_SCHEMA_VERSION ||
      !Array.isArray(value.records)
    )
      return undefined;

    const records = new Map<string, SessionCatalogRecord>();
    for (const candidate of value.records) {
      if (typeof candidate !== "object" || candidate === null) return undefined;
      const { stamp: rawStamp, info: rawInfo, checkpoint: rawCheckpoint } =
        candidate as {
        stamp?: Record<string, unknown>;
        info?: Record<string, unknown>;
        checkpoint?: Record<string, unknown>;
      };
      if (!rawStamp || !rawInfo) return undefined;
      if (
        typeof rawStamp.path !== "string" ||
        !isAbsolute(rawStamp.path) ||
        !finiteNumber(rawStamp.size) ||
        rawStamp.size < 0 ||
        !finiteNumber(rawStamp.mtimeMs) ||
        !optionalString(rawInfo.name) ||
        !optionalString(rawInfo.parentSessionPath) ||
        typeof rawInfo.path !== "string" ||
        rawInfo.path !== rawStamp.path ||
        typeof rawInfo.id !== "string" ||
        typeof rawInfo.cwd !== "string" ||
        typeof rawInfo.created !== "string" ||
        typeof rawInfo.modified !== "string" ||
        !finiteNumber(rawInfo.messageCount) ||
        rawInfo.messageCount < 0 ||
        !Number.isInteger(rawInfo.messageCount) ||
        typeof rawInfo.firstMessage !== "string"
      )
        return undefined;
      if (
        rawStamp.ctimeMs !== undefined &&
        !finiteNumber(rawStamp.ctimeMs)
      )
        return undefined;
      if (rawStamp.ino !== undefined && !finiteNumber(rawStamp.ino))
        return undefined;

      const created = new Date(rawInfo.created);
      const modified = new Date(rawInfo.modified);
      if (Number.isNaN(created.getTime()) || Number.isNaN(modified.getTime()))
        return undefined;
      if (records.has(rawStamp.path)) return undefined;
      let checkpoint: SessionFileCheckpoint | undefined;
      if (rawCheckpoint !== undefined) {
        if (
          finiteNumber(rawCheckpoint.offset) &&
          rawCheckpoint.offset === rawStamp.size &&
          typeof rawCheckpoint.prefixHash === "string" &&
          /^[a-f0-9]{64}$/.test(rawCheckpoint.prefixHash) &&
          typeof rawCheckpoint.endedWithNewline === "boolean"
        )
          checkpoint = {
            offset: rawCheckpoint.offset,
            prefixHash: rawCheckpoint.prefixHash,
            endedWithNewline: rawCheckpoint.endedWithNewline,
          };
        // Older v1 projections contained a tail-only checkpoint. Keep their
        // catalog rows, but discard that weaker accelerator so the next file
        // change takes the authoritative full-parse path.
      }
      const stamp: SessionFileStamp = {
        path: rawStamp.path,
        size: rawStamp.size,
        mtimeMs: rawStamp.mtimeMs,
        ctimeMs: rawStamp.ctimeMs as number | undefined,
        ino: rawStamp.ino as number | undefined,
      };
      records.set(stamp.path, {
        stamp,
        checkpoint,
        info: {
          path: rawInfo.path,
          id: rawInfo.id,
          cwd: rawInfo.cwd,
          name: rawInfo.name,
          parentSessionPath: rawInfo.parentSessionPath,
          created,
          modified,
          messageCount: rawInfo.messageCount,
          firstMessage: rawInfo.firstMessage,
          allMessagesText: "",
        },
      });
    }
    return records;
  } catch {
    return undefined;
  }
}

function serializeProjection(
  records: ReadonlyMap<string, SessionCatalogRecord>,
): string {
  const projection: PersistedSessionProjection = {
    schemaVersion: PROJECTION_SCHEMA_VERSION,
    records: [...records.values()].map(({ stamp, info, checkpoint }) => ({
      stamp,
      checkpoint,
      info: {
        path: info.path,
        id: info.id,
        cwd: info.cwd,
        name: info.name,
        parentSessionPath: info.parentSessionPath,
        created: info.created.toISOString(),
        modified: info.modified.toISOString(),
        messageCount: info.messageCount,
        firstMessage: info.firstMessage,
      },
    })),
  };
  return JSON.stringify(projection);
}

async function readProjectionFile(): Promise<string | undefined> {
  try {
    const projectionStat = await stat(DEFAULT_PROJECTION_PATH);
    if (!projectionStat.isFile() || projectionStat.size > MAX_PROJECTION_BYTES)
      return undefined;
    return await readFile(DEFAULT_PROJECTION_PATH, "utf8");
  } catch {
    return undefined;
  }
}

async function writeProjectionFile(content: string): Promise<void> {
  await mkdir(dirname(DEFAULT_PROJECTION_PATH), { recursive: true });
  const temporaryPath = `${DEFAULT_PROJECTION_PATH}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, DEFAULT_PROJECTION_PATH);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  fn: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (true) {
        const index = next++;
        if (index >= values.length) return;
        results[index] = await fn(values[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function scanSessionFiles(): Promise<SessionFileStamp[]> {
  const sessionsDir = join(getAgentDir(), "sessions");
  let roots;
  try {
    roots = await readdir(sessionsDir, { withFileTypes: true });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }

  const directories = roots
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => join(sessionsDir, entry.name));
  const paths = (
    await mapConcurrent(directories, FILE_IO_CONCURRENCY, async (directory) => {
      try {
        return (await readdir(directory))
          .filter((name) => name.endsWith(".jsonl"))
          .map((name) => join(directory, name));
      } catch {
        // An unreadable or disappearing project directory contributes no
        // trusted sessions to this snapshot.
        return [];
      }
    })
  ).flat();

  const stamps = await mapConcurrent(
    paths,
    FILE_IO_CONCURRENCY,
    async (path): Promise<SessionFileStamp | undefined> => {
      try {
        const fileStat = await stat(path);
        if (!fileStat.isFile()) return undefined;
        return {
          path,
          size: fileStat.size,
          mtimeMs: fileStat.mtimeMs,
          ctimeMs: fileStat.ctimeMs,
          ino: fileStat.ino,
        };
      } catch {
        return undefined;
      }
    },
  );
  return stamps.filter(
    (stamp): stamp is SessionFileStamp => stamp !== undefined,
  );
}

function textContent(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join(" ");
}

function physicalFileMatches(
  stamp: SessionFileStamp,
  value: {
    size: number;
    mtimeMs: number;
    ctimeMs: number;
    ino: number;
    isFile(): boolean;
  },
): boolean {
  return (
    value.isFile() &&
    value.size === stamp.size &&
    value.mtimeMs === stamp.mtimeMs &&
    (stamp.ctimeMs === undefined || value.ctimeMs === stamp.ctimeMs) &&
    (stamp.ino === undefined || value.ino === stamp.ino)
  );
}

async function readExactRange(
  handle: Awaited<ReturnType<typeof open>>,
  start: number,
  length: number,
  visit: (chunk: Buffer) => boolean | void,
): Promise<boolean> {
  const buffer = Buffer.allocUnsafe(
    Math.max(1, Math.min(FILE_HASH_CHUNK_BYTES, length)),
  );
  let offset = start;
  let remaining = length;
  while (remaining > 0) {
    const requested = Math.min(buffer.length, remaining);
    const { bytesRead } = await handle.read(buffer, 0, requested, offset);
    if (bytesRead === 0) return false;
    const chunk = buffer.subarray(0, bytesRead);
    if (visit(chunk) === false) return false;
    offset += bytesRead;
    remaining -= bytesRead;
  }
  return true;
}

async function checkpointForFile(
  stamp: SessionFileStamp,
): Promise<SessionFileCheckpoint | undefined> {
  let handle;
  try {
    handle = await open(stamp.path, "r");
    const before = await handle.stat();
    if (!physicalFileMatches(stamp, before)) return undefined;
    const hash = createHash("sha256");
    let lastByte: number | undefined;
    const complete = await readExactRange(handle, 0, stamp.size, (chunk) => {
      hash.update(chunk);
      lastByte = chunk.at(-1);
    });
    if (!complete) return undefined;
    const after = await handle.stat();
    if (!physicalFileMatches(stamp, after)) return undefined;
    return {
      offset: stamp.size,
      prefixHash: hash.digest("hex"),
      endedWithNewline:
        stamp.size === 0 || lastByte === "\n".charCodeAt(0),
    };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Apply only complete JSONL appends after hashing the entire old prefix. */
async function applyAppendDelta(
  existing: SessionCatalogRecord,
  stamp: SessionFileStamp,
): Promise<SessionCatalogRecord | undefined> {
  const checkpoint = existing.checkpoint;
  if (
    !checkpoint ||
    checkpoint.offset !== existing.stamp.size ||
    !checkpoint.endedWithNewline ||
    existing.stamp.ino === undefined ||
    stamp.ino === undefined ||
    existing.stamp.ino !== stamp.ino ||
    stamp.size <= existing.stamp.size ||
    stamp.size - existing.stamp.size > MAX_APPEND_DELTA_BYTES
  )
    return undefined;

  let handle;
  try {
    handle = await open(stamp.path, "r");
    const before = await handle.stat();
    if (!physicalFileMatches(stamp, before)) return undefined;
    const hash = createHash("sha256");
    const prefixRead = await readExactRange(
      handle,
      0,
      existing.stamp.size,
      (chunk) => {
        hash.update(chunk);
      },
    );
    if (!prefixRead || hash.copy().digest("hex") !== checkpoint.prefixHash)
      return undefined;

    let name = existing.info.name;
    let messageCount = existing.info.messageCount;
    let firstMessage = existing.info.firstMessage;
    let modifiedMs = existing.info.modified.getTime();
    let pending = "";
    let valid = true;
    let lastByte: number | undefined;
    const decoder = new StringDecoder("utf8");
    const applyLine = (line: string): void => {
      if (!valid || !line.trim()) return;
      let entry: Record<string, unknown>;
      try {
        const value = JSON.parse(line) as unknown;
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          valid = false;
          return;
        }
        entry = value as Record<string, unknown>;
      } catch {
        valid = false;
        return;
      }
      if (entry.type === "session_info") {
        name =
          typeof entry.name === "string"
            ? entry.name.trim() || undefined
            : undefined;
      }
      if (entry.type !== "message") return;
      messageCount += 1;
      if (typeof entry.message !== "object" || entry.message === null) return;
      const message = entry.message as Record<string, unknown>;
      if (message.role !== "user" && message.role !== "assistant") return;
      const activityTime =
        typeof message.timestamp === "number"
          ? message.timestamp
          : typeof entry.timestamp === "string"
            ? new Date(entry.timestamp).getTime()
            : NaN;
      if (!Number.isNaN(activityTime))
        modifiedMs = Math.max(modifiedMs, activityTime);
      if (
        (!firstMessage || firstMessage === "(no messages)") &&
        message.role === "user"
      ) {
        const text = textContent(message);
        if (text) firstMessage = text;
      }
    };
    const appendedLength = stamp.size - existing.stamp.size;
    const appendRead = await readExactRange(
      handle,
      existing.stamp.size,
      appendedLength,
      (chunk) => {
        hash.update(chunk);
        lastByte = chunk.at(-1);
        pending += decoder.write(chunk);
        let lineStart = 0;
        let newlineIndex = pending.indexOf("\n", lineStart);
        while (newlineIndex !== -1) {
          applyLine(pending.slice(lineStart, newlineIndex));
          lineStart = newlineIndex + 1;
          newlineIndex = pending.indexOf("\n", lineStart);
        }
        pending = pending.slice(lineStart);
        if (Buffer.byteLength(pending) > MAX_APPEND_LINE_BYTES) valid = false;
        return valid;
      },
    );
    pending += decoder.end();
    if (
      !appendRead ||
      !valid ||
      pending.trim() ||
      lastByte !== "\n".charCodeAt(0)
    )
      return undefined;
    const after = await handle.stat();
    if (!physicalFileMatches(stamp, after)) return undefined;
    return {
      stamp,
      canonicalPath: existing.canonicalPath,
      checkpoint: {
        offset: stamp.size,
        prefixHash: hash.digest("hex"),
        endedWithNewline: true,
      },
      info: {
        ...existing.info,
        name,
        modified: new Date(modifiedMs),
        messageCount,
        firstMessage: firstMessage || "(no messages)",
        allMessagesText: "",
      },
    };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

interface SessionRecordRead {
  info: SessionInfo;
  checkpoint?: SessionFileCheckpoint;
}

async function readSessionRecord(
  path: string,
  stamp: SessionFileStamp,
): Promise<SessionRecordRead | undefined> {
  try {
    let header: Record<string, unknown> | undefined;
    let messageCount = 0;
    let firstMessage = "";
    let name: string | undefined;
    let lastActivityTime: number | undefined;
    const hash = createHash("sha256");
    let lastByte: number | undefined;
    const input = createReadStream(path);
    input.on("data", (chunk: Buffer | string) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      hash.update(bytes);
      lastByte = bytes.at(-1);
    });
    const lines = createInterface({
      input,
      crlfDelay: Infinity,
    });

    for await (const line of lines) {
      if (!line.trim()) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!header) {
        if (entry.type !== "session" || typeof entry.id !== "string")
          return undefined;
        header = entry;
        continue;
      }
      if (entry.type === "session_info") {
        // The newest session_info wins, including an explicit empty name that
        // clears a title set by an older entry (matching SessionManager).
        name =
          typeof entry.name === "string"
            ? entry.name.trim() || undefined
            : undefined;
      }
      if (entry.type !== "message") continue;
      messageCount += 1;
      const message = entry.message;
      if (typeof message !== "object" || message === null) continue;
      const record = message as Record<string, unknown>;
      if (record.role !== "user" && record.role !== "assistant") continue;

      const activityTime =
        typeof record.timestamp === "number"
          ? record.timestamp
          : typeof entry.timestamp === "string"
            ? new Date(entry.timestamp).getTime()
            : NaN;
      if (!Number.isNaN(activityTime))
        lastActivityTime = Math.max(lastActivityTime ?? 0, activityTime);
      if (!firstMessage && record.role === "user")
        firstMessage = textContent(record);
    }

    if (!header) return undefined;
    const headerTimestamp =
      typeof header.timestamp === "string"
        ? new Date(header.timestamp)
        : new Date(stamp.mtimeMs);
    const info: SessionInfo = {
      path,
      id: String(header.id),
      cwd: typeof header.cwd === "string" ? header.cwd : "",
      name,
      parentSessionPath:
        typeof header.parentSession === "string"
          ? header.parentSession
          : undefined,
      created: headerTimestamp,
      modified:
        lastActivityTime !== undefined
          ? new Date(lastActivityTime)
          : Number.isNaN(headerTimestamp.getTime())
            ? new Date(stamp.mtimeMs)
            : headerTimestamp,
      messageCount,
      firstMessage: firstMessage || "(no messages)",
      // The web server never exposes or searches this SDK-only field. Avoid
      // retaining the complete text of every message in the shared cache.
      allMessagesText: "",
    };
    const after = await stat(path).catch(() => undefined);
    return {
      info,
      checkpoint:
        after && physicalFileMatches(stamp, after)
          ? {
              offset: stamp.size,
              prefixHash: hash.digest("hex"),
              endedWithNewline:
                stamp.size === 0 || lastByte === "\n".charCodeAt(0),
            }
          : undefined,
    };
  } catch {
    return undefined;
  }
}

export async function readSessionInfo(
  path: string,
  stamp: SessionFileStamp,
): Promise<SessionInfo | undefined> {
  return (await readSessionRecord(path, stamp))?.info;
}

/**
 * Process-wide, incremental session discovery cache.
 *
 * Refreshes enumerate and stat the catalog, but only parse JSONL files whose
 * path/size/mtime/ctime/inode changed. A single in-flight refresh is shared across
 * the sidebar, route resolver, workspace guard, and websocket startup.
 */
export class SessionCatalog {
  private readonly scan: () => Promise<SessionFileStamp[]>;
  private readonly readRecord: (
    path: string,
    stamp: SessionFileStamp,
  ) => Promise<SessionRecordRead | undefined>;
  private readonly canonicalize: (path: string) => Promise<string>;
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly log: (message: string) => void;
  private readonly readProjection: () => Promise<string | undefined>;
  private readonly writeProjection: (content: string) => Promise<void>;
  private projectionLoaded = false;
  private restoredRecords?: ReadonlyMap<string, SessionCatalogRecord>;
  private cached?: CachedSessionCatalog;
  private inFlight?: Promise<CachedSessionCatalog>;

  constructor(options: SessionCatalogOptions = {}) {
    this.scan = options.scan ?? scanSessionFiles;
    this.readRecord =
      !options.readInfo || options.readInfo === readSessionInfo
        ? readSessionRecord
        : async (path, stamp) => {
            const info = await options.readInfo?.(path, stamp);
            return info
              ? { info, checkpoint: await checkpointForFile(stamp) }
              : undefined;
          };
    this.canonicalize = options.canonicalize ?? realpath;
    this.now = options.now ?? Date.now;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.log = options.log ?? console.info;
    this.readProjection = options.readProjection ?? readProjectionFile;
    this.writeProjection = options.writeProjection ?? writeProjectionFile;
  }

  async snapshot(version: number): Promise<SessionCatalogSnapshot> {
    const cached = this.cached;
    if (
      cached &&
      cached.version >= version &&
      this.now() - cached.loadedAt < this.maxAgeMs
    ) {
      return cached;
    }
    if (this.inFlight) {
      await this.inFlight;
      return this.snapshot(version);
    }

    const loading = this.refresh(version);
    const tracked = loading.finally(() => {
      if (this.inFlight === tracked) this.inFlight = undefined;
    });
    this.inFlight = tracked;
    return tracked;
  }

  private async loadProjection(): Promise<
    ReadonlyMap<string, SessionCatalogRecord> | undefined
  > {
    if (this.projectionLoaded) return this.restoredRecords;
    this.projectionLoaded = true;
    try {
      this.restoredRecords = parseProjection(await this.readProjection());
    } catch {
      this.restoredRecords = undefined;
    }
    return this.restoredRecords;
  }

  private async refresh(version: number): Promise<CachedSessionCatalog> {
    const startedAt = performance.now();
    let previous = this.cached?.records;
    let source = previous ? "incremental" : "full";
    if (!previous) {
      previous = await this.loadProjection();
      if (previous) source = "disk_cache";
    }
    let filesTotal = 0;
    let filesParsed = 0;
    let filesDelta = 0;
    let appendFallbacks = 0;
    let bytesParsed = 0;
    let bytesVerified = 0;
    try {
      const stamps = await this.scan();
      filesTotal = stamps.length;
      const loaded = await mapConcurrent(
        stamps,
        FILE_IO_CONCURRENCY,
        async (stamp): Promise<SessionCatalogRecord | undefined> => {
          const existing = previous?.get(stamp.path);
          if (existing && sameStamp(existing.stamp, stamp)) {
            if (source !== "disk_cache") return existing;
            const canonicalPath = await this.canonicalize(stamp.path).catch(
              () => undefined,
            );
            return canonicalPath
              ? {
                  stamp,
                  info: existing.info,
                  canonicalPath,
                  checkpoint: existing.checkpoint,
                }
              : undefined;
          }
          if (existing) {
            const delta = await applyAppendDelta(existing, stamp);
            if (delta) {
              filesDelta += 1;
              bytesParsed += stamp.size - existing.stamp.size;
              bytesVerified += existing.stamp.size;
              const canonicalPath =
                delta.canonicalPath ??
                (await this.canonicalize(stamp.path).catch(() => undefined));
              return canonicalPath ? { ...delta, canonicalPath } : undefined;
            }
            if (stamp.size > existing.stamp.size) appendFallbacks += 1;
          }
          filesParsed += 1;
          bytesParsed += stamp.size;
          const parsed = await this.readRecord(stamp.path, stamp);
          if (!parsed) return undefined;
          const canonicalPath = await this.canonicalize(stamp.path).catch(
            () => undefined,
          );
          return canonicalPath
            ? {
                stamp,
                info: parsed.info,
                canonicalPath,
                checkpoint: parsed.checkpoint,
              }
            : undefined;
        },
      );

      const records = new Map<string, SessionCatalogRecord>();
      for (const record of loaded) {
        if (record) records.set(record.stamp.path, record);
      }
      const sessions = Object.freeze(
        [...records.values()]
          .map((record) => record.info)
          .sort((a, b) => b.modified.getTime() - a.modified.getTime()),
      );
      const snapshot: CachedSessionCatalog = {
        version,
        sessions,
        canonicalPaths: new Set(
          [...records.values()]
            .map((record) => record.canonicalPath)
            .filter((path): path is string => path !== undefined),
        ),
        loadedAt: this.now(),
        records,
      };
      this.cached = snapshot;
      const projectionChanged =
        previous === undefined ||
        filesParsed > 0 ||
        filesDelta > 0 ||
        records.size !== previous.size;
      let projectionWrite = "skip";
      if (projectionChanged) {
        try {
          await this.writeProjection(serializeProjection(records));
          projectionWrite = "ok";
        } catch {
          // Projection persistence is an optimization. The in-memory snapshot
          // remains authoritative for this process when an atomic write fails.
          projectionWrite = "error";
        }
      }
      this.log(
        `[session-catalog] refresh source=${source} version=${version} files_total=${filesTotal} files_parsed=${filesParsed} files_delta=${filesDelta} files_reused=${filesTotal - filesParsed - filesDelta} append_fallbacks=${appendFallbacks} bytes_parsed=${bytesParsed} bytes_verified=${bytesVerified} sessions=${sessions.length} projection_write=${projectionWrite} duration_ms=${Math.round(performance.now() - startedAt)}`,
      );
      return snapshot;
    } catch (cause) {
      this.log(
        `[session-catalog] refresh source=${source} version=${version} files_total=${filesTotal} files_parsed=${filesParsed} files_delta=${filesDelta} append_fallbacks=${appendFallbacks} bytes_parsed=${bytesParsed} bytes_verified=${bytesVerified} result=error duration_ms=${Math.round(performance.now() - startedAt)}`,
      );
      throw cause;
    }
  }
}
