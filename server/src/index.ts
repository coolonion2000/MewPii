import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, readdir, stat, unlink, writeFile, mkdir } from 'node:fs/promises';
import { createReadStream, existsSync, readdirSync, watch } from 'node:fs';
import { execFile } from 'node:child_process';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { DefaultPackageManager, ModelRegistry, ModelRuntime, SessionManager, SettingsManager, createAgentSessionServices, getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ClientCommand, ProjectGroup, ServerMessage } from './protocol.js';
import { SessionHost } from './session-host.js';
import { TunnelHub, runTunnelAgent } from './tunnel.js';
import { loginPageHtml } from './login-page.js';

// ---------------------------------------------------------------------------
// CLI options
// ---------------------------------------------------------------------------
interface ServerOptions {
  host: string;
  port: number;
  password?: string;
  /** Tunnel mode: URL of the hub (NAS) to dial out to, e.g. ws://nas:31041/tunnel */
  agent?: string;
  agentName?: string;
  agentToken?: string;
}

function parseOptions(argv: string[]): ServerOptions {
  const opts: ServerOptions = {
    host: process.env.PII_HOST ?? '127.0.0.1',
    port: Number(process.env.PII_PORT ?? process.env.PORT ?? 31041),
    password: process.env.PII_PASSWORD,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--host' || arg === '-H') opts.host = next();
    else if (arg === '--port' || arg === '-p') opts.port = Number(next());
    else if (arg === '--password') opts.password = next();
    else if (arg === '--agent') opts.agent = next();
    else if (arg === '--name') opts.agentName = next();
    else if (arg === '--token') opts.agentToken = next();
    else if (arg === '--help' || arg === '-h') {
      console.log(`pii web — dsh-styled web UI for the pi coding agent

Usage: pii-web [options]

Options:
  --host, -H <host>        Listen host (default 127.0.0.1, env PII_HOST)
  --port, -p <port>        Listen port (default 31041, env PII_PORT)
  --password <password>    Basic Auth password, user "pi" (env PII_PASSWORD)
  --agent <url>            Tunnel mode: dial out to a pii hub, e.g. ws://nas:31041/tunnel
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
options.agentToken = options.agentToken ?? process.env.PII_AGENT_TOKEN ?? options.password;
if (options.agent) {
  // Tunnel (agent) mode: serve locally on an ephemeral loopback port and pipe
  // all traffic through the outbound tunnel connection.
  options.host = '127.0.0.1';
  options.port = 0;
  options.password = undefined;
}

// A long-running server must never die from a stray rejection (e.g. an SDK
// edge case); log it and keep serving.
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
const isLoopback = options.host === '127.0.0.1' || options.host === 'localhost' || options.host === '::1';
if (!isLoopback && !options.password) {
  console.error('Refusing to listen on a non-loopback host without a password. Set --password or PII_PASSWORD.');
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
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  }
  return out;
}

function passwordOk(candidate: string): boolean {
  const expected = options.password ?? '';
  if (candidate.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < candidate.length; i++) diff |= candidate.charCodeAt(i) ^ expected.charCodeAt(i);
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
  if (!header?.startsWith('Basic ')) return false;
  const [user, pass] = Buffer.from(header.slice(6), 'base64').toString().split(':', 2);
  return user === 'pi' && passwordOk(pass ?? '');
}

function requireAuth(req: IncomingMessage, res: ServerResponse): boolean {
  const url = req.url ?? '/';
  const isApi = url.startsWith('/api/') || url === '/ws' || url === '/tunnel';
  if (isApi) {
    if (checkAuth(req)) return true;
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="pii", charset="UTF-8"' });
    res.end('Authentication required');
    return false;
  }
  // browser page views must have a cookie session — cached Basic credentials
  // (which users cannot clear from the client) must not bypass the login page,
  // otherwise logout can never take effect.
  if (checkCookieAuth(req)) return true;
  if (req.method === 'GET' || req.method === 'HEAD') {
    const next = encodeURIComponent(url);
    res.writeHead(302, { Location: `/login?next=${next}` });
    res.end();
    return false;
  }
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'authentication required' }));
  return false;
}

// ---------------------------------------------------------------------------
// Session hosts (one per conversation, shared across browsers)
// ---------------------------------------------------------------------------
const hosts = new Map<string, SessionHost>();

async function acquireHost(cwd: string, sessionPath?: string): Promise<SessionHost> {
  // Unify by live session file: a host created for a "new" session already
  // drives that file once the first prompt lands, so attaching by path must
  // find it instead of opening a second, diverging runtime over the same file.
  if (sessionPath) {
    for (const h of hosts.values()) {
      if (h.session.sessionFile === sessionPath) return h;
    }
  }
  const key = sessionPath ? `file:${sessionPath}` : `new:${cwd}:${crypto.randomUUID()}`;
  const host = await SessionHost.create(key, {
    cwd,
    sessionPath,
    onEmpty: (h) => {
      if (hosts.get(h.key) === h) hosts.delete(h.key);
    },
  });
  hosts.set(key, host);
  return host;
}

// ---------------------------------------------------------------------------
// Shared model runtime for /api/models
// ---------------------------------------------------------------------------
interface ModelServices {
  runtime: ModelRuntime;
  registry: ModelRegistry;
}
let modelServices: ModelServices | undefined;
async function getModelServices(): Promise<ModelServices> {
  if (!modelServices) {
    const runtime = await ModelRuntime.create();
    const registry = new ModelRegistry(runtime);
    await registry.refresh().catch(() => undefined);
    modelServices = { runtime, registry };
  }
  return modelServices;
}

// ---------------------------------------------------------------------------
// OAuth login flows (bridged to the browser over REST)
// ---------------------------------------------------------------------------
interface OAuthFlow {
  events: { type: string; message?: string; url?: string; userCode?: string; verificationUri?: string; instructions?: string }[];
  pendingPrompt?: { message: string; placeholder?: string; inputType: string; resolve: (value: string) => void };
  done: boolean;
  error?: string;
}
const oauthFlows = new Map<string, OAuthFlow>();

// ---------------------------------------------------------------------------
// sessions dir watcher: CLI-side changes bump a version the UI polls
// ---------------------------------------------------------------------------
let sessionsVersion = 0;
{
  const sessionsDir = join(getAgentDir(), 'sessions');
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
const STATE_PATH = join(getAgentDir(), 'pii-web-state.json');

interface PiiState {
  archived: string[];
  favorites: string[];
  projectOrder: string[];
}

async function readState(): Promise<PiiState> {
  try {
    const doc = JSON.parse(await readFile(STATE_PATH, 'utf-8')) as Partial<PiiState>;
    return {
      archived: Array.isArray(doc.archived) ? doc.archived : [],
      favorites: Array.isArray(doc.favorites) ? doc.favorites : [],
      projectOrder: Array.isArray(doc.projectOrder) ? doc.projectOrder : [],
    };
  } catch {
    return { archived: [], favorites: [], projectOrder: [] };
  }
}

async function writeState(state: PiiState): Promise<void> {
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function readBody(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function exec(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolvePromise(stdout);
    });
  });
}

/** Resolve `target` inside `cwd`; throws when it escapes. */
function jail(cwd: string, target: string): string {
  const base = resolve(cwd);
  const full = resolve(base, target);
  if (full !== base && !full.startsWith(base + '/')) throw new Error('path escapes workspace');
  return full;
}

const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.css', '.scss', '.less', '.html', '.xml', '.svg', '.yml', '.yaml', '.toml', '.ini', '.cfg',
  '.py', '.rb', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.sh', '.bash', '.zsh',
  '.sql', '.vue', '.svelte', '.env', '.gitignore', '.lock', '.log', '.csv', '.swift', '.kt', '.lua',
]);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp']);
function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

/** Minimal glob matcher: supports * and ** against forward-slash paths. */
function globMatch(pattern: string, path: string): boolean {
  const p = pattern.split('/').map((seg) =>
    seg === '**' ? '(?:[^/]+/)*' : seg.split('').map((c) => (c === '*' ? '[^/]*' : c.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))).join(''),
  );
  const re = new RegExp(`^${p.join('/')}$`);
  return re.test(path) || re.test(path.replace(/\\/g, '/'));
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

const WEB_DIST = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../web/dist');

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const file = normalize(join(WEB_DIST, pathname));
  if (!file.startsWith(WEB_DIST) || !existsSync(file) || !(await stat(file)).isFile()) {
    // SPA fallback
    const index = join(WEB_DIST, 'index.html');
    if (existsSync(index)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(await readFile(index));
      return;
    }
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------
async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (path === '/api/health') {
    sendJson(res, 200, { ok: true, name: 'pii-web' });
    return true;
  }

  if (path === '/api/sessions/resolve' && req.method === 'GET') {
    const id = url.searchParams.get('id');
    if (!id) {
      sendJson(res, 400, { error: 'missing id' });
      return true;
    }
    const all = await SessionManager.listAll();
    const match = all.find((s) => s.id === id || s.id.startsWith(id) || id.startsWith(s.id));
    if (!match) {
      sendJson(res, 404, { error: 'session not found' });
      return true;
    }
    sendJson(res, 200, { cwd: match.cwd, path: match.path, id: match.id });
    return true;
  }

  if (path === '/api/sessions/version' && req.method === 'GET') {
    sendJson(res, 200, { version: sessionsVersion });
    return true;
  }

  if (path === '/api/sessions' && req.method === 'GET') {
    const includeArchived = url.searchParams.get('includeArchived') === '1';
    const running = new Set(
      [...hosts.values()].filter((h) => h.isRunning).map((h) => h.session.sessionFile).filter(Boolean) as string[],
    );
    const state = await readState();
    const archivedSet = new Set(state.archived);
    const all = await SessionManager.listAll();
    const byCwd = new Map<string, ProjectGroup>();
    for (const s of all) {
      if (!includeArchived && archivedSet.has(s.path)) continue;
      const cwd = s.cwd || '(unknown)';
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
    for (const g of groups) g.sessions.sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));
    sendJson(res, 200, { projects: groups });
    return true;
  }

  if (path === '/api/sessions/archive' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req, 1024 * 1024)).toString()) as { path?: string; archived?: boolean };
    if (!body.path) {
      sendJson(res, 400, { error: 'missing path' });
      return true;
    }
    const state = await readState();
    const set = new Set(state.archived);
    if (body.archived) set.add(body.path);
    else set.delete(body.path);
    await writeState({ ...state, archived: [...set] });
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (path === '/api/sessions/rename' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req, 1024 * 1024)).toString()) as { path?: string; name?: string };
    if (!body.path || typeof body.name !== 'string') {
      sendJson(res, 400, { error: 'missing path or name' });
      return true;
    }
    // A live host renames through the SDK; otherwise append a session_info
    // entry to the session file directly (pi's own persistence format).
    const liveHost = [...hosts.values()].find((h) => h.session.sessionFile === body.path);
    if (liveHost) {
      liveHost.session.setSessionName(body.name);
    } else {
      const content = (await readFile(body.path, 'utf-8')).split('\n').filter(Boolean);
      if (content.length === 0) {
        sendJson(res, 400, { error: 'empty session file' });
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
        type: 'session_info',
        id: crypto.randomUUID().slice(0, 8),
        parentId,
        timestamp: new Date().toISOString(),
        name: body.name,
      };
      content.push(JSON.stringify(entry));
      await writeFile(body.path, content.join('\n') + '\n');
    }
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (path === '/api/state' && req.method === 'GET') {
    const state = await readState();
    sendJson(res, 200, { favorites: state.favorites, projectOrder: state.projectOrder });
    return true;
  }

  if (path === '/api/state' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req, 1024 * 1024)).toString()) as { favorites?: string[]; projectOrder?: string[] };
    const state = await readState();
    if (Array.isArray(body.favorites)) state.favorites = body.favorites.filter((x) => typeof x === 'string');
    if (Array.isArray(body.projectOrder)) state.projectOrder = body.projectOrder.filter((x) => typeof x === 'string');
    await writeState(state);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (path === '/api/sessions/archive' && req.method === 'GET') {
    const state = await readState();
    sendJson(res, 200, { archived: state.archived });
    return true;
  }

  if (path === '/api/sessions' && req.method === 'DELETE') {
    const sessionPath = url.searchParams.get('path');
    if (!sessionPath) {
      sendJson(res, 400, { error: 'missing path' });
      return true;
    }
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

  if (path === '/api/models' && req.method === 'GET') {
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
      input: m.input ?? ['text'],
      contextWindow: m.contextWindow,
      hasAuth: registry.hasConfiguredAuth(m),
    }));
    sendJson(res, 200, { providers, models });
    return true;
  }

  // ---- custom providers (~/.pi/agent/models.json) ----------------------
  if (path === '/api/providers' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req, 4 * 1024 * 1024)).toString()) as {
      id?: string;
      name?: string;
      baseUrl?: string;
      api?: string;
      apiKey?: string;
      models?: Record<string, unknown>[];
    };
    if (!body.id || !body.baseUrl || !body.api || !Array.isArray(body.models) || body.models.length === 0) {
      sendJson(res, 400, { error: 'required: id, baseUrl, api, models[]' });
      return true;
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(body.id)) {
      sendJson(res, 400, { error: 'id must be lowercase letters/digits/dashes' });
      return true;
    }
    const modelsPath = join(getAgentDir(), 'models.json');
    const doc = existsSync(modelsPath)
      ? (JSON.parse(await readFile(modelsPath, 'utf-8')) as Record<string, unknown>)
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
    await writeFile(modelsPath, JSON.stringify(doc, null, 2) + '\n');
    // Recreate the shared model runtime so the new provider shows up.
    modelServices = undefined;
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (path === '/api/providers' && req.method === 'DELETE') {
    const id = url.searchParams.get('id');
    if (!id) {
      sendJson(res, 400, { error: 'missing id' });
      return true;
    }
    const modelsPath = join(getAgentDir(), 'models.json');
    const doc = existsSync(modelsPath)
      ? (JSON.parse(await readFile(modelsPath, 'utf-8')) as Record<string, unknown>)
      : {};
    const providers = (doc.providers ?? {}) as Record<string, unknown>;
    if (!(id in providers)) {
      sendJson(res, 404, { error: 'not a custom (models.json) provider' });
      return true;
    }
    delete providers[id];
    doc.providers = providers;
    await writeFile(modelsPath, JSON.stringify(doc, null, 2) + '\n');
    modelServices = undefined;
    sendJson(res, 200, { ok: true });
    return true;
  }

  // ---- skills add / delete ----------------------------------------------
  if (path === '/api/skills' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req, 4 * 1024 * 1024)).toString()) as {
      name?: string;
      description?: string;
      content?: string;
    };
    if (!body.name || !/^[a-z0-9][a-z0-9-]*$/.test(body.name)) {
      sendJson(res, 400, { error: 'name must be lowercase letters/digits/dashes' });
      return true;
    }
    const home = process.env.HOME ?? '';
    const dir = join(home, '.agents', 'skills', body.name);
    await mkdir(dir, { recursive: true });
    const front = `---\nname: ${body.name}\ndescription: ${(body.description ?? '').replace(/\n/g, ' ')}\n---\n\n`;
    await writeFile(join(dir, 'SKILL.md'), front + (body.content ?? ''));
    sendJson(res, 200, { ok: true, path: join(dir, 'SKILL.md') });
    return true;
  }

  if (path === '/api/skills' && req.method === 'DELETE') {
    const filePath = url.searchParams.get('path');
    if (!filePath) {
      sendJson(res, 400, { error: 'missing path' });
      return true;
    }
    const home = process.env.HOME ?? '';
    const allowedRoots = [join(home, '.agents', 'skills'), join(getAgentDir(), 'skills')];
    const dir = dirname(normalize(filePath));
    if (!allowedRoots.some((root) => dir.startsWith(root + '/') || dir === root)) {
      sendJson(res, 403, { error: 'only user-scope skill directories can be removed' });
      return true;
    }
    const { rm } = await import('node:fs/promises');
    await rm(dir, { recursive: true, force: true });
    sendJson(res, 200, { ok: true });
    return true;
  }

  // ---- package enable / disable (pi config semantics) -------------------
  if (path === '/api/packages/config' && req.method === 'GET') {
    const cwd = url.searchParams.get('cwd') ?? process.cwd();
    const sm = SettingsManager.create(cwd, getAgentDir());
    const pm = new DefaultPackageManager({ cwd, agentDir: getAgentDir(), settingsManager: sm });
    const settingsPkgs = sm.getGlobalSettings().packages ?? [];
    const projPkgs = sm.getProjectSettings().packages ?? [];
    const configured = pm.listConfiguredPackages();

    const KINDS = ['skills', 'extensions', 'prompts', 'themes'] as const;
    const result = configured.map((pkg) => {
      const entry = (pkg.scope === 'project' ? projPkgs : settingsPkgs).find((p) =>
        (typeof p === 'string' ? p : p.source) === pkg.source,
      );
      const obj = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : undefined;
      const autoloadDisabled = obj?.autoload === false;
      const filters = obj as { skills?: string[]; extensions?: string[]; prompts?: string[]; themes?: string[] } | undefined;

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
              else files.push({ path: full.slice(root.length + 1), enabled: true });
            }
          };
          walk(kindDir);
        }
        const patterns = filters?.[kind];
        for (const f of files) {
          if (autoloadDisabled) {
            // with autoload=false the patterns act as a re-enable list
            f.enabled = patterns ? patterns.some((p) => globMatch(p, f.path)) : false;
          } else if (patterns !== undefined) {
            f.enabled = patterns.some((p) => globMatch(p, f.path));
          } else {
            f.enabled = true;
          }
        }
        contents[kind] = files;
      }
      return { source: pkg.source, scope: pkg.scope, installedPath: pkg.installedPath, enabled: !autoloadDisabled, filters: filters ?? {}, contents };
    });
    sendJson(res, 200, { packages: result });
    return true;
  }

  if (path === '/api/packages/config' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req, 2 * 1024 * 1024)).toString()) as {
      source: string;
      scope?: 'user' | 'project';
      enabled?: boolean;
      toggleKind?: 'skills' | 'extensions' | 'prompts' | 'themes';
      togglePath?: string;
      toggleEnabled?: boolean;
      contents?: Record<string, { path: string; enabled: boolean }[]>;
    };
    if (!body.source) {
      sendJson(res, 400, { error: 'missing source' });
      return true;
    }
    const cwd = url.searchParams.get('cwd') ?? process.cwd();
    const sm = SettingsManager.create(cwd, getAgentDir());
    const isProject = body.scope === 'project';
    const list = [...((isProject ? sm.getProjectSettings().packages : sm.getGlobalSettings().packages) ?? [])];
    const idx = list.findIndex((p) => (typeof p === 'string' ? p : p.source) === body.source);
    if (idx === -1) {
      sendJson(res, 404, { error: 'package not configured' });
      return true;
    }
    const prev = list[idx];
    const obj: Record<string, unknown> = typeof prev === 'object' && prev !== null ? { ...prev } : { source: body.source };

    if (body.enabled !== undefined) {
      obj.autoload = body.enabled ? undefined : false;
      if (obj.autoload === undefined) delete obj.autoload;
    }

    if (body.toggleKind && body.togglePath) {
      const kind = body.toggleKind;
      const all = (body.contents?.[kind] ?? []).map((f) => f.path);
      const current: string[] | undefined = Array.isArray(obj[kind]) ? [...(obj[kind] as string[])] : undefined;
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
          if (!body.toggleEnabled) {
            // that's the new allowlist
            obj[kind] = [...set];
          } else {
            // enabling with no filter is a no-op
            delete obj[kind];
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

    list[idx] = obj as never;
    if (isProject) sm.setProjectPackages(list);
    else sm.setPackages(list);
    sendJson(res, 200, { ok: true });
    return true;
  }

  // ---- settings (global pi settings) ----------------------------------
  if (path === '/api/settings' && req.method === 'GET') {
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

  if (path === '/api/settings' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req, 1024 * 1024)).toString()) as Record<string, unknown>;
    const sm = SettingsManager.create(process.cwd(), getAgentDir());
    if (typeof body.defaultProvider === 'string' && typeof body.defaultModel === 'string') {
      sm.setDefaultModelAndProvider(body.defaultProvider, body.defaultModel);
    } else if (typeof body.defaultProvider === 'string') {
      sm.setDefaultProvider(body.defaultProvider);
    } else if (typeof body.defaultModel === 'string') {
      sm.setDefaultModel(body.defaultModel);
    }
    if (typeof body.defaultThinkingLevel === 'string') sm.setDefaultThinkingLevel(body.defaultThinkingLevel as never);
    if (body.steeringMode === 'all' || body.steeringMode === 'one-at-a-time') sm.setSteeringMode(body.steeringMode);
    if (body.followUpMode === 'all' || body.followUpMode === 'one-at-a-time') sm.setFollowUpMode(body.followUpMode);
    if (typeof body.compactionEnabled === 'boolean') sm.setCompactionEnabled(body.compactionEnabled);
    if (typeof body.hideThinkingBlock === 'boolean') sm.setHideThinkingBlock(body.hideThinkingBlock);
    sendJson(res, 200, { ok: true });
    return true;
  }

  // ---- extensions (pi packages) ----------------------------------------
  if (path === '/api/extensions' && req.method === 'GET') {
    const cwd = url.searchParams.get('cwd') ?? process.cwd();
    const pm = new DefaultPackageManager({
      cwd,
      agentDir: getAgentDir(),
      settingsManager: SettingsManager.create(cwd, getAgentDir()),
    });
    sendJson(res, 200, { packages: pm.listConfiguredPackages() });
    return true;
  }

  if (path === '/api/extensions' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req, 1024 * 1024)).toString()) as { source?: string; cwd?: string };
    if (!body.source) {
      sendJson(res, 400, { error: 'missing source' });
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

  if (path === '/api/extensions' && req.method === 'DELETE') {
    const source = url.searchParams.get('source');
    const cwd = url.searchParams.get('cwd') ?? process.cwd();
    if (!source) {
      sendJson(res, 400, { error: 'missing source' });
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
  if (path === '/api/auth/oauth/start' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req, 1024 * 1024)).toString()) as { provider?: string };
    if (!body.provider) {
      sendJson(res, 400, { error: 'missing provider' });
      return true;
    }
    const { runtime } = await getModelServices();
    const provider = runtime.getProvider(body.provider);
    if (!provider?.auth.oauth) {
      sendJson(res, 400, { error: `provider ${body.provider} has no OAuth flow` });
      return true;
    }
    const id = crypto.randomUUID();
    const flow: OAuthFlow = { events: [], done: false };
    oauthFlows.set(id, flow);
    void runtime
      .login(body.provider, 'oauth', {
        notify: (ev) => {
          flow.events.push(ev as OAuthFlow['events'][number]);
        },
        prompt: (p) =>
          new Promise<string>((resolvePrompt, rejectPrompt) => {
            flow.pendingPrompt = {
              message: p.message,
              placeholder: 'placeholder' in p ? p.placeholder : undefined,
              inputType: p.type,
              resolve: (value: string) => {
                flow.pendingPrompt = undefined;
                resolvePrompt(value);
              },
            };
            p.signal?.addEventListener('abort', () => {
              flow.pendingPrompt = undefined;
              rejectPrompt(new Error('cancelled'));
            });
          }),
      })
      .then(() => {
        flow.done = true;
      })
      .catch((err) => {
        flow.done = true;
        flow.error = err instanceof Error ? err.message : String(err);
      });
    sendJson(res, 200, { id });
    return true;
  }

  if (path === '/api/auth/oauth/status' && req.method === 'GET') {
    const id = url.searchParams.get('id');
    const flow = id ? oauthFlows.get(id) : undefined;
    if (!flow) {
      sendJson(res, 404, { error: 'unknown flow' });
      return true;
    }
    sendJson(res, 200, {
      events: flow.events,
      pendingPrompt: flow.pendingPrompt
        ? { message: flow.pendingPrompt.message, placeholder: flow.pendingPrompt.placeholder, inputType: flow.pendingPrompt.inputType }
        : undefined,
      done: flow.done,
      error: flow.error,
    });
    if (flow.done) oauthFlows.delete(id!);
    return true;
  }

  if (path === '/api/auth/oauth/answer' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req, 1024 * 1024)).toString()) as { id?: string; value?: string };
    const flow = body.id ? oauthFlows.get(body.id) : undefined;
    if (!flow?.pendingPrompt) {
      sendJson(res, 400, { error: 'no pending prompt' });
      return true;
    }
    flow.pendingPrompt.resolve(body.value ?? '');
    sendJson(res, 200, { ok: true });
    return true;
  }

  // ---- resources: skills / extensions / prompts for a cwd ------------
  if (path === '/api/resources' && req.method === 'GET') {
    const cwd = url.searchParams.get('cwd');
    if (!cwd) {
      sendJson(res, 400, { error: 'missing cwd' });
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
  if (path === '/api/sessions/import' && req.method === 'POST') {
    const body = await readBody(req, 64 * 1024 * 1024);
    const lines = body.toString('utf-8').split('\n').filter(Boolean);
    if (lines.length === 0) {
      sendJson(res, 400, { error: 'empty file' });
      return true;
    }
    let header: { type?: string; cwd?: string };
    try {
      header = JSON.parse(lines[0]);
    } catch {
      sendJson(res, 400, { error: 'invalid JSONL' });
      return true;
    }
    if (header.type !== 'session' || !header.cwd) {
      sendJson(res, 400, { error: 'not a pi session file' });
      return true;
    }
    const importsDir = join(getAgentDir(), 'imports');
    await mkdir(importsDir, { recursive: true });
    const tmpPath = join(importsDir, `import-${Date.now()}.jsonl`);
    await writeFile(tmpPath, body);
    const host = await acquireHost(header.cwd);
    const result = await host.runtime_import(tmpPath);
    if (!result.ok) {
      sendJson(res, 400, { error: result.error ?? 'import failed' });
      return true;
    }
    sendJson(res, 200, { ok: true, cwd: header.cwd, sessionFile: result.sessionFile });
    return true;
  }

  // ---- auth: API key login / logout ----------------------------------
  if (path === '/api/auth/key' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req, 1024 * 1024)).toString()) as { provider?: string; key?: string };
    if (!body.provider || !body.key) {
      sendJson(res, 400, { error: 'missing provider or key' });
      return true;
    }
    const { runtime } = await getModelServices();
    const provider = runtime.getProvider(body.provider);
    if (!provider) {
      sendJson(res, 404, { error: `unknown provider: ${body.provider}` });
      return true;
    }
    try {
      await runtime.login(body.provider, 'api_key', {
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

  if (path === '/api/auth/logout' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req, 1024 * 1024)).toString()) as { provider?: string };
    if (!body.provider) {
      sendJson(res, 400, { error: 'missing provider' });
      return true;
    }
    const { runtime } = await getModelServices();
    await runtime.logout(body.provider).catch(() => undefined);
    sendJson(res, 200, { ok: true });
    return true;
  }

  // ---- workspace files -------------------------------------------------
  if (path === '/api/files' && req.method === 'GET') {
    const cwd = url.searchParams.get('cwd');
    const rel = url.searchParams.get('path') ?? '.';
    if (!cwd) {
      sendJson(res, 400, { error: 'missing cwd' });
      return true;
    }
    // read-only listing: absolute paths are allowed (agent reads beyond cwd too)
    const dir = resolve(cwd, rel);
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
    items.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    sendJson(res, 200, { cwd: resolve(cwd), path: rel, items });
    return true;
  }

  if (path === '/api/file' && req.method === 'GET') {
    const cwd = url.searchParams.get('cwd');
    const rel = url.searchParams.get('path');
    if (!cwd || !rel) {
      sendJson(res, 400, { error: 'missing cwd or path' });
      return true;
    }
    // read-only preview: absolute paths are allowed
    const file = resolve(cwd, rel);
    const st = await stat(file);
    const ext = extname(file).toLowerCase();
    if (IMAGE_EXTS.has(ext)) {
      res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
      createReadStream(file).pipe(res);
      return true;
    }
    if (st.size > 2 * 1024 * 1024) {
      sendJson(res, 413, { error: 'file too large' });
      return true;
    }
    if (!TEXT_EXTS.has(ext)) {
      sendJson(res, 415, { error: 'binary file, preview unsupported' });
      return true;
    }
    const content = await readFile(file, 'utf-8');
    sendJson(res, 200, { name: file.split('/').pop(), path: rel, content });
    return true;
  }

  if (path === '/api/files/upload' && req.method === 'POST') {
    const cwd = url.searchParams.get('cwd');
    const rel = url.searchParams.get('path');
    if (!cwd || !rel) {
      sendJson(res, 400, { error: 'missing cwd or path' });
      return true;
    }
    const file = jail(cwd, rel);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, await readBody(req));
    sendJson(res, 200, { ok: true, path: rel });
    return true;
  }

  // ---- git -------------------------------------------------------------
  if (path === '/api/git' && req.method === 'GET') {
    const cwd = url.searchParams.get('cwd');
    if (!cwd) {
      sendJson(res, 400, { error: 'missing cwd' });
      return true;
    }
    try {
      const branch = (await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).trim();
      const status = await exec('git', ['status', '--porcelain'], cwd);
      const changes = status
        .split('\n')
        .filter(Boolean)
        .map((line) => ({ status: line.slice(0, 2).trim(), path: line.slice(3) }));
      const statOut = await exec('git', ['diff', '--stat', 'HEAD'], cwd).catch(() => '');
      sendJson(res, 200, { branch, changes, diffStat: statOut });
    } catch (err) {
      sendJson(res, 200, { error: err instanceof Error ? err.message : 'not a git repo' });
    }
    return true;
  }

  if (path === '/api/git/diff' && req.method === 'GET') {
    const cwd = url.searchParams.get('cwd');
    const rel = url.searchParams.get('path');
    if (!cwd) {
      sendJson(res, 400, { error: 'missing cwd' });
      return true;
    }
    const args = rel ? ['diff', 'HEAD', '--', jail(cwd, rel)] : ['diff', 'HEAD'];
    const diff = await exec('git', args, cwd).catch((err: Error) => `error: ${err.message}`);
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
      const url0 = new URL(req.url ?? '/', 'http://localhost');
      // public assets (favicon etc.) must load even before login
      if (/^\/(favicon\.svg|apple-touch-icon\.png|icon-512\.png|manifest\.webmanifest)$/.test(url0.pathname)) {
        await serveStatic(req, res);
        return;
      }
      if (url0.pathname === '/login') {
        if (!options.password || checkCookieAuth(req)) {
          const next = url0.searchParams.get('next') || '/';
          res.writeHead(302, { Location: next });
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(loginPageHtml(url0.searchParams.get('error') === '1'));
        return;
      }
      if (url0.pathname === '/api/auth/login' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req, 64 * 1024)).toString()) as { password?: string };
        if (options.password && passwordOk(body.password ?? '')) {
          const token = randomBytes(24).toString('hex');
          sessions.add(token);
          const secure = req.headers['x-forwarded-proto'] === 'https' || Boolean((req.socket as { encrypted?: boolean }).encrypted);
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': `pii_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${secure ? '; Secure' : ''}`,
          });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false }));
        }
        return;
      }
      if (url0.pathname === '/api/auth/logout' && req.method === 'POST') {
        const token = parseCookies(req).pii_session;
        if (token) sessions.delete(token);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'pii_session=; Path=/; HttpOnly; Max-Age=0' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (url0.pathname === '/api/auth/state') {
        sendJson(res, 200, { authRequired: Boolean(options.password), authenticated: checkAuth(req) });
        return;
      }
      if (!requireAuth(req, res)) return;
      if (req.url === '/api/agents') {
        sendJson(res, 200, { connected: hub.connected, agents: hub.agentNames() });
        return;
      }
      if (req.url?.startsWith('/api/') && hub.connected) {
        const body = await readBody(req);
        const headers: Record<string, string> = {};
        if (req.headers['content-type']) headers['content-type'] = String(req.headers['content-type']);
        const agentParam = url0.searchParams.get('agent');
        const result = await hub.proxyHttp(agentParam ?? undefined, req.method ?? 'GET', req.url, headers, body);
        if (result) {
          const outHeaders: Record<string, string> = result.headers ?? {};
          res.writeHead(result.status ?? 502, outHeaders);
          res.end(Buffer.from(result.bodyB64 ?? '', 'base64'));
          return;
        }
        if (agentParam) {
          // explicit agent requested but not connected — never silently fall back
          sendJson(res, 502, { error: `agent not connected: ${agentParam}` });
          return;
        }
      }
      if (req.url?.startsWith('/api/')) {
        const handled = await handleApi(req, res);
        if (!handled) sendJson(res, 404, { error: 'not found' });
        return;
      }
      await serveStatic(req, res);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      else res.end();
    }
  })();
});

const wss = new WebSocketServer({ noServer: true });

/** Browsers must not open cross-site WebSockets to us (CSWSH). Node agents
 * (no Origin header) and same-host origins are allowed. */
function originOk(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients (node ws, curl)
  try {
    const o = new URL(origin);
    const host = req.headers.host ?? '';
    return o.host === host;
  } catch {
    return false;
  }
}

server.on('upgrade', (req, socket, head) => {
  if (!originOk(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  if (!checkAuth(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="pii"\r\n\r\n');
    socket.destroy();
    return;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/tunnel') {
    wss.handleUpgrade(req, socket, head, (ws) => hub.handleAgentConnection(ws, url.searchParams.get('name') ?? 'agent'));
    return;
  }
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  if (hub.connected) {
    // proxy the conversation socket to the selected agent
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!hub.proxyWs(url.searchParams.get('agent') ?? undefined, ws, req.url ?? '/ws')) ws.close(1001, 'agent unavailable');
    });
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, url));
});

wss.on('connection', (ws: WebSocket, _req: IncomingMessage, url: URL) => {
  const cwd = url.searchParams.get('cwd');
  const sessionPath = url.searchParams.get('session') ?? undefined;
  if (!cwd) {
    ws.close(4000, 'missing cwd');
    return;
  }

  let host: SessionHost | undefined;
  acquireHost(cwd, sessionPath)
    .then((h) => {
      host = h;
      h.attach(ws);
    })
    .catch((err) => {
      const msg: ServerMessage = {
        type: 'command_result',
        ok: false,
        error: `failed to open session: ${err instanceof Error ? err.message : String(err)}`,
      };
      ws.send(JSON.stringify(msg));
      ws.close(1011, 'session open failed');
    });

  ws.on('message', async (data) => {
    if (!host) return;
    let cmd: ClientCommand & { id?: string };
    try {
      cmd = JSON.parse(String(data));
    } catch {
      return;
    }
    const { id, ...command } = cmd;
    const result = await host.handleCommand(command as ClientCommand);
    const reply: ServerMessage = { type: 'command_result', id, ...result };
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(reply));
  });

  ws.on('close', () => {
    host?.detach(ws);
  });
});

server.listen(options.port, options.host, () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : options.port;
  if (options.agent) {
    console.log(`pii agent local server on 127.0.0.1:${port}, dialing hub ${options.agent}…`);
    runTunnelAgent({
      hubUrl: options.agent,
      token: options.agentToken,
      localPort: port,
      name: options.agentName ?? process.env.HOSTNAME,
    });
    return;
  }
  console.log(`pii web listening on http://${options.host}:${port}`);
  if (!options.password) console.log('Warning: no password set (loopback-only mode).');
});
