import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createHash, randomBytes } from "node:crypto";
import {
  readFile,
  readdir,
  stat,
  unlink,
  writeFile,
  mkdir,
  realpath,
  open,
  rename,
  copyFile,
  utimes,
} from "node:fs/promises";
import {
  createReadStream,
  existsSync,
  readdirSync,
  readFileSync,
  watch,
} from "node:fs";
import { execFile } from "node:child_process";
import { extname, join, normalize, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import {
  DefaultPackageManager,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSessionServices,
  getAgentDir,
  type PackageSource,
} from "@earendil-works/pi-coding-agent";
import type { ClientCommand, ProjectGroup, ServerMessage } from "./protocol.js";
import { SessionHost } from "./session-host.js";
import { hasRunningSubagentRuns } from "./subagent-activity.js";
import { resolveToolAuthorizedPreviewPath } from "./file-preview-access.js";
import {
  TunnelHub,
  attachWebSocketHeartbeat,
  runTunnelAgent,
  type TunnelAgentHandle,
} from "./tunnel.js";
import { loginPageHtml } from "./login-page.js";
import {
  canonicalRoots,
  createFlowCapability,
  flowCapabilityMatches,
  mutationRequestAllowed,
  resolveWorkspacePath,
  safeNextPath,
  webSocketOriginAllowed,
} from "./security.js";

// ---------------------------------------------------------------------------
// CLI options
// ---------------------------------------------------------------------------
interface ServerOptions {
  host: string;
  port: number;
  password?: string;
  /** Tunnel mode: secure URL of the hub (NAS) to dial out to, e.g. wss://nas.example/tunnel */
  agent?: string;
  /** UI-only mode: serve the interface + tunnel hub, never run pi locally. */
  uiOnly?: boolean;
  agentName?: string;
  agentToken?: string;
}

function parseOptions(argv: string[]): ServerOptions {
  const opts: ServerOptions = {
    host: process.env.PII_HOST ?? "127.0.0.1",
    port: Number(process.env.PII_PORT ?? process.env.PORT ?? 31041),
    password: process.env.PII_PASSWORD,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--host" || arg === "-H") opts.host = next();
    else if (arg === "--port" || arg === "-p") opts.port = Number(next());
    else if (arg === "--password") opts.password = next();
    else if (arg === "--agent") opts.agent = next();
    else if (arg === "--ui-only") opts.uiOnly = true;
    else if (arg === "--name") opts.agentName = next();
    else if (arg === "--token") opts.agentToken = next();
    else if (arg === "--help" || arg === "-h") {
      console.log(`MewPii — dsh-styled web UI for the pi coding agent

Usage: mewpii [options]

Options:
  --host, -H <host>        Listen host (default 127.0.0.1, env PII_HOST)
  --port, -p <port>        Listen port (default 31041, env PII_PORT)
  --password <password>    Basic Auth password, user "pi" (env PII_PASSWORD)
  --ui-only                UI-only mode: serve interface + tunnel hub, no local pi runtime
  --agent <url>            Tunnel mode: dial out to a pii hub, e.g. wss://nas.example/tunnel
  --name <name>            Agent display name (tunnel mode)
  --token <token>          Hub auth token (env PII_AGENT_TOKEN; defaults to PII_PASSWORD)
  --help, -h               Show this help

Remote access: binding a non-loopback host exposes a full coding agent.
Always set a password, and prefer an HTTPS tunnel or reverse proxy
(see docs/remote-access.md).`);
      process.exit(0);
    }
  }
  return opts;
}

const options = parseOptions(process.argv.slice(2));
options.agent = options.agent ?? process.env.PII_AGENT_SERVER;
options.agentName = options.agentName ?? process.env.PII_AGENT_NAME;
options.agentToken =
  options.agentToken ?? process.env.PII_AGENT_TOKEN ?? options.password;
if (options.agent) {
  // Tunnel (agent) mode: serve locally on an ephemeral loopback port and pipe
  // all traffic through the outbound tunnel connection.
  options.host = "127.0.0.1";
  options.port = 0;
  options.password = undefined;
}

const isLoopback =
  options.host === "127.0.0.1" ||
  options.host === "localhost" ||
  options.host === "::1";
if (!isLoopback && !options.password) {
  console.error(
    "Refusing to listen on a non-loopback host without a password. Set --password or PII_PASSWORD.",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Auth (HTTP Basic, user "pi"; browsers reuse cached credentials for WS too)
// ---------------------------------------------------------------------------
const sessions = new Set<string>();

function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k) out[k] = decodeURIComponent(v.join("="));
  }
  return out;
}

function passwordOk(candidate: string): boolean {
  const expected = options.password ?? "";
  if (candidate.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < candidate.length; i++)
    diff |= candidate.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/** Cookie session only — used for browser page views (login flow owns these). */
function checkCookieAuth(req: IncomingMessage): boolean {
  if (!options.password) return true;
  const token = parseCookies(req).pii_session;
  return Boolean(token && sessions.has(token));
}

/** Cookie OR HTTP Basic — used for /api, /ws, /tunnel (browsers send cookie, agents send Basic). */
function checkAuth(req: IncomingMessage): boolean {
  if (!options.password) return true;
  if (checkCookieAuth(req)) return true;
  const header = req.headers.authorization;
  if (!header?.startsWith("Basic ")) return false;
  const [user, pass] = Buffer.from(header.slice(6), "base64")
    .toString()
    .split(":", 2);
  return user === "pi" && passwordOk(pass ?? "");
}

function requireAuth(req: IncomingMessage, res: ServerResponse): boolean {
  const url = req.url ?? "/";
  const isApi = url.startsWith("/api/") || url === "/ws" || url === "/tunnel";
  if (isApi) {
    if (checkAuth(req)) return true;
    // Only the tunnel endpoint challenges with Basic (machine agents use it).
    // Browser /api 401s must be silent so the SPA can redirect to /login
    // instead of the browser showing its native auth popup.
    const headers: Record<string, string> = {};
    if (url === "/tunnel")
      headers["WWW-Authenticate"] = 'Basic realm="pii", charset="UTF-8"';
    res.writeHead(401, headers);
    res.end("Authentication required");
    return false;
  }
  // browser page views must have a cookie session — cached Basic credentials
  // (which users cannot clear from the client) must not bypass the login page,
  // otherwise logout can never take effect.
  if (checkCookieAuth(req)) return true;
  if (req.method === "GET" || req.method === "HEAD") {
    const next = encodeURIComponent(url);
    res.writeHead(302, { Location: `/login?next=${next}` });
    res.end();
    return false;
  }
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "authentication required" }));
  return false;
}

// ---------------------------------------------------------------------------
// Session hosts (one per conversation, shared across browsers)
// ---------------------------------------------------------------------------
const hosts = new Map<string, SessionHost>();
const hostCreations = new Map<string, Promise<SessionHost>>();

function removeHost(host: SessionHost): void {
  for (const [key, current] of hosts) {
    if (current === host) hosts.delete(key);
  }
}

class PreviewAuthorizationError extends Error {}

function hostForSessionId(sessionId: string): SessionHost | undefined {
  return [...new Set(hosts.values())].find(
    (host) => host.session.sessionId === sessionId,
  );
}

async function resolvePreviewFile(
  cwd: string,
  target: string,
  sessionId: string | undefined,
): Promise<string> {
  try {
    return (
      await resolveWorkspacePath(cwd, target, {
        extraRoots: await knownWorkspaceRoots(),
      })
    ).path;
  } catch (cause) {
    if (
      !(cause instanceof Error) ||
      !/^(path|symlink) escapes workspace$/.test(cause.message) ||
      !sessionId
    )
      throw cause;
  }

  const host = hostForSessionId(sessionId);
  if (!host)
    throw new PreviewAuthorizationError("preview session is not active");
  const [requestedCwd, hostCwd] = await Promise.all([
    realpath(resolve(cwd)),
    realpath(resolve(host.cwd)),
  ]);
  if (requestedCwd !== hostCwd)
    throw new PreviewAuthorizationError("preview session workspace mismatch");
  const file = await resolveToolAuthorizedPreviewPath(
    hostCwd,
    target,
    host.session.messages,
  );
  if (!file)
    throw new PreviewAuthorizationError(
      "file was not authorized by this session",
    );
  const pathHash = createHash("sha256").update(file).digest("hex").slice(0, 12);
  process.stdout.write(
    `[files] external_preview_granted session_id=${sessionId.slice(0, 12)} path_hash=${pathHash}\n`,
  );
  return file;
}

async function reindexHost(
  host: SessionHost,
  _previousFile: string | undefined,
  nextFile: string | undefined,
): Promise<void> {
  removeHost(host);
  if (!nextFile) {
    hosts.set(`new:${host.cwd}:${host.key}`, host);
    return;
  }
  const canonicalFile = await realpath(nextFile).catch(() => resolve(nextFile));
  const key = `file:${canonicalFile}`;
  const duplicate = hosts.get(key);
  if (duplicate && duplicate !== host) {
    removeHost(duplicate);
    await duplicate.dispose();
  }
  hosts.set(key, host);
}

async function acquireHost(
  cwd: string,
  sessionPath?: string,
): Promise<SessionHost> {
  if (options.uiOnly)
    throw new Error("ui-only mode: connect an agent to use conversations");
  const normalizedSession = sessionPath
    ? await trustedSessionPath(sessionPath)
    : undefined;
  const normalizedCwd = normalizedSession
    ? cwd
    : (await resolveWorkspacePath(cwd, ".", {
        extraRoots: await knownWorkspaceRoots(),
      })).base;
  const fileKey = normalizedSession ? `file:${normalizedSession}` : undefined;
  if (fileKey) {
    const existing = hosts.get(fileKey);
    if (existing) return existing;
    for (const host of new Set(hosts.values())) {
      if (host.session.sessionFile && resolve(host.session.sessionFile) === normalizedSession)
        return host;
    }
    const pending = hostCreations.get(fileKey);
    if (pending) return pending;
  }

  const key = fileKey ?? `new:${normalizedCwd}:${crypto.randomUUID()}`;
  const creation = SessionHost.create(key, {
    cwd: normalizedCwd,
    sessionPath: normalizedSession,
    onEmpty: removeHost,
    onSessionChanged: reindexHost,
    hasBackgroundWork: (activeHost) =>
      hasRunningSubagentRuns(activeHost.session.sessionFile),
  }).then((host) => {
    hosts.set(key, host);
    host.onToolExecution = (toolName, _phase) => {
      if (toolName === "subagent" || toolName.startsWith("subagent_"))
        bumpSessionsVersion();
    };
    return host;
  });
  if (fileKey) hostCreations.set(fileKey, creation);
  try {
    return await creation;
  } finally {
    if (fileKey && hostCreations.get(fileKey) === creation)
      hostCreations.delete(fileKey);
  }
}

