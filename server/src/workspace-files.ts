/** Workspace browsing, uploads and read-only Git views. @author coolonion */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { readdir, stat, readFile, writeFile, mkdir, link, rename, unlink, realpath } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveWorkspacePath } from './security.js';

const run = promisify(execFile);
const MAX_PREVIEW = 2 * 1024 * 1024;
export const MAX_UPLOAD = 64 * 1024 * 1024;
const images: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bmp': 'image/bmp' };
const ignored = new Set(['node_modules', 'dist', 'build', 'target', 'vendor', '__pycache__', '.git']);
export class FileRequestError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function textContent(bytes: Buffer): string {
  if (bytes.includes(0)) throw new FileRequestError(415, 'binary file, preview unsupported');
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const controls = text.match(/[\x01-\x08\x0b\x0c\x0e-\x1f]/g)?.length ?? 0;
    if (controls > text.length * 0.01 || /^(%PDF-|PK\x03\x04)/.test(text)) throw new Error('binary');
    return text;
  } catch { throw new FileRequestError(415, 'binary file, preview unsupported'); }
}

export async function readTextPreview(file: string): Promise<string> {
  const info = await stat(file);
  if (!info.isFile()) throw new FileRequestError(400, 'not a file');
  if (info.size > MAX_PREVIEW) throw new FileRequestError(413, 'file too large');
  const bytes = await readFile(file);
  if (bytes.length > MAX_PREVIEW) throw new FileRequestError(413, 'file too large');
  return textContent(bytes);
}

/** Publish a complete upload; existing files are never replaced implicitly. */
export async function saveUpload(file: string, bytes: Buffer, replace = false): Promise<void> {
  if (bytes.length > MAX_UPLOAD) throw new FileRequestError(413, 'upload exceeds 64 MB');
  await mkdir(dirname(file), { recursive: true });
  const temp = join(dirname(file), `.pii-upload-${randomUUID()}`);
  try {
    const previous = replace ? await stat(file).catch(() => undefined) : undefined;
    await writeFile(temp, bytes, { flag: 'wx', mode: previous ? previous.mode & 0o777 : 0o600 });
    if (replace) await rename(temp, file);
    else await link(temp, file);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') throw new FileRequestError(409, 'file already exists');
    throw cause;
  } finally { await unlink(temp).catch(() => undefined); }
}

export interface GitChange { path: string; originalPath?: string; status: string; staged: string; unstaged: string }
export function parseGitStatus(raw: string): GitChange[] {
  const fields = raw.split('\0');
  const out: GitChange[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    const originalPath = /[RC]/.test(status) ? fields[++i] : undefined;
    out.push({ path: entry.slice(3), originalPath, status: status.trim(), staged: status[0], unstaged: status[1] });
  }
  return out;
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await run('git', ['--no-pager', ...args], { cwd, maxBuffer: 8 * 1024 * 1024, timeout: 15000 })).stdout;
}

export async function gitChanges(cwd: string): Promise<{ branch: string; changes: GitChange[] }> {
  cwd = await realpath(cwd);
  const repo = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  const raw = await git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const changes = parseGitStatus(raw).map(c => ({ ...c,
    path: relative(cwd, resolve(repo, c.path)),
    originalPath: c.originalPath ? relative(cwd, resolve(repo, c.originalPath)) : undefined,
  })).filter(c => c.path && c.path !== '..' && !c.path.startsWith('../'));
  const branch = (await git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => git(cwd, ['rev-parse', '--short', 'HEAD']))).trim();
  return { branch, changes };
}

export async function gitDiff(cwd: string, path: string, scope: string): Promise<string> {
  const { changes } = await gitChanges(cwd);
  const change = changes.find(c => c.path === path);
  if (!change) throw new FileRequestError(404, 'file is not in the change list');
  const newFileDiff = async () => {
    const target = await resolveWorkspacePath(cwd, path, { extraRoots: [cwd] });
    const content = await readTextPreview(target.path);
    return `--- /dev/null\n+++ b/${path}\n@@ new file @@\n${content.split('\n').map(line => `+${line}`).join('\n')}`;
  };
  if (change.status === '??') {
    if (scope === 'staged') return '';
    return newFileDiff();
  }
  const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color'];
  if (scope === 'staged') args.push('--cached');
  else if (scope !== 'unstaged') {
    const hasHead = await git(cwd, ['rev-parse', '--verify', 'HEAD']).then(() => true, () => false);
    if (hasHead) args.push('HEAD');
    // Before the first commit, all changes are the current file relative to an empty tree.
    else return newFileDiff().catch(cause => {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw cause;
    });
  }
  // Match only paths reported by Git, including removed files and rename sources.
  const paths = [path, ...(change.originalPath && !change.originalPath.startsWith('../') ? [change.originalPath] : [])];
  return git(cwd, [...args, '--', ...paths.map(p => `:(literal)${p}`)]);
}

