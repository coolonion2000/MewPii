/** Bounded filename-only index. Never reads file contents or follows symlinks. */
import { opendir, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { resolveWorkspacePath } from './security.js';

const ignored = new Set(['node_modules', 'dist', 'build', 'target', 'vendor', '__pycache__', 'coverage']);
export interface MentionFile { name: string; path: string; isDir: boolean }
type Index = { items: MentionFile[]; truncated: boolean };
const cache = new Map<string, { expires: number; pending: Promise<Index> }>();

export function mentionScore(path: string, query: string): number {
  const value = path.toLowerCase(), q = query.toLowerCase().trim();
  const name = value.split('/').pop()!;
  if (!q) return path.split('/').length * 10;
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  if (name.includes(q)) return 2;
  if (value.includes(q)) return 3;
  let cursor = 0;
  for (const char of value) if (char === q[cursor]) cursor++;
  return cursor === q.length ? 4 : Infinity;
}

async function buildIndex(cwd: string, scope = '.'): Promise<Index> {
  const start = Date.now(), queue = [scope], items: MentionFile[] = [];
  let scanned = 0, truncated = false;
  while (queue.length && !truncated) {
    if (Date.now() - start > 750) { truncated = true; break; }
    const path = queue.shift()!;
    // Recheck each directory against the workspace boundary, including symlink races.
    const directory = await resolveWorkspacePath(cwd, path, { extraRoots: [cwd] }).catch(() => undefined);
    if (!directory) continue;
    try {
      const dir = await opendir(directory.path);
      for await (const entry of dir) {
        if (++scanned > 10000 || Date.now() - start > 750) { truncated = true; break; }
        if (entry.name.startsWith('.') || /[\x00-\x1f]/.test(entry.name) || ignored.has(entry.name) || entry.isSymbolicLink()) continue;
        if (!entry.isDirectory() && !entry.isFile()) continue;
        const child = relative(cwd, join(directory.path, entry.name));
        items.push({ name: entry.name, path: child, isDir: entry.isDirectory() });
        if (entry.isDirectory()) {
          if (child.split('/').length < 25) queue.push(child);
          else truncated = true;
        }
      }
    } catch { /* Directory may disappear or be unreadable while indexing. */ }
  }
  console.info(`[files] mention_index_complete entries=${items.length} scanned=${scanned} truncated=${truncated} duration_ms=${Date.now() - start}`);
  return { items, truncated };
}

export async function searchMentionFiles(cwd: string, query: string): Promise<Index> {
  cwd = await realpath(cwd);
  query = query.trim().slice(0, 200);
  let scope = '.';
  const slash = query.lastIndexOf('/');
  if (slash > 0) {
    const prefix = query.slice(0, slash);
    if (!prefix.split('/').some(part => part.startsWith('.') || ignored.has(part))) {
      const directory = await resolveWorkspacePath(cwd, prefix, { extraRoots: [cwd] }).catch(() => undefined);
      if (directory) scope = relative(cwd, directory.path) || '.';
    }
  }
  const key = JSON.stringify([cwd, scope]);
  let entry = cache.get(key);
  if (!entry || entry.expires < Date.now()) {
    entry = { expires: Date.now() + 10000, pending: buildIndex(cwd, scope) };
    cache.delete(key); cache.set(key, entry);
    while (cache.size > 8) cache.delete(cache.keys().next().value!);
    entry.pending.catch(() => { if (cache.get(key) === entry) cache.delete(key); });
  }
  const index = await entry.pending;
  const matches = index.items.map(item => ({ item, score: mentionScore(item.path, query.slice(0, 200)) }))
    .filter(hit => Number.isFinite(hit.score)).sort((a, b) => a.score - b.score || a.item.path.length - b.item.path.length || a.item.path.localeCompare(b.item.path));
  return { items: matches.slice(0, 24).map(hit => hit.item), truncated: index.truncated || matches.length > 24 };
}