// ---------------------------------------------------------------------------
// Shared model runtime for /api/models
// ---------------------------------------------------------------------------
interface ModelServices {
  runtime: ModelRuntime;
  registry: ModelRegistry;
}
let modelServices: ModelServices | undefined;
let modelServicesMtime = 0;
async function getModelServices(): Promise<ModelServices> {
  // recreate when models.json changed (e.g. user added a model via pi CLI)
  let mtime = 0;
  try {
    mtime = (await stat(join(getAgentDir(), "models.json"))).mtimeMs;
  } catch {
    /* no custom models file */
  }
  if (!modelServices || mtime !== modelServicesMtime) {
    const runtime = await ModelRuntime.create();
    const registry = new ModelRegistry(runtime);
    await registry.refresh().catch(() => undefined);
    modelServices = { runtime, registry };
    modelServicesMtime = mtime;
  }
  return modelServices;
}

// ---------------------------------------------------------------------------
// OAuth login flows (bridged to the browser over REST)
// ---------------------------------------------------------------------------
interface OAuthFlow {
  owner: string;
  capabilityHash: string;
  createdAt: number;
  expiresAt: number;
  controller: AbortController;
  events: {
    type: string;
    message?: string;
    url?: string;
    userCode?: string;
    verificationUri?: string;
    instructions?: string;
  }[];
  pendingPrompt?: {
    message: string;
    placeholder?: string;
    inputType: string;
    resolve: (value: string) => void;
  };
  done: boolean;
  error?: string;
}
const oauthFlows = new Map<string, OAuthFlow>();
const OAUTH_FLOW_TTL_MS = 10 * 60_000;
const OAUTH_FLOW_LIMIT = 16;

function requestOwner(req: IncomingMessage): string {
  const cookie = parseCookies(req).pii_session;
  if (cookie) return `session:${cookie}`;
  const authorization = req.headers.authorization ?? "";
  if (authorization)
    return `auth:${createHash("sha256").update(authorization).digest("hex")}`;
  return `local:${req.socket.remoteAddress ?? ""}:${req.headers["user-agent"] ?? ""}`;
}

function deleteOAuthFlow(id: string, abort = false): void {
  const flow = oauthFlows.get(id);
  if (!flow) return;
  oauthFlows.delete(id);
  if (abort && !flow.done) flow.controller.abort();
}

function cleanOAuthFlows(): void {
  const now = Date.now();
  for (const [id, flow] of oauthFlows) {
    if (flow.expiresAt <= now) deleteOAuthFlow(id, true);
  }
}

function ownedOAuthFlow(
  req: IncomingMessage,
  id: unknown,
  secret: unknown,
): OAuthFlow | undefined {
  if (typeof id !== "string") return undefined;
  const flow = oauthFlows.get(id);
  if (
    !flow ||
    flow.owner !== requestOwner(req) ||
    !flowCapabilityMatches(secret, flow.capabilityHash)
  )
    return undefined;
  return flow;
}

const oauthCleanupTimer = setInterval(cleanOAuthFlows, 30_000);
oauthCleanupTimer.unref();
function disposeOAuthFlows(): void {
  clearInterval(oauthCleanupTimer);
  for (const id of [...oauthFlows.keys()]) deleteOAuthFlow(id, true);
}

// ---------------------------------------------------------------------------
// sessions dir watcher: CLI-side changes bump a version the UI polls
// ---------------------------------------------------------------------------
let sessionsVersion = 0;
function bumpSessionsVersion(): void {
  sessionsVersion += 1;
}

/** Synthesize sidebar entries for in-flight pi-subagents runs (files land lazily). */
function listVirtualSubagentRuns(
  realNested: Set<string>,
): import("./protocol").SessionSummary[] {
  const out: import("./protocol").SessionSummary[] = [];
  const tmp = tmpdir();
  let scopeDirs: string[] = [];
  try {
    scopeDirs = readdirSync(tmp)
      .filter((d) => d.startsWith("pi-subagents-"))
      .map((d) => join(tmp, d, "async-subagent-runs"));
  } catch {
    return out;
  }
  for (const root of scopeDirs) {
    let runDirs: string[] = [];
    try {
      runDirs = readdirSync(root);
    } catch {
      continue;
    }
    for (const runId of runDirs) {
      try {
        const status = JSON.parse(
          readFileSync(join(root, runId, "status.json"), "utf8"),
        ) as {
          state?: string;
          cwd?: string;
          sessionId?: string;
          startedAt?: number;
          lastUpdate?: number;
          artifactsDir?: string;
          pid?: number;
          mode?: string;
          chainStepCount?: number;
        };
        // running runs always show; finished runs stay visible for a day so the
        // user can still open the run view (transcripts live outside listAll)
        const isRunning = status.state === "running";
        if (!isRunning) {
          const age = Date.now() - (status.lastUpdate ?? status.startedAt ?? 0);
          if (age > 24 * 3600_000) continue;
        }
        // dead pid on a running-state entry = stale entry from a crashed process
        if (isRunning && typeof status.pid === "number") {
          try {
            process.kill(status.pid, 0);
          } catch {
            continue;
          }
        }
        // agent name comes from the artifacts meta file
        let agent = "subagent";
        const artifactsDir = status.artifactsDir;
        if (artifactsDir) {
          try {
            const meta = readdirSync(artifactsDir).find(
              (f) => f.startsWith(`${runId}_`) && f.endsWith("_meta.json"),
            );
            if (meta) {
              const m = JSON.parse(
                readFileSync(join(artifactsDir, meta), "utf8"),
              ) as { agent?: string };
              if (m.agent) agent = m.agent;
            }
          } catch {
            /* ignore */
          }
        }
        const steps =
          typeof status.chainStepCount === "number" && status.chainStepCount > 1
            ? ` ×${status.chainStepCount}`
            : "";
        const parentFile =
          typeof status.sessionId === "string" ? status.sessionId : "";
        const displayName =
          status.mode === "workflow"
            ? `subagent-workflow${steps}`
            : `subagent-${agent}`;
        // a real nested session for the same parent+agent supersedes the run entry
        if (!isRunning && realNested.has(`${parentFile}|${displayName}`))
          continue;
        out.push({
          path: `pi-subagents-run://${runId}`,
          id: runId,
          cwd: status.cwd ?? "",
          name: displayName,
          created: new Date(status.startedAt ?? Date.now()).toISOString(),
          modified: new Date(status.lastUpdate ?? Date.now()).toISOString(),
          messageCount: 0,
          firstMessage: "",
          parentSessionPath: parentFile || undefined,
          running: isRunning,
          virtualRun: true,
          runState: status.state,
        });
      } catch {}
    }
  }
  return out;
}
/**
 * Convert a Claude Code .jsonl conversation into a pi-format session file.
 * Returns {cwd, path} or undefined when the file isn't a Claude conversation.
 */
async function convertClaudeSession(
  _raw: string,
  lines: string[],
): Promise<{ cwd: string; path: string } | undefined> {
  // detect Claude: has last-prompt/user/assistant entries
  let cwd = "";
  const entries: {
    role: "user" | "assistant";
    content: unknown;
    ts: string;
  }[] = [];
  for (const line of lines) {
    let e: {
      type?: string;
      cwd?: string;
      timestamp?: string;
      message?: { role?: string; content?: unknown };
    };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.cwd) cwd = e.cwd;
    if (e.type === "user" || e.type === "assistant") {
      const content = e.message?.content;
      if (typeof content === "string" && content.length > 0) {
        entries.push({
          role: e.type,
          content: [{ type: "text", text: content }],
          ts: e.timestamp ?? new Date().toISOString(),
        });
      } else if (Array.isArray(content)) {
        // text-only conversion: Claude tool_use/tool_result explode to thousands of
        // structured blocks that pi's content validation rejects (image/block cap).
        const blocks: { type: string; text: string }[] = [];
        for (const b of content) {
          if (!b) continue;
          if (b.type === "text" && b.text)
            blocks.push({ type: "text", text: b.text });
          else if (b.type === "tool_use")
            blocks.push({
              type: "text",
              text: `[调用工具: ${String(b.name ?? "tool")}]`,
            });
          else if (b.type === "tool_result")
            blocks.push({
              type: "text",
              text: `[工具结果] ${typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "").slice(0, 2000)}`,
            });
        }
        if (blocks.length > 0)
          entries.push({
            role: e.type,
            content: blocks,
            ts: e.timestamp ?? new Date().toISOString(),
          });
      }
    }
  }
  if (entries.length === 0 || !cwd) return undefined;
  // cap imported history by cumulative token estimate (~1M ctx, leave headroom).
  // Walk backwards from the newest message, accumulating until the budget is hit.
  const TOKEN_BUDGET = 900_000;
  const estTokens = (content: unknown): number => {
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? (content as { type: string; text?: string }[])
              .map((b) => b.text ?? "")
              .join(" ")
          : "";
    // rough: ~3 chars/token for mixed CJK; add per-message overhead
    return Math.ceil(text.length / 3) + 24;
  };
  let used = 0;
  let start = entries.length;
  for (let i = entries.length - 1; i >= 0; i--) {
    const cost = estTokens(entries[i].content);
    if (used + cost > TOKEN_BUDGET && start !== entries.length) break;
    used += cost;
    start = i;
  }
  if (start > 0) entries.splice(0, start);

  // build a pi-format JSONL. Rebuild the parent chain over the FINAL entries so
  // that dropping a bad line can never leave a dangling parentId (that broke
  // pi's branch walk before). Every emitted line is a single clean JSON object.
  const sessionId = crypto.randomUUID();
  const clean = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: new Date().toISOString(),
      cwd,
    }),
  ];
  let prev = sessionId.slice(0, 8);
  for (const ent of entries) {
    const id = crypto.randomUUID().slice(0, 8);
    let line = "";
    try {
      line = JSON.stringify({
        type: "message",
        id,
        parentId: prev,
        timestamp: ent.ts,
        message: { role: ent.role, content: ent.content, timestamp: ent.ts },
      });
    } catch {
      // non-serializable content → skip this message, keep the chain intact
      continue;
    }
    // if a content text carried an unescaped JSON fragment the line may contain
    // a second object; trim to the first valid JSON so the line is single
    try {
      const obj = JSON.parse(line);
      clean.push(JSON.stringify(obj));
    } catch {
      continue;
    }
    prev = id;
  }
  const fileName = `${new Date().toISOString().replace(/[:.]/g, "-")}_import-${sessionId.slice(0, 8)}.jsonl`;
  const dir = join(getAgentDir(), "sessions", encodeCwd(cwd));
  await mkdir(dir, { recursive: true });
  const path = join(dir, fileName);
  await writeFile(path, clean.join("\n"));
  return { cwd, path };
}