interface FileItem { name: string; path: string; isDir: boolean; size: number; modified?: string }
export async function listFiles(cwd: string, path: string, showHidden: boolean): Promise<FileItem[]> {
  const { path: directory } = await resolveWorkspacePath(cwd, path, { extraRoots: [cwd] });
  const entries = (await readdir(directory, { withFileTypes: true })).filter(e => showHidden || (!e.name.startsWith('.') && !ignored.has(e.name)));
  const items: FileItem[] = [];
  // Bound filesystem concurrency even for very large dependency directories.
  for (let start = 0; start < entries.length; start += 16) {
    items.push(...await Promise.all(entries.slice(start, start + 16).map(async e => {
      const info = await stat(join(directory, e.name)).catch(() => undefined);
      return { name: e.name, path: path === '.' ? e.name : `${path}/${e.name}`, isDir: e.isDirectory(), size: info?.size ?? 0, modified: info?.mtime.toISOString() };
    })));
  }
  return items.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
}

export async function searchFiles(cwd: string, query: string, showHidden: boolean) {
  const queue = ['.']; const items: FileItem[] = []; let scanned = 0;
  while (queue.length && scanned < 10000 && items.length < 300) {
    const dir = queue.shift()!;
    const entries = await listFiles(cwd, dir, showHidden).catch(() => []);
    for (const item of entries) {
      if (++scanned > 10000 || items.length >= 300) break;
      if (item.name.toLowerCase().includes(query.toLowerCase())) items.push(item);
      if (item.isDir && item.path.split('/').length < 25) queue.push(item.path);
    }
  }
  return { items, truncated: scanned >= 10000 || items.length >= 300 || queue.length > 0 };
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value));
}

export async function handleWorkspaceFiles(req: IncomingMessage, res: ServerResponse, url: URL, dependencies: {
  roots: () => Promise<string[]>;
  preview: (cwd: string, path: string, sessionId?: string) => Promise<string>;
}): Promise<boolean> {
  const route = url.pathname;
  if (!['/api/files', '/api/file', '/api/files/upload', '/api/git', '/api/git/diff'].includes(route)) return false;
  if (req.method !== (route === '/api/files/upload' ? 'POST' : 'GET')) return false;
  const cwd = url.searchParams.get('cwd'); const path = url.searchParams.get('path') ?? '.';
  try {
    if (!cwd) throw new FileRequestError(400, 'missing cwd');
    const { base } = await resolveWorkspacePath(cwd, '.', { extraRoots: await dependencies.roots() });
    if (route === '/api/files') {
      // Preserve the existing directory picker contract unless explicitly hidden.
      const showHidden = url.searchParams.get('hidden') !== '0';
      const query = url.searchParams.get('q')?.trim();
      const result = query ? await searchFiles(base, query, showHidden) : { items: await listFiles(base, path, showHidden) };
      json(res, 200, { cwd: base, path, ...result });
    } else if (route === '/api/file') {
      const file = await dependencies.preview(base, path, url.searchParams.get('sessionId') ?? undefined);
      if (!(await stat(file)).isFile()) throw new FileRequestError(400, 'not a file');
      const download = url.searchParams.get('download') === '1';
      const mime = images[extname(file).toLowerCase()];
      if (download || mime) {
        res.writeHead(200, { 'Content-Type': download ? 'application/octet-stream' : mime,
          'X-Content-Type-Options': 'nosniff',
          ...(download ? { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(basename(file)).replace(/'/g, '%27')}` } : {}),
        });
        const stream = createReadStream(file); stream.on('error', () => res.destroy()); stream.pipe(res);
      } else json(res, 200, { path, name: basename(file), content: await readTextPreview(file) });
    } else if (route === '/api/files/upload') {
      const target = await resolveWorkspacePath(base, path, { write: true, extraRoots: [base] });
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_UPLOAD) throw new FileRequestError(413, 'upload exceeds 64 MB');
        chunks.push(chunk);
      }
      const replace = url.searchParams.get('replace') === '1';
      await saveUpload(target.path, Buffer.concat(chunks), replace);
      console.info(`[files] upload_complete cwd=${JSON.stringify(base)} path=${JSON.stringify(path)} bytes=${size} replace=${replace}`);
      json(res, 200, { ok: true, path });
    } else if (route === '/api/git') json(res, 200, await gitChanges(base));
    else json(res, 200, { diff: await gitDiff(base, path, url.searchParams.get('scope') ?? 'all') });
  } catch (cause) {
    const status = cause instanceof FileRequestError ? cause.status : (cause as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 400;
    const error = cause instanceof Error ? cause.message : String(cause);
    if (route === '/api/files/upload') console.info(`[files] upload_rejected path=${JSON.stringify(path)} status=${status} error=${JSON.stringify(error)}`);
    if (!res.headersSent) json(res, status, { error });
  }
  return true;
}
