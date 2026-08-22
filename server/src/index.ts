import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, readdir, stat, unlink, writeFile, mkdir } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { ModelRegistry, ModelRuntime, SessionManager, createAgentSessionServices } from '@earendil-works/pi-coding-agent';
import type { ClientCommand, ProjectGroup, ServerMessage } from './protocol.js';
import { SessionHost } from './session-host.js';

// ---------------------------------------------------------------------------
// CLI options
// ---------------------------------------------------------------------------
interface ServerOptions {
  host: string;
  port: number;
  password?: string;
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
    else if (arg === '--help' || arg === '-h') {
      console.log(`pii web — dsh-styled web UI for the pi coding agent

Usage: pii-web [options]

Options:
  --host, -H <host>        Listen host (default 127.0.0.1, env PII_HOST)
  --port, -p <port>        Listen port (default 31041, env PII_PORT)
  --password <password>    Basic Auth password, user "pi" (env PII_PASSWORD)
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
const isLoopback = options.host === '127.0.0.1' || options.host === 'localhost' || options.host === '::1';
if (!isLoopback && !options.password) {
  console.error('Refusing to listen on a non-loopback host without a password. Set --password or PII_PASSWORD.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Auth (HTTP Basic, user "pi"; browsers reuse cached credentials for WS too)
// ---------------------------------------------------------------------------
function checkAuth(req: IncomingMessage): boolean {
  if (!options.password) return true;
  const header = req.headers.authorization;
  if (!header?.startsWith('Basic ')) return false;
  const [user, pass] = Buffer.from(header.slice(6), 'base64').toString().split(':', 2);
  // Constant-time-ish comparison without leaking length timing.
  const expected = `pi:${options.password}`;
  const actual = `${user}:${pass}`;
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function requireAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (checkAuth(req)) return true;
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="pii", charset="UTF-8"' });
  res.end('Authentication required');
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

  if (path === '/api/sessions' && req.method === 'GET') {
    const running = new Set(
      [...hosts.values()].filter((h) => h.isRunning).map((h) => h.session.sessionFile).filter(Boolean) as string[],
    );
    const all = await SessionManager.listAll();
    const byCwd = new Map<string, ProjectGroup>();
    for (const s of all) {
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
    const dir = jail(cwd, rel);
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
    const file = jail(cwd, rel);
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
// HTTP + WS server
// ---------------------------------------------------------------------------
const server = createServer((req, res) => {
  void (async () => {
    try {
      if (!requireAuth(req, res)) return;
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

server.on('upgrade', (req, socket, head) => {
  if (!checkAuth(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="pii"\r\n\r\n');
    socket.destroy();
    return;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/ws') {
    socket.destroy();
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
  console.log(`pii web listening on http://${options.host}:${options.port}`);
  if (!options.password) console.log('Warning: no password set (loopback-only mode).');
});