function encodeCwd(cwd: string): string {
  // match pi's SessionManager encoding exactly: --<cwd-no-leading-slash, / and : -> ->--
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

{
  const sessionsDir = join(getAgentDir(), "sessions");
  let timer: NodeJS.Timeout | undefined;
  try {
    watch(sessionsDir, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        sessionsVersion += 1;
      }, 500);
    });
  } catch {
    // sessions dir may not exist yet on fresh installs
  }
}

// ---------------------------------------------------------------------------
// pii-web state (archive list etc.), stored next to pi's own config
// ---------------------------------------------------------------------------
const STATE_PATH = join(getAgentDir(), "pii-web-state.json");
const STATE_BACKUP_PATH = `${STATE_PATH}.bak`;

interface PiiState {
  archived: string[];
  favorites: string[];
  projectOrder: string[];
  version: number;
  /** In-memory only: primary was invalid and backup supplied this state. */
  recoveredFromBackup?: boolean;
}

async function readStateFile(path: string): Promise<PiiState> {
  const doc = parseJson(await readFile(path, "utf-8"), String(path)) as Partial<PiiState>;
  return {
    archived: Array.isArray(doc.archived) ? doc.archived : [],
    favorites: Array.isArray(doc.favorites) ? doc.favorites : [],
    projectOrder: Array.isArray(doc.projectOrder) ? doc.projectOrder : [],
    version: typeof doc.version === "number" ? doc.version : 0,
  };
}

async function readState(): Promise<PiiState> {
  try {
    return { ...(await readStateFile(STATE_PATH)), recoveredFromBackup: false };
  } catch (primaryCause) {
    try {
      const recovered = await readStateFile(STATE_BACKUP_PATH);
      console.error(`[state] recovered_from_backup path=${STATE_BACKUP_PATH}`, primaryCause);
      return { ...recovered, recoveredFromBackup: true };
    } catch {
      return { archived: [], favorites: [], projectOrder: [], version: 0 };
    }
  }
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeState(state: PiiState): Promise<void> {
  const directory = dirname(STATE_PATH);
  await mkdir(directory, { recursive: true });
  const suffix = `${process.pid}-${crypto.randomUUID()}`;
  const tempPath = `${STATE_PATH}.${suffix}.tmp`;
  const backupTempPath = `${STATE_BACKUP_PATH}.${suffix}.tmp`;
  const serialized = JSON.stringify({
    archived: state.archived,
    favorites: state.favorites,
    projectOrder: state.projectOrder,
    version: state.version,
  }, null, 2) + "\n";
  try {
    const handle = await open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(serialized);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (state.recoveredFromBackup) {
      const backupHandle = await open(backupTempPath, "wx", 0o600);
      try {
        await backupHandle.writeFile(serialized);
        await backupHandle.sync();
      } finally {
        await backupHandle.close();
      }
    } else if (existsSync(STATE_PATH)) {
      await copyFile(STATE_PATH, backupTempPath);
      await syncFile(backupTempPath);
    }
    await rename(tempPath, STATE_PATH);
    if (existsSync(backupTempPath)) await rename(backupTempPath, STATE_BACKUP_PATH);
    state.recoveredFromBackup = false;
    const directoryHandle = await open(directory, "r");
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } catch (cause) {
    await Promise.all([
      unlink(tempPath).catch(() => undefined),
      unlink(backupTempPath).catch(() => undefined),
    ]);
    throw cause;
  }
}

let stateMutationQueue: Promise<void> = Promise.resolve();
function mutateState(mutator: (state: PiiState) => void): Promise<PiiState> {
  const result = stateMutationQueue.then(async () => {
    const state = await readState();
    mutator(state);
    state.version += 1;
    await writeState(state);
    return state;
  });
  stateMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
/** Like readBody but resolves the reject to a 413 response instead of killing the socket. */
function readBodyGraceful(
  req: IncomingMessage,
  limit: number,
): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        if (!done) {
          done = true;
          reject(new Error("body too large"));
        }
        req.pause();
      } else {
        chunks.push(c);
      }
    });
    req.on("end", () => {
      if (!done) resolvePromise(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
  });
}

function readBody(
  req: IncomingMessage,
  limit = 64 * 1024 * 1024,
): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

class InvalidJsonBodyError extends Error {}

function parseJson<T>(raw: string, source: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (cause) {
    throw new Error(`invalid JSON in ${source}`, { cause });
  }
}

async function readJsonBody<T>(
  req: IncomingMessage,
  limit = 1024 * 1024,
): Promise<T> {
  try {
    return parseJson<T>((await readBody(req, limit)).toString(), "request body");
  } catch (cause) {
    throw new InvalidJsonBodyError("invalid JSON request body", { cause });
  }
}

function exec(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      cmd,
      args,
      { cwd, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolvePromise(stdout);
      },
    );
  });
}

async function knownWorkspaceRoots(): Promise<string[]> {
  const listed = await SessionManager.listAll();
  return [
    ...new Set([
      ...listed.map((session) => session.cwd).filter(Boolean),
      ...[...hosts.values()].map((host) => host.cwd),
    ]),
  ];
}

async function trustedSessionPath(input: string): Promise<string> {
  const absolute = resolve(input);
  const requested = await realpath(absolute).catch(() => undefined);
  if (extname(absolute).toLowerCase() !== ".jsonl") throw new Error("session not found");
  const liveOwnedPath = [...hosts.values()]
    .map((host) => host.session.sessionFile)
    .filter((path): path is string => Boolean(path))
    .find((path) => resolve(path) === absolute);
  if (!requested && liveOwnedPath) return absolute;
  if (!requested) throw new Error("session not found");
  const listed = await SessionManager.listAll();
  const known = new Set([
    ...listed.map((session) => session.path),
    ...[...hosts.values()]
      .map((host) => host.session.sessionFile)
      .filter((path): path is string => Boolean(path)),
  ]);
  for (const path of known) {
    const canonical = await realpath(path).catch(() => undefined);
    if (canonical === requested) return requested;
  }
  throw new Error("session path is not managed by pi");
}

const TEXT_EXTS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".jsonl",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".css",
  ".scss",
  ".less",
  ".html",
  ".xml",
  ".svg",
  ".yml",
  ".yaml",
  ".toml",
  ".ini",
  ".cfg",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".cs",
  ".sh",
  ".bash",
  ".zsh",
  ".sql",
  ".vue",
  ".svelte",
  ".env",
  ".gitignore",
  ".lock",
  ".log",
  ".csv",
  ".swift",
  ".kt",
  ".lua",
]);
const IMAGE_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
  ".bmp",
]);
function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

/** Minimal glob matcher: supports * and ** against forward-slash paths. */
function globMatch(pattern: string, path: string): boolean {
  const p = pattern.split("/").map((seg) =>
    seg === "**"
      ? "(?:[^/]+/)*"
      : seg
          .split("")
          .map((c) =>
            c === "*" ? "[^/]*" : c.replace(/[.+?^${}()|[\]\\]/g, "\\$&"),
          )
          .join(""),
  );
  const re = new RegExp(`^${p.join("/")}$`);
  return re.test(path) || re.test(path.replace(/\\/g, "/"));
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

const WEB_DIST = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../web/dist",
);

async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const file = normalize(join(WEB_DIST, pathname));
  if (
    !file.startsWith(WEB_DIST) ||
    !existsSync(file) ||
    !(await stat(file)).isFile()
  ) {
    // SPA fallback
    const index = join(WEB_DIST, "index.html");
    if (existsSync(index)) {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      res.end(await readFile(index));
      return;
    }
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const cache = /index-[A-Za-z0-9_-]+\.(js|css)$/.test(file)
    ? "public, max-age=31536000, immutable"
    : "no-cache";
  res.writeHead(200, {
    "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
    "Cache-Control": cache,
  });
  createReadStream(file).pipe(res);
}

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------
async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (path === "/api/health") {
    sendJson(res, 200, { ok: true, name: "pii-web" });
    return true;
  }

  if (path === "/api/sessions/resolve" && req.method === "GET") {
    const id = url.searchParams.get("id");
    if (!id) {
      sendJson(res, 400, { error: "missing id" });
      return true;
    }
    const all = await SessionManager.listAll();
    const match = all.find(
      (s) => s.id === id || s.id.startsWith(id) || id.startsWith(s.id),
    );
    if (!match) {
      sendJson(res, 404, { error: "session not found" });
      return true;
    }
    sendJson(res, 200, { cwd: match.cwd, path: match.path, id: match.id });
    return true;
  }

  if (path === "/api/runs" && req.method === "GET") {
    const runs = [...hosts.values()]
      .map((h) => {
        const s = h.session;
        const snap = h.snapshot();
        const firstUser = snap.messages.find((m) => m.role === "user");
        const firstText = firstUser
          ? typeof firstUser.content === "string"
            ? firstUser.content
            : Array.isArray(firstUser.content)
              ? ((firstUser.content as { type?: string; text?: string }[]).find(
                  (b) => b.type === "text",
                )?.text ?? "")
              : ""
          : "";
        return {
          sessionFile: s.sessionFile,
          cwd: h.cwd,
          title: s.sessionName || firstText.slice(0, 60) || "(新会话)",
          model: s.model ? `${s.model.provider}/${s.model.id}` : undefined,
          modelName: s.model?.name,
          startedAt: h.runStartedAt ?? null,
          isStreaming: s.isStreaming,
          queued:
            h.snapshot().queue.steering.length +
            h.snapshot().queue.followUp.length,
          active: h.activeExecutions,
        };
      })
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    sendJson(res, 200, { runs });
    return true;
  }

  if (path === "/api/subagent-runs" && req.method === "GET") {
    const parent = url.searchParams.get("parent") ?? "";
    const runs = listVirtualSubagentRuns(new Set()).filter(
      (v) => !parent || v.parentSessionPath === parent,
    );
    sendJson(res, 200, { runs });
    return true;
  }

  if (path === "/api/subagent-run" && req.method === "GET") {
    const runId = url.searchParams.get("runId") ?? "";
    if (!/^[a-z0-9_\-|]+$/i.test(runId)) {
      sendJson(res, 400, { error: "bad runId" });
      return true;
    }
    const tmp = tmpdir();
    let found: { dir: string; status: Record<string, unknown> } | undefined;
    try {
      for (const scope of readdirSync(tmp).filter((d) =>
        d.startsWith("pi-subagents-"),
      )) {
        const dir = join(tmp, scope, "async-subagent-runs", runId);
        if (existsSync(join(dir, "status.json"))) {
          found = {
            dir,
            status: JSON.parse(readFileSync(join(dir, "status.json"), "utf8")),
          };
          break;
        }
      }
    } catch {
      /* ignore */
    }
    if (!found) {
      sendJson(res, 404, { error: "run not found" });
      return true;
    }
    const status = found.status as {
      state?: string;
      cwd?: string;
      sessionId?: string;
      startedAt?: number;
      lastUpdate?: number;
      artifactsDir?: string;
      pid?: number;
    };
    let alive = false;
    if (typeof status.pid === "number") {
      try {
        process.kill(status.pid, 0);
        alive = true;
      } catch {
        /* dead */
      }
    }
    let agent = "subagent";
    let task = "";
    if (status.artifactsDir) {
      try {
        const meta = readdirSync(status.artifactsDir).find(
          (f) => f.startsWith(`${runId}_`) && f.endsWith("_meta.json"),
        );
        if (meta) {
          const m = JSON.parse(
            readFileSync(join(status.artifactsDir, meta), "utf8"),
          ) as { agent?: string; task?: string };
          if (m.agent) agent = m.agent;
          if (m.task) task = m.task;
        }
      } catch {
        /* ignore */
      }
    }
    // live log: formatted per-step log preferred, runner stdout as fallback
    let log = "";
    const logCandidates = [
      join(found.dir, `subagent-log-${runId}.md`),
      join(found.dir, "output-0.log"),
    ];
    for (const p of logCandidates) {
      try {
        const content = readFileSync(p, "utf8");
        const lines = content.split("\n");
        log = lines.slice(-200).join("\n");
        if (log.trim()) break;
      } catch {
        /* next */
      }
    }
    // read usage (tokens/cost) from a real subagent session file
    const readUsage = (sessionFile?: string) => {
      if (!sessionFile || !existsSync(sessionFile))
        return { tokens: 0, cost: 0 };
      let tokens = 0;
      let cost = 0;
      try {
        for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
          if (!line.trim()) continue;
          const e = JSON.parse(line) as {
            type?: string;
            message?: {
              usage?: { totalTokens?: number; cost?: { total?: number } };
            };
          };
          const u = e.type === "message" ? e.message?.usage : undefined;
          if (u) {
            tokens += u.totalTokens ?? 0;
            cost += u.cost?.total ?? 0;
          }
        }
      } catch {
        /* ignore */
      }
      return { tokens, cost };
    };

    // per-step state from the workflow event stream (latest event per key)
    const steps: {
      key: string;
      state: string;
      durationMs?: number;
      agent?: string;
      tokens?: number;
      cost?: number;
      sessionFile?: string;
    }[] = [];
    try {
      const eventsRaw = readFileSync(join(found.dir, "events.jsonl"), "utf8");
      const byKey = new Map<
        string,
        { key: string; state: string; durationMs?: number }
      >();
      for (const line of eventsRaw.split("\n")) {
        if (!line.trim()) continue;
        const e = JSON.parse(line) as {
          type?: string;
          trace?: { key?: string; state?: string; durationMs?: number }[];
        };
        if (e.type === "subagent.workflow.trace" && Array.isArray(e.trace)) {
          for (const tr of e.trace) {
            if (!tr.key || !tr.state) continue;
            byKey.set(tr.key, {
              key: tr.key,
              state: tr.state,
              durationMs: tr.durationMs,
            });
          }
        }
      }
      steps.push(...byKey.values());
    } catch {
      /* single runs have no trace */
    }

    // if status.json carries a steps[] array, prefer its richer detail (agent,
    // per-step timing, real session file → token/cost aggregation)
    // SAFETY: runner status.json may include the documented optional workflow steps extension.
    const statusSteps = (
      status as unknown as {
        steps?: {
          agent?: string;
          label?: string;
          status?: string;
          startedAt?: number;
          lastActivityAt?: number;
          durationMs?: number;
          sessionFile?: string;
        }[];
      }
    ).steps;
    if (Array.isArray(statusSteps) && statusSteps.length > 0) {
      const agg = statusSteps.map((st) => {
        const u = readUsage(st.sessionFile);
        const dur =
          st.durationMs ??
          (st.lastActivityAt ?? status.lastUpdate ?? 0) -
            (st.startedAt ?? status.startedAt ?? 0);
        return {
          key: st.label ?? st.agent ?? "step",
          state: st.status ?? "unknown",
          agent: st.agent,
          durationMs: dur,
          tokens: u.tokens,
          cost: u.cost,
          sessionFile: st.sessionFile,
        };
      });
      if (agg.length > 0) {
        steps.length = 0;
        steps.push(...agg);
      }
    }

    sendJson(res, 200, {
      runId,
      agent,
      task,
      state: status.state ?? (alive ? "running" : "unknown"),
      alive,
      cwd: status.cwd,
      parentSessionPath: status.sessionId,
      startedAt: status.startedAt,
      lastUpdate: status.lastUpdate,
      log,
      steps,
    });
    return true;
  }

  if (path === "/api/client-error" && req.method === "POST") {
    const body = await readJsonBody(req, 1024 * 1024) as {
      message?: string;
      stack?: string;
      url?: string;
      ts?: number;
    };
    console.log(
      "[client-error]",
      body.url ?? "",
      body.message ?? "",
      "\n",
      (body.stack ?? "").split("\n").slice(0, 8).join("\n"),
    );
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (path === "/api/sessions/version" && req.method === "GET") {
    sendJson(res, 200, { version: sessionsVersion });
    return true;
  }

  if (path === "/api/sessions" && req.method === "GET") {
    const includeArchived = url.searchParams.get("includeArchived") === "1";
    const running = new Set(
      [...hosts.values()]
        .filter((h) => h.isRunning)
        .map((h) => h.session.sessionFile)
        .filter(Boolean) as string[],
    );
    const state = await readState();
    const archivedSet = new Set(state.archived);
    const all = await SessionManager.listAll();
    // pi defers writing a new session file until the first assistant reply —
    // merge live hosts so not-yet-flushed sessions appear in the sidebar now.
    const known = new Set(all.map((s) => s.path));
    for (const h of [...hosts.values()]) {
      const file = h.session.sessionFile;
      if (!file || known.has(file)) continue;
      const snap = h.snapshot();
      const firstUser = snap.messages.find((m) => m.role === "user");
      // a bare hero-page attach creates an empty host — don't list it until
      // the user actually sends something
      if (!firstUser) continue;
      const firstText = firstUser
        ? typeof firstUser.content === "string"
          ? firstUser.content
          : Array.isArray(firstUser.content)
            ? ((firstUser.content as { type?: string; text?: string }[]).find(
                (b) => b.type === "text",
              )?.text ?? "")
            : ""
        : "";
      known.add(file);
      // SAFETY: older SDK declarations omit sessionId although runtime sessions expose it.
      const runtimeSessionId = (h.session as unknown as { sessionId?: string })
        .sessionId;
      all.push({
        path: file,
        id: String(runtimeSessionId ?? file),
        cwd: h.cwd,
        name: snap.name,
        created: new Date(),
        modified: new Date(),
        messageCount: snap.messages.length,
        firstMessage: firstText,
        allMessagesText: firstText,
      });
    }
    const byCwd = new Map<string, ProjectGroup>();
    for (const s of all) {
      if (!includeArchived && archivedSet.has(s.path)) continue;
      const cwd = s.cwd || "(unknown)";
      let group = byCwd.get(cwd);
      if (!group) {
        group = { cwd, sessions: [] };
        byCwd.set(cwd, group);
      }
      group.sessions.push({
        path: s.path,
        id: s.id,
        cwd: s.cwd,
        name: s.name,
        created: s.created.toISOString(),
        modified: s.modified.toISOString(),
        messageCount: s.messageCount,
        firstMessage: s.firstMessage.slice(0, 200),
        running: running.has(s.path),
        archived: archivedSet.has(s.path),
        parentSessionPath: s.parentSessionPath,
      });
    }
    const groups = [...byCwd.values()].sort(
      (a, b) =>
        Math.max(...b.sessions.map((s) => Date.parse(s.modified))) -
        Math.max(...a.sessions.map((s) => Date.parse(s.modified))),
    );
    for (const g of groups)
      g.sessions.sort(
        (a, b) => Date.parse(b.modified) - Date.parse(a.modified),
      );
    sendJson(res, 200, { projects: groups });
    return true;
  }

  if (path === "/api/sessions/archive" && req.method === "POST") {
    const body = await readJsonBody(req, 1024 * 1024) as {
      path?: string;
      archived?: boolean;
    };
    if (!body.path) {
      sendJson(res, 400, { error: "missing path" });
      return true;
    }
    await mutateState((state) => {
      const set = new Set(state.archived);
      if (body.archived) set.add(body.path!);
      else set.delete(body.path!);
      state.archived = [...set];
    });
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (path === "/api/sessions/rename" && req.method === "POST") {
    const body = await readJsonBody(req, 1024 * 1024) as {
      path?: string;
      name?: string;
    };
    if (!body.path || typeof body.name !== "string") {
      sendJson(res, 400, { error: "missing path or name" });
      return true;
    }
    const sessionPath = await trustedSessionPath(body.path);
    // Naming is metadata, not activity: preserve the previous mtime so a
    // rename cannot move the session to the top of the activity-sorted list.
    const originalTimes = await stat(sessionPath);
    // A live host renames through the SDK; otherwise append a session_info
    // entry to the session file directly (pi's own persistence format).
    const liveHost = [...hosts.values()].find(
      (h) => h.session.sessionFile === sessionPath,
    );
    if (liveHost?.isRunning) {
      sendJson(res, 409, { error: "cannot rename a running session" });
      return true;
    }
    if (liveHost) {
      liveHost.session.setSessionName(body.name.slice(0, 200));
    } else {
      const content = (await readFile(sessionPath, "utf-8"))
        .split("\n")
        .filter(Boolean);
      if (content.length === 0) {
        sendJson(res, 400, { error: "empty session file" });
        return true;
      }
      let parentId: string | null = null;
      try {
        const last = JSON.parse(content[content.length - 1]) as { id?: string };
        parentId = last.id ?? null;
      } catch {
        // keep null
      }
      const entry = {
        type: "session_info",
        id: crypto.randomUUID().slice(0, 8),
        parentId,
        timestamp: new Date().toISOString(),
        name: body.name.slice(0, 200),
      };
      content.push(JSON.stringify(entry));
      await writeFile(sessionPath, content.join("\n") + "\n");
    }
    await utimes(sessionPath, originalTimes.atime, originalTimes.mtime);
    bumpSessionsVersion();
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (path === "/api/state" && req.method === "GET") {
    const state = await readState();
    sendJson(res, 200, {
      favorites: state.favorites,
      projectOrder: state.projectOrder,
      version: state.version,
    });
    return true;
  }

  if (path === "/api/state/favorites" && req.method === "POST") {
    const body = await readJsonBody(req, 1024 * 1024) as {
      cwd?: string;
      favorite?: boolean;
    };
    if (!body.cwd || typeof body.favorite !== "boolean") {
      sendJson(res, 400, { error: "missing cwd or favorite" });
      return true;
    }
    const state = await mutateState((current) => {
      const favorites = new Set(current.favorites);
      if (body.favorite) favorites.add(body.cwd!);
      else favorites.delete(body.cwd!);
      current.favorites = [...favorites];
    });
    sendJson(res, 200, { favorites: state.favorites, projectOrder: state.projectOrder, version: state.version });
    return true;
  }

  if (path === "/api/state/project-order" && req.method === "POST") {
    const body = await readJsonBody(req, 1024 * 1024) as {
      cwd?: string;
      beforeCwd?: string;
      visibleOrder?: string[];
    };
    if (!body.cwd) {
      sendJson(res, 400, { error: "missing cwd" });
      return true;
    }
    const state = await mutateState((current) => {
      const visible = Array.isArray(body.visibleOrder) ? body.visibleOrder.filter((value) => typeof value === "string") : [];
      const order = [...new Set([...current.projectOrder, ...visible])].filter((cwd) => cwd !== body.cwd);
      const before = body.beforeCwd ? order.indexOf(body.beforeCwd) : -1;
      order.splice(before >= 0 ? before : order.length, 0, body.cwd!);
      current.projectOrder = order;
    });
    sendJson(res, 200, { favorites: state.favorites, projectOrder: state.projectOrder, version: state.version });
    return true;
  }

  if (path === "/api/state" && req.method === "POST") {
    const body = await readJsonBody(req, 1024 * 1024) as {
      favorites?: string[];
      projectOrder?: string[];
    };
    const state = await mutateState((current) => {
      if (Array.isArray(body.favorites)) current.favorites = body.favorites.filter((x) => typeof x === "string");
      if (Array.isArray(body.projectOrder)) current.projectOrder = body.projectOrder.filter((x) => typeof x === "string");
    });
    sendJson(res, 200, { favorites: state.favorites, projectOrder: state.projectOrder, version: state.version });
    return true;
  }

  if (path === "/api/sessions/archive" && req.method === "GET") {
    const state = await readState();
    sendJson(res, 200, { archived: state.archived });
    return true;
  }

  if (path === "/api/sessions" && req.method === "DELETE") {
    const requestedPath = url.searchParams.get("path");
    if (!requestedPath) {
      sendJson(res, 400, { error: "missing path" });
      return true;
    }
    const sessionPath = await trustedSessionPath(requestedPath);
    for (const [key, h] of [...hosts]) {
      if (h.session.sessionFile === sessionPath) {
        await h.dispose();
        hosts.delete(key);
      }
    }
    await unlink(sessionPath);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (path === "/api/models" && req.method === "GET") {
    const { runtime, registry } = await getModelServices();
    const providers = runtime.getProviders().map((p) => {
      const status = registry.getProviderAuthStatus(p.id);
      return {
        id: p.id,
        name: p.name ?? registry.getProviderDisplayName(p.id),
        configured: Boolean(status?.configured),
        authSource: status?.source,
        hasOAuth: Boolean(p.auth.oauth),
        modelCount: runtime.getModels(p.id).length,
      };
    });
    const models = registry.getAll().map((m) => ({
      provider: m.provider,
      id: m.id,
      name: m.name ?? m.id,
      baseUrl: m.baseUrl,
      reasoning: Boolean(m.reasoning),
      input: m.input ?? ["text"],
      contextWindow: m.contextWindow,
      hasAuth: registry.hasConfiguredAuth(m),
    }));
    sendJson(res, 200, { providers, models });
    return true;
  }

  // ---- custom providers (~/.pi/agent/models.json) ----------------------
  if (path === "/api/providers" && req.method === "POST") {
    const body = await readJsonBody(req, 4 * 1024 * 1024) as {
      id?: string;
      name?: string;
      baseUrl?: string;
      api?: string;
      apiKey?: string;
      models?: Record<string, unknown>[];
    };
    if (
      !body.id ||
      !body.baseUrl ||
      !body.api ||
      !Array.isArray(body.models) ||
      body.models.length === 0
    ) {
      sendJson(res, 400, { error: "required: id, baseUrl, api, models[]" });
      return true;
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(body.id)) {
      sendJson(res, 400, {
        error: "id must be lowercase letters/digits/dashes",
      });
      return true;
    }
    const modelsPath = join(getAgentDir(), "models.json");
    const doc = existsSync(modelsPath)
      ? (parseJson(await readFile(modelsPath, "utf-8"), String(modelsPath)) as Record<
          string,
          unknown
        >)
      : {};
    const providers = (doc.providers ?? {}) as Record<string, unknown>;
    providers[body.id] = {
      ...(body.name ? { name: body.name } : {}),
      baseUrl: body.baseUrl,
      api: body.api,
      ...(body.apiKey ? { apiKey: body.apiKey } : {}),
      models: body.models,
    };
    doc.providers = providers;
    await writeFile(modelsPath, JSON.stringify(doc, null, 2) + "\n");
    // Recreate the shared model runtime so the new provider shows up.
    modelServices = undefined;
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (path === "/api/providers" && req.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id) {
      sendJson(res, 400, { error: "missing id" });
      return true;
    }
    const modelsPath = join(getAgentDir(), "models.json");
    const doc = existsSync(modelsPath)
      ? (parseJson(await readFile(modelsPath, "utf-8"), String(modelsPath)) as Record<
          string,
          unknown
        >)
      : {};
    const providers = (doc.providers ?? {}) as Record<string, unknown>;
    if (!(id in providers)) {
      sendJson(res, 404, { error: "not a custom (models.json) provider" });
      return true;
    }
    delete providers[id];
    doc.providers = providers;
    await writeFile(modelsPath, JSON.stringify(doc, null, 2) + "\n");
    modelServices = undefined;
    sendJson(res, 200, { ok: true });
    return true;
  }

  // ---- skills add / delete ----------------------------------------------
  if (path === "/api/skills" && req.method === "POST") {
    const body = await readJsonBody(req, 4 * 1024 * 1024) as {
      name?: string;
      description?: string;
      content?: string;
    };
    if (!body.name || !/^[a-z0-9][a-z0-9-]*$/.test(body.name)) {
      sendJson(res, 400, {
        error: "name must be lowercase letters/digits/dashes",
      });
      return true;
    }
    const dir = join(getAgentDir(), "skills", body.name);
    await mkdir(dir, { recursive: true });
    const front = `---\nname: ${body.name}\ndescription: ${(body.description ?? "").replace(/\n/g, " ")}\n---\n\n`;
    await writeFile(join(dir, "SKILL.md"), front + (body.content ?? ""));
    sendJson(res, 200, { ok: true, path: join(dir, "SKILL.md") });
    return true;
  }

  if (path === "/api/skills" && req.method === "DELETE") {
    const filePath = url.searchParams.get("path");
    if (!filePath) {
      sendJson(res, 400, { error: "missing path" });
      return true;
    }
    const home = process.env.HOME ?? "";
    const allowedRoots = [
      join(home, ".agents", "skills"),
      join(getAgentDir(), "skills"),
    ];
    const dir = dirname(normalize(filePath));
    if (
      !allowedRoots.some((root) => dir.startsWith(root + "/") || dir === root)
    ) {
      sendJson(res, 403, {
        error: "only user-scope skill directories can be removed",
      });
      return true;
    }
    const { rm } = await import("node:fs/promises");
    await rm(dir, { recursive: true, force: true });
    sendJson(res, 200, { ok: true });
    return true;
  }

  // ---- package enable / disable (pi config semantics) -------------------
  if (path === "/api/packages/config" && req.method === "GET") {
    const cwd = url.searchParams.get("cwd") ?? process.cwd();
    const sm = SettingsManager.create(cwd, getAgentDir());
    const pm = new DefaultPackageManager({
      cwd,
      agentDir: getAgentDir(),
      settingsManager: sm,
    });
    const settingsPkgs = sm.getGlobalSettings().packages ?? [];
    const projPkgs = sm.getProjectSettings().packages ?? [];
    const configured = pm.listConfiguredPackages();

    const KINDS = ["skills", "extensions", "prompts", "themes"] as const;
    const result = configured.map((pkg) => {
      const entry = (pkg.scope === "project" ? projPkgs : settingsPkgs).find(
        (p) => (typeof p === "string" ? p : p.source) === pkg.source,
      );
      const obj =
        typeof entry === "object" && entry !== null
          ? (entry as Record<string, unknown>)
          : undefined;
      const autoloadDisabled = obj?.autoload === false;
      const filters = obj as
        | {
            skills?: string[];
            extensions?: string[];
            prompts?: string[];
            themes?: string[];
          }
        | undefined;

      // scan installed package contents (convention dirs)
      const contents: Record<string, { path: string; enabled: boolean }[]> = {};
      const root = pkg.installedPath;
      for (const kind of KINDS) {
        const files: { path: string; enabled: boolean }[] = [];
        if (root) {
          const kindDir = join(root, kind);
          const walk = (dir: string): void => {
            if (!existsSync(dir)) return;
            for (const e of readdirSync(dir, { withFileTypes: true })) {
              const full = join(dir, e.name);
              if (e.isDirectory()) walk(full);
              else
                files.push({
                  path: full.slice(root.length + 1),
                  enabled: true,
                });
            }
          };
          walk(kindDir);
        }
        const patterns = filters?.[kind];
        for (const f of files) {
          if (autoloadDisabled) {
            // with autoload=false the patterns act as a re-enable list
            f.enabled = patterns
              ? patterns.some((p) => globMatch(p, f.path))
              : false;
          } else if (patterns === undefined) {
            f.enabled = true;
          } else {
            f.enabled = patterns.some((p) => globMatch(p, f.path));
          }
        }
        contents[kind] = files;
      }
      return {
        source: pkg.source,
        scope: pkg.scope,
        installedPath: pkg.installedPath,
        enabled: !autoloadDisabled,
        filters: filters ?? {},
        contents,
      };
    });
    sendJson(res, 200, { packages: result });
    return true;
  }

  if (path === "/api/packages/config" && req.method === "POST") {
    const body = await readJsonBody(req, 2 * 1024 * 1024) as {
      source: string;
      scope?: "user" | "project";
      enabled?: boolean;
      toggleKind?: "skills" | "extensions" | "prompts" | "themes";
      togglePath?: string;
      toggleEnabled?: boolean;
      contents?: Record<string, { path: string; enabled: boolean }[]>;
    };
    if (!body.source) {
      sendJson(res, 400, { error: "missing source" });
      return true;
    }
    const cwd = url.searchParams.get("cwd") ?? process.cwd();
    const sm = SettingsManager.create(cwd, getAgentDir());
    const isProject = body.scope === "project";
    const list: PackageSource[] = [
      ...((isProject
        ? sm.getProjectSettings().packages
        : sm.getGlobalSettings().packages) ?? []),
    ];
    const idx = list.findIndex(
      (p) => (typeof p === "string" ? p : p.source) === body.source,
    );
    if (idx === -1) {
      sendJson(res, 404, { error: "package not configured" });
      return true;
    }
    const prev = list[idx];
    const obj: Record<string, unknown> =
      typeof prev === "object" && prev !== null
        ? { ...prev }
        : { source: body.source };

    if (body.enabled !== undefined) {
      obj.autoload = body.enabled ? undefined : false;
      if (obj.autoload === undefined) delete obj.autoload;
    }

    if (body.toggleKind && body.togglePath) {
      const kind = body.toggleKind;
      const all = (body.contents?.[kind] ?? []).map((f) => f.path);
      const current: string[] | undefined = Array.isArray(obj[kind])
        ? [...(obj[kind] as string[])]
        : undefined;
      const autoloadDisabled = obj.autoload === false;

      if (autoloadDisabled) {
        // re-enable list semantics: add/remove the path
        const set = new Set(current ?? []);
        if (body.toggleEnabled) set.add(body.togglePath);
        else set.delete(body.togglePath);
        obj[kind] = [...set];
      } else {
        // allowlist semantics
        let set: Set<string>;
        if (current === undefined) {
          // all currently enabled; disabling one => allowlist of the rest
          set = new Set(all.filter((p) => p !== body.togglePath));
          if (body.toggleEnabled) {
            // enabling with no filter is a no-op
            delete obj[kind];
          } else {
            // that's the new allowlist
            obj[kind] = [...set];
          }
        } else {
          set = new Set(current);
          if (body.toggleEnabled) set.add(body.togglePath);
          else set.delete(body.togglePath);
          // if allowlist now covers everything, drop the filter
          if (all.length > 0 && all.every((p) => set.has(p))) delete obj[kind];
          else obj[kind] = [...set];
        }
      }
    }

    list[idx] = obj as PackageSource;
    if (isProject) sm.setProjectPackages(list);
    else sm.setPackages(list);
    sendJson(res, 200, { ok: true });
    return true;
  }

  // ---- settings (global pi settings) ----------------------------------
  if (path === "/api/settings" && req.method === "GET") {
    const sm = SettingsManager.create(process.cwd(), getAgentDir());
    const s = sm.getGlobalSettings();
    sendJson(res, 200, {
      defaultProvider: s.defaultProvider,
      defaultModel: s.defaultModel,
      defaultThinkingLevel: s.defaultThinkingLevel,
      steeringMode: s.steeringMode,
      followUpMode: s.followUpMode,
      compaction: s.compaction,
      hideThinkingBlock: s.hideThinkingBlock,
    });
    return true;
  }

  if (path === "/api/settings" && req.method === "POST") {
    const body = await readJsonBody(req, 1024 * 1024) as Record<string, unknown>;
    const sm = SettingsManager.create(process.cwd(), getAgentDir());
    if (
      typeof body.defaultProvider === "string" &&
      typeof body.defaultModel === "string"
    ) {
      sm.setDefaultModelAndProvider(body.defaultProvider, body.defaultModel);
    } else if (typeof body.defaultProvider === "string") {
      sm.setDefaultProvider(body.defaultProvider);
    } else if (typeof body.defaultModel === "string") {
      sm.setDefaultModel(body.defaultModel);
    }
    if (typeof body.defaultThinkingLevel === "string")
      sm.setDefaultThinkingLevel(
        body.defaultThinkingLevel as Parameters<
          SettingsManager["setDefaultThinkingLevel"]
        >[0],
      );
    if (body.steeringMode === "all" || body.steeringMode === "one-at-a-time")
      sm.setSteeringMode(body.steeringMode);
    if (body.followUpMode === "all" || body.followUpMode === "one-at-a-time")
      sm.setFollowUpMode(body.followUpMode);
    if (typeof body.compactionEnabled === "boolean")
      sm.setCompactionEnabled(body.compactionEnabled);
    if (typeof body.hideThinkingBlock === "boolean")
      sm.setHideThinkingBlock(body.hideThinkingBlock);
    for (const host of new Set(hosts.values())) {
      host.applySettings({
        steeringMode:
          body.steeringMode === "all" || body.steeringMode === "one-at-a-time"
            ? body.steeringMode
            : undefined,
        followUpMode:
          body.followUpMode === "all" || body.followUpMode === "one-at-a-time"
            ? body.followUpMode
            : undefined,
      });
    }
    sendJson(res, 200, { ok: true });
    return true;
  }

  // ---- extensions (pi packages) ----------------------------------------
  if (path === "/api/extensions" && req.method === "GET") {
    const cwd = url.searchParams.get("cwd") ?? process.cwd();
    const pm = new DefaultPackageManager({
      cwd,
      agentDir: getAgentDir(),
      settingsManager: SettingsManager.create(cwd, getAgentDir()),
    });
    sendJson(res, 200, { packages: pm.listConfiguredPackages() });
    return true;
  }

  if (path === "/api/extensions" && req.method === "POST") {
    const body = await readJsonBody(req, 1024 * 1024) as {
      source?: string;
      cwd?: string;
    };
    if (!body.source) {
      sendJson(res, 400, { error: "missing source" });
      return true;
    }
    const cwd = body.cwd ?? process.cwd();
    const pm = new DefaultPackageManager({
      cwd,
      agentDir: getAgentDir(),
      settingsManager: SettingsManager.create(cwd, getAgentDir()),
    });
    await pm.installAndPersist(body.source);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (path === "/api/extensions" && req.method === "DELETE") {
    const source = url.searchParams.get("source");
    const cwd = url.searchParams.get("cwd") ?? process.cwd();
    if (!source) {
      sendJson(res, 400, { error: "missing source" });
      return true;
    }
    const pm = new DefaultPackageManager({
      cwd,
      agentDir: getAgentDir(),
      settingsManager: SettingsManager.create(cwd, getAgentDir()),
    });
    await pm.remove(source);
    sendJson(res, 200, { ok: true });
    return true;
  }

  // ---- OAuth login flows ------------------------------------------------
  if (path === "/api/auth/oauth/start" && req.method === "POST") {
    cleanOAuthFlows();
    if (oauthFlows.size >= OAUTH_FLOW_LIMIT) {
      sendJson(res, 429, { error: "too many active OAuth flows" });
      return true;
    }
    const body = await readJsonBody(req, 1024 * 1024) as {
      provider?: string;
    };
    if (!body.provider) {
      sendJson(res, 400, { error: "missing provider" });
      return true;
    }
    const { runtime } = await getModelServices();
    const provider = runtime.getProvider(body.provider);
    if (!provider?.auth.oauth) {
      sendJson(res, 400, {
        error: `provider ${body.provider} has no OAuth flow`,
      });
      return true;
    }
    const id = crypto.randomUUID();
    const capability = createFlowCapability();
    const controller = new AbortController();
    const now = Date.now();
    const flow: OAuthFlow = {
      owner: requestOwner(req),
      capabilityHash: capability.hash,
      createdAt: now,
      expiresAt: now + OAUTH_FLOW_TTL_MS,
      controller,
      events: [],
      done: false,
    };
    oauthFlows.set(id, flow);
    void runtime
      .login(body.provider, "oauth", {
        signal: controller.signal,
        notify: (ev) => {
          if (flow.events.length >= 100) flow.events.shift();
          flow.events.push(ev as OAuthFlow["events"][number]);
        },
        prompt: (p) =>
          new Promise<string>((resolvePrompt, rejectPrompt) => {
            flow.pendingPrompt = {
              message: p.message,
              placeholder: "placeholder" in p ? p.placeholder : undefined,
              inputType: p.type,
              resolve: (value: string) => {
                flow.pendingPrompt = undefined;
                resolvePrompt(value);
              },
            };
            p.signal?.addEventListener(
              "abort",
              () => {
                flow.pendingPrompt = undefined;
                rejectPrompt(new Error("cancelled"));
              },
              { once: true },
            );
          }),
      })
      .then(() => {
        flow.done = true;
        flow.expiresAt = Math.min(flow.expiresAt, Date.now() + 60_000);
      })
      .catch((err) => {
        flow.done = true;
        flow.expiresAt = Math.min(flow.expiresAt, Date.now() + 60_000);
        flow.error = controller.signal.aborted
          ? "cancelled"
          : err instanceof Error
            ? err.message
            : String(err);
      });
    sendJson(res, 200, {
      id,
      secret: capability.secret,
      expiresAt: flow.expiresAt,
    });
    return true;
  }

  if (path === "/api/auth/oauth/status" && req.method === "POST") {
    cleanOAuthFlows();
    const body = await readJsonBody(req, 64 * 1024) as {
      id?: string;
      secret?: string;
    };
    const flow = ownedOAuthFlow(req, body.id, body.secret);
    if (!flow) {
      sendJson(res, 404, { error: "unknown flow" });
      return true;
    }
    sendJson(res, 200, {
      events: flow.events,
      pendingPrompt: flow.pendingPrompt
        ? {
            message: flow.pendingPrompt.message,
            placeholder: flow.pendingPrompt.placeholder,
            inputType: flow.pendingPrompt.inputType,
          }
        : undefined,
      done: flow.done,
      error: flow.error,
    });
    if (flow.done) deleteOAuthFlow(body.id!);
    return true;
  }

  if (path === "/api/auth/oauth/answer" && req.method === "POST") {
    cleanOAuthFlows();
    const body = await readJsonBody(req, 1024 * 1024) as {
      id?: string;
      secret?: string;
      value?: string;
    };
    const flow = ownedOAuthFlow(req, body.id, body.secret);
    if (!flow?.pendingPrompt) {
      sendJson(res, 400, { error: "no pending prompt" });
      return true;
    }
    flow.pendingPrompt.resolve((body.value ?? "").slice(0, 8192));
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (path === "/api/auth/oauth/cancel" && req.method === "POST") {
    const body = await readJsonBody(req, 64 * 1024) as {
      id?: string;
      secret?: string;
    };
    const flow = ownedOAuthFlow(req, body.id, body.secret);
    if (!flow) {
      sendJson(res, 404, { error: "unknown flow" });
      return true;
    }
    deleteOAuthFlow(body.id!, true);
    sendJson(res, 200, { ok: true });
    return true;
  }

  // ---- resources: skills / extensions / prompts for a cwd ------------
  if (path === "/api/resources" && req.method === "GET") {
    const cwd = url.searchParams.get("cwd");
    if (!cwd) {
      sendJson(res, 400, { error: "missing cwd" });
      return true;
    }
    // Reuse the attached host's services when available, otherwise build ad-hoc.
    const attached = [...hosts.values()].find((h) => h.cwd === cwd);
    const loader = attached
      ? attached.services.resourceLoader
      : (await createAgentSessionServices({ cwd })).resourceLoader;
    const skills = loader.getSkills().skills.map((s) => ({
      name: s.name,
      description: s.description,
      filePath: s.filePath,
      source: s.sourceInfo?.source,
      scope: s.sourceInfo?.scope,
      disableModelInvocation: s.disableModelInvocation,
    }));
    const extensions = loader.getExtensions().extensions.map((e) => ({
      path: e.path,
      source: e.sourceInfo?.source,
      scope: e.sourceInfo?.scope,
    }));
    const prompts = loader.getPrompts().prompts.map((p) => ({
      name: p.name,
      description: p.description,
      filePath: p.filePath,
    }));
    sendJson(res, 200, { skills, extensions, prompts });
    return true;
  }

  // ---- session import (JSONL) ------------------------------------------
  if (path === "/api/sessions/import" && req.method === "POST") {
    let body: Buffer;
    try {
      body = await readBodyGraceful(req, 512 * 1024 * 1024);
    } catch (cause) {
      if (cause instanceof Error && cause.message === "body too large") {
        sendJson(res, 413, { error: "session import exceeds 512 MiB" });
        return true;
      }
      throw cause;
    }
    const lines = body.toString("utf-8").split("\n").filter(Boolean);
    if (lines.length === 0) {
      sendJson(res, 400, { error: "empty file" });
      return true;
    }
    let header: { type?: string; cwd?: string };
    try {
      header = JSON.parse(lines[0]);
    } catch {
      sendJson(res, 400, { error: "invalid JSONL" });
      return true;
    }
    if (header.type !== "session" || !header.cwd) {
      // Claude Code (.claude/projects/*/*.jsonl) sessions: convert to a pi session.
      const converted = await convertClaudeSession(
        body.toString("utf-8"),
        lines,
      );
      if (converted) {
        sendJson(res, 200, {
          ok: true,
          cwd: converted.cwd,
          sessionFile: converted.path,
          converted: true,
        });
        return true;
      }
      sendJson(res, 400, {
        error:
          "not a pi session file (Claude import requires assistant+user entries)",
      });
      return true;
    }
    const importsDir = join(getAgentDir(), "imports");
    await mkdir(importsDir, { recursive: true });
    const tmpPath = join(importsDir, `import-${Date.now()}.jsonl`);
    await writeFile(tmpPath, body);
    const host = await acquireHost(header.cwd);
    try {
      const result = await host.runtime_import(tmpPath);
      if (!result.ok) {
        sendJson(res, 400, { error: result.error ?? "import failed" });
        return true;
      }
      sendJson(res, 200, {
        ok: true,
        cwd: host.cwd,
        sessionFile: result.sessionFile,
      });
      return true;
    } finally {
      if (host.viewerCount === 0) {
        removeHost(host);
        await host.dispose();
      }
    }
  }

  // ---- auth: API key login / logout ----------------------------------
  if (path === "/api/auth/key" && req.method === "POST") {
    const body = await readJsonBody(req, 1024 * 1024) as {
      provider?: string;
      key?: string;
    };
    if (!body.provider || !body.key) {
      sendJson(res, 400, { error: "missing provider or key" });
      return true;
    }
    const { runtime } = await getModelServices();
    const provider = runtime.getProvider(body.provider);
    if (!provider) {
      sendJson(res, 404, { error: `unknown provider: ${body.provider}` });
      return true;
    }
    try {
      await runtime.login(body.provider, "api_key", {
        prompt: async () => body.key!,
        notify: () => undefined,
      });
      sendJson(res, 200, { ok: true });
    } catch {
      // Some providers lack an interactive api-key login flow; fall back to a
      // runtime key so the session can still use it, and report the caveat.
      await runtime.setRuntimeApiKey(body.provider, body.key);
      sendJson(res, 200, { ok: true, runtimeOnly: true });
    }
    return true;
  }

  if (path === "/api/auth/provider/logout" && req.method === "POST") {
    const body = await readJsonBody(req, 1024 * 1024) as {
      provider?: string;
    };
    if (!body.provider) {
      sendJson(res, 400, { error: "missing provider" });
      return true;
    }
    const { runtime } = await getModelServices();
    if (!runtime.getProvider(body.provider)) {
      sendJson(res, 404, { error: `provider not found: ${body.provider}` });
      return true;
    }
    try {
      await runtime.logout(body.provider, { signal: AbortSignal.timeout(15_000) });
      const remaining = await runtime.listCredentials({ signal: AbortSignal.timeout(15_000) });
      if (remaining.some((credential) => credential.providerId === body.provider))
        throw new Error(`provider credential still present after logout: ${body.provider}`);
      sendJson(res, 200, { ok: true });
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      console.error(`[auth] provider_logout_failed provider=${body.provider} error=${JSON.stringify(error)}`);
      sendJson(res, 502, { error });
    }
    return true;
  }

  // ---- workspace files -------------------------------------------------
  if (path === "/api/workspaces" && req.method === "GET") {
    const roots = await canonicalRoots(await knownWorkspaceRoots());
    sendJson(res, 200, { roots });
    return true;
  }

  if (path === "/api/files" && req.method === "GET") {
    const cwd = url.searchParams.get("cwd");
    const rel = url.searchParams.get("path") ?? ".";
    if (!cwd) {
      sendJson(res, 400, { error: "missing cwd" });
      return true;
    }
    const resolved = await resolveWorkspacePath(cwd, rel, {
      extraRoots: await knownWorkspaceRoots(),
    });
    const dir = resolved.path;
    const entries = await readdir(dir, { withFileTypes: true });
    const items = await Promise.all(
      entries.map(async (e) => {
        const st = await stat(join(dir, e.name)).catch(() => undefined);
        return {
          name: e.name,
          isDir: e.isDirectory(),
          size: st?.size ?? 0,
          modified: st?.mtime.toISOString(),
        };
      }),
    );
    items.sort(
      (a, b) =>
        Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name),
    );
    sendJson(res, 200, { cwd: resolved.base, path: rel, items });
    return true;
  }

  if (path === "/api/file" && req.method === "GET") {
    const cwd = url.searchParams.get("cwd");
    const rel = url.searchParams.get("path");
    if (!cwd || !rel) {
      sendJson(res, 400, { error: "missing cwd or path" });
      return true;
    }
    const file = await resolvePreviewFile(
      cwd,
      rel,
      url.searchParams.get("sessionId") ?? undefined,
    );
    const st = await stat(file);
    const ext = extname(file).toLowerCase();
    if (IMAGE_EXTS.has(ext)) {
      res.writeHead(200, {
        "Content-Type": MIME[ext] ?? "application/octet-stream",
      });
      createReadStream(file).pipe(res);
      return true;
    }
    if (st.size > 2 * 1024 * 1024) {
      sendJson(res, 413, { error: "file too large" });
      return true;
    }
    if (!TEXT_EXTS.has(ext)) {
      sendJson(res, 415, { error: "binary file, preview unsupported" });
      return true;
    }
    const content = await readFile(file, "utf-8");
    sendJson(res, 200, { name: file.split("/").pop(), path: rel, content });
    return true;
  }

  if (path === "/api/files/upload" && req.method === "POST") {
    const cwd = url.searchParams.get("cwd");
    const rel = url.searchParams.get("path");
    if (!cwd || !rel) {
      sendJson(res, 400, { error: "missing cwd or path" });
      return true;
    }
    const { path: file } = await resolveWorkspacePath(cwd, rel, {
      write: true,
      extraRoots: await knownWorkspaceRoots(),
    });
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, await readBody(req));
    sendJson(res, 200, { ok: true, path: rel });
    return true;
  }

  // ---- git -------------------------------------------------------------
  if (path === "/api/git" && req.method === "GET") {
    const cwd = url.searchParams.get("cwd");
    if (!cwd) {
      sendJson(res, 400, { error: "missing cwd" });
      return true;
    }
    try {
      const { base } = await resolveWorkspacePath(cwd, ".", {
        extraRoots: await knownWorkspaceRoots(),
      });
      const branch = (
        await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], base)
      ).trim();
      const status = await exec("git", ["status", "--porcelain"], base);
      const changes = status
        .split("\n")
        .filter(Boolean)
        .map((line) => ({
          status: line.slice(0, 2).trim(),
          path: line.slice(3),
        }));
      const statOut = await exec("git", ["diff", "--stat", "HEAD"], base).catch(
        () => "",
      );
      sendJson(res, 200, { branch, changes, diffStat: statOut });
    } catch (err) {
      sendJson(res, 200, {
        error: err instanceof Error ? err.message : "not a git repo",
      });
    }
    return true;
  }

  if (path === "/api/git/diff" && req.method === "GET") {
    const cwd = url.searchParams.get("cwd");
    const rel = url.searchParams.get("path");
    if (!cwd) {
      sendJson(res, 400, { error: "missing cwd" });
      return true;
    }
    const { base } = await resolveWorkspacePath(cwd, ".", {
      extraRoots: await knownWorkspaceRoots(),
    });
    const target = rel
      ? (
          await resolveWorkspacePath(cwd, rel, {
            extraRoots: await knownWorkspaceRoots(),
          })
        ).path
      : undefined;
    const args = target ? ["diff", "HEAD", "--", target] : ["diff", "HEAD"];
    const diff = await exec("git", args, base).catch(
      (err: Error) => `error: ${err.message}`,
    );
    sendJson(res, 200, { diff });
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Tunnel hub (agents dial in here; /api and /ws proxy to the connected agent)
// ---------------------------------------------------------------------------
const hub = new TunnelHub();

// ---------------------------------------------------------------------------
// HTTP + WS server
// ---------------------------------------------------------------------------
const server = createServer((req, res) => {
  void (async () => {
    try {
      const url0 = new URL(req.url ?? "/", "http://localhost");
      if (url0.pathname.startsWith("/api/") && !mutationRequestAllowed(req)) {
        sendJson(res, 403, { error: "cross-site state change rejected" });
        return;
      }
      // public assets (favicon etc.) must load even before login
      if (
        /^\/(favicon\.svg|favicon\.png|apple-touch-icon\.png|icon-512\.png|logo-wide\.png|logo-wide-dark\.png|logo-wide-light\.png|cat-square\.png|cat-mark-dark\.png|cat-mark-light\.png|manifest\.webmanifest)$/.test(
          url0.pathname,
        )
      ) {
        await serveStatic(req, res);
        return;
      }
      if (url0.pathname === "/login") {
        const next = safeNextPath(url0.searchParams.get("next"));
        if (!options.password || checkCookieAuth(req)) {
          res.writeHead(302, { Location: next });
          res.end();
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        res.end(loginPageHtml(url0.searchParams.get("error") === "1", next));
        return;
      }
      if (url0.pathname === "/api/auth/login" && req.method === "POST") {
        const body = await readJsonBody(req, 64 * 1024) as { password?: string };
        if (options.password && passwordOk(body.password ?? "")) {
          const token = randomBytes(24).toString("hex");
          sessions.add(token);
          const secure =
            req.headers["x-forwarded-proto"] === "https" ||
            Boolean((req.socket as { encrypted?: boolean }).encrypted);
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Set-Cookie": `pii_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${secure ? "; Secure" : ""}`,
          });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false }));
        }
        return;
      }
      if (url0.pathname === "/api/auth/logout" && req.method === "POST") {
        const token = parseCookies(req).pii_session;
        if (token) sessions.delete(token);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Set-Cookie": "pii_session=; Path=/; HttpOnly; Max-Age=0",
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (url0.pathname === "/api/auth/state") {
        sendJson(res, 200, {
          authRequired: Boolean(options.password),
          authenticated: checkAuth(req),
        });
        return;
      }
      if (!requireAuth(req, res)) return;
      const UI_ONLY_LOCAL = ["/api/health", "/api/agents", "/api/auth/state"];
      if (
        options.uiOnly &&
        req.url?.startsWith("/api/") &&
        !url0.searchParams.get("agent") &&
        !UI_ONLY_LOCAL.some(
          (p) => url0.pathname === p || url0.pathname.startsWith("/api/auth/"),
        )
      ) {
        sendJson(res, 501, {
          error: "ui-only mode: no local pi runtime — connect an agent",
        });
        return;
      }
      if (url0.pathname === "/api/agents") {
        sendJson(res, 200, {
          connected: hub.connected,
          agents: hub.agentNames(),
        });
        return;
      }
      const agentParam = url0.searchParams.get("agent");
      if (req.url?.startsWith("/api/") && agentParam) {
        const headers: Record<string, string> = {};
        if (req.headers["content-type"])
          headers["content-type"] = String(req.headers["content-type"]);
        url0.searchParams.delete("agent");
        const proxied = hub.proxyHttp(
          agentParam,
          req.method ?? "GET",
          `${url0.pathname}${url0.search}`,
          headers,
          req,
          res,
        );
        if (proxied) return;
        // Explicit agent requested but not connected — never fall back to
        // local or a different remote workspace.
        sendJson(res, 502, { error: `agent not connected: ${agentParam}` });
        return;
      }
      if (req.url?.startsWith("/api/")) {
        const handled = await handleApi(req, res);
        if (!handled) sendJson(res, 404, { error: "not found" });
        return;
      }
      await serveStatic(req, res);
    } catch (err) {
      if (!(err instanceof PreviewAuthorizationError)) console.error(err);
      if (res.headersSent) res.end();
      else {
        let status = 500;
        if (err instanceof InvalidJsonBodyError) status = 400;
        else if (err instanceof PreviewAuthorizationError) status = 403;
        sendJson(res, status, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  })();
});

server.once("close", disposeOAuthFlows);
process.once("exit", disposeOAuthFlows);

const wss = new WebSocketServer({ noServer: true });

/** Browsers must not open cross-site WebSockets to us (CSWSH). */
server.on("upgrade", (req, socket, head) => {
  if (!webSocketOriginAllowed(req)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  if (!checkAuth(req)) {
    const urlPath = new URL(req.url ?? "/", "http://localhost").pathname;
    const challenge =
      urlPath === "/tunnel" ? '\r\nWWW-Authenticate: Basic realm="pii"' : "";
    socket.write(`HTTP/1.1 401 Unauthorized${challenge}\r\n\r\n`);
    socket.destroy();
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/tunnel") {
    wss.handleUpgrade(req, socket, head, (ws) =>
      hub.handleAgentConnection(
        ws,
        url.searchParams.get("name") ?? "agent",
        url.searchParams.get("instanceId") ?? crypto.randomUUID(),
      ),
    );
    return;
  }
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  const selectedAgent = url.searchParams.get("agent");
  if (selectedAgent) {
    // Only an explicit immutable agent selection may proxy this conversation.
    url.searchParams.delete("agent");
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!hub.proxyWs(selectedAgent, ws, `${url.pathname}${url.search}`))
        ws.close(1001, `agent unavailable: ${selectedAgent}`);
    });
    return;
  }
  if (options.uiOnly) {
    socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) =>
    wss.emit("connection", ws, req, url),
  );
});

wss.on("connection", (ws: WebSocket, _req: IncomingMessage, url: URL) => {
  attachWebSocketHeartbeat(ws);
  const cwd = url.searchParams.get("cwd");
  const sessionPath = url.searchParams.get("session") ?? undefined;
  if (!cwd) {
    ws.close(4000, "missing cwd");
    return;
  }

  let host: SessionHost | undefined;
  const waitingCommands: (ClientCommand & { id?: string })[] = [];
  let drainingInitialization = true;

  const sendCommandResult = (
    id: string | undefined,
    result: { ok: boolean; error?: string; data?: Record<string, unknown> },
  ): void => {
    const reply: ServerMessage = { type: "command_result", id, ...result };
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(reply));
  };
  const processCommand = async (
    cmd: ClientCommand & { id?: string },
  ): Promise<void> => {
    if (!host) {
      sendCommandResult(cmd.id, { ok: false, error: "session is not ready" });
      return;
    }
    const { id, ...command } = cmd;
    try {
      if (command.type === "history") {
        host.sendHistory(ws, command.before, command.requestId);
        sendCommandResult(id, { ok: true });
        return;
      }
      sendCommandResult(id, await host.handleOrdered(command as ClientCommand));
    } catch (cause) {
      sendCommandResult(id, {
        ok: false,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };
  const drainInitialization = async (): Promise<void> => {
    while (waitingCommands.length > 0) {
      const command = waitingCommands.shift();
      if (command) await processCommand(command);
    }
    drainingInitialization = false;
  };

  acquireHost(cwd, sessionPath)
    .then((h) => {
      h.attach(ws); // snapshot is always the first host message
      host = h;
      void drainInitialization();
      if (ws.readyState !== ws.OPEN) h.detach(ws);
    })
    .catch((err) => {
      const error = `failed to open session: ${err instanceof Error ? err.message : String(err)}`;
      for (const command of waitingCommands.splice(0))
        sendCommandResult(command.id, { ok: false, error });
      sendCommandResult(undefined, { ok: false, error });
      ws.close(1011, "session open failed");
    });

  ws.on("message", (data) => {
    let cmd: ClientCommand & { id?: string };
    try {
      cmd = JSON.parse(String(data));
    } catch {
      sendCommandResult(undefined, { ok: false, error: "invalid command JSON" });
      return;
    }
    const mayBypassInitializationDrain =
      cmd.type === "abort" ||
      cmd.type === "ui_response" ||
      cmd.type === "custom_ui_input" ||
      cmd.type === "custom_ui_resize" ||
      cmd.type === "custom_ui_cancel" ||
      cmd.type === "steer" ||
      cmd.type === "followUp" ||
      cmd.type === "queue_clear";
    if (host && (mayBypassInitializationDrain || !drainingInitialization)) {
      void processCommand(cmd);
    } else if (waitingCommands.length < 100) waitingCommands.push(cmd);
    else sendCommandResult(cmd.id, { ok: false, error: "session initialization queue is full" });
  });

  ws.on("close", () => {
    host?.detach(ws);
  });
});

let tunnelAgent: TunnelAgentHandle | undefined;
let shutdownPromise: Promise<void> | undefined;

function gracefulShutdown(exitCode: number, reason: string): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    console.error(`[shutdown] started reason=${reason} exitCode=${exitCode}`);
    const forceExit = setTimeout(() => {
      console.error(`[shutdown] forced reason=${reason}`);
      process.exit(exitCode);
    }, 10_000);

    const serverClosed = new Promise<void>((resolvePromise) => {
      if (!server.listening) {
        resolvePromise();
        return;
      }
      server.close(() => resolvePromise());
    });
    hub.dispose();
    await tunnelAgent?.dispose();
    tunnelAgent = undefined;
    for (const ws of wss.clients) {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING)
        ws.close(1001, "server shutting down");
    }
    const terminateTimer = setTimeout(() => {
      for (const ws of wss.clients) {
        if (ws.readyState !== ws.CLOSED) ws.terminate();
      }
      server.closeAllConnections();
    }, 500);
    terminateTimer.unref();

    const pendingHosts = await Promise.allSettled([...hostCreations.values()]);
    const allHosts = new Set(hosts.values());
    for (const result of pendingHosts) {
      if (result.status === "fulfilled") allHosts.add(result.value);
    }
    hosts.clear();
    hostCreations.clear();
    disposeOAuthFlows();
    await Promise.allSettled([...allHosts].map((host) => host.dispose()));
    await Promise.race([
      serverClosed,
      new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 2_000)),
    ]);
    clearTimeout(forceExit);
    console.error(`[shutdown] completed reason=${reason} exitCode=${exitCode}`);
    process.exit(exitCode);
  })();
  return shutdownPromise;
}

process.on("unhandledRejection", (cause) => {
  console.error("[fatal] unhandledRejection", cause);
  void gracefulShutdown(1, "unhandledRejection");
});
process.on("uncaughtException", (cause) => {
  console.error("[fatal] uncaughtException", cause);
  void gracefulShutdown(1, "uncaughtException");
});
process.on("SIGTERM", () => void gracefulShutdown(0, "SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown(0, "SIGINT"));

server.listen(options.port, options.host, () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : options.port;
  if (options.agent) {
    console.log(
      `pii agent local server on 127.0.0.1:${port}, dialing hub ${options.agent}…`,
    );
    tunnelAgent = runTunnelAgent({
      hubUrl: options.agent,
      token: options.agentToken,
      localPort: port,
      name: options.agentName ?? process.env.HOSTNAME,
      instanceId: process.env.PII_AGENT_INSTANCE_ID,
    });
    return;
  }
  console.log(
    `MewPii listening on http://${options.host}:${port}${options.uiOnly ? " (ui-only mode)" : ""}`,
  );
  if (!options.password)
    console.log("Warning: no password set (loopback-only mode).");
});
