/** File workspace state and presentation helpers. @author coolonion */
export interface FileItem { name: string; path: string; isDir: boolean; size: number; modified?: string }
export interface GitChange { path: string; originalPath?: string; status: string; staged: string; unstaged: string }
export interface GitState { branch: string; changes: GitChange[] }
export interface FileWorkspaceState { selected?: string; directory: string; open: string[]; hidden: boolean; width: number }
export const emptyWorkspace = (): FileWorkspaceState => ({ directory: '.', open: ['.'], hidden: false, width: 260 });
export const parentDirectory = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.';
export const fullFilePath = (cwd: string, path: string) => path.startsWith('/') ? path : `${cwd.replace(/\/$/, '')}/${path === '.' ? '' : path}`;
/** Relative Markdown resources resolve against the file, not the browser route. */
export function markdownFilePath(source: string, target: string): string | undefined {
  if (!target || target.startsWith('#') || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) return undefined;
  const raw = target.split(/[?#]/, 1)[0];
  let decoded: string; try { decoded = decodeURIComponent(raw); } catch { decoded = raw; }
  const combined = decoded.startsWith('/') ? decoded : `${parentDirectory(source)}/${decoded}`;
  const parts: string[] = [];
  for (const part of combined.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
    else parts.push(part);
  }
  return `${combined.startsWith('/') ? '/' : ''}${parts.join('/')}`;
}
export function ancestorDirectories(path: string): string[] {
  const parts = path.split('/');
  return ['.', ...parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'))];
}
export function loadFileWorkspace(key: string): FileWorkspaceState {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '{}');
    const valid = (p: unknown): p is string => typeof p === 'string' && !p.startsWith('/') && !p.split('/').includes('..');
    return { selected: valid(value.selected) ? value.selected : undefined,
      directory: valid(value.directory) ? value.directory : '.',
      open: Array.isArray(value.open) ? value.open.filter(valid).slice(0, 100) : ['.'],
      hidden: value.hidden === true,
      width: Number.isFinite(value.width) ? Math.max(200, Math.min(480, value.width)) : 260 };
  } catch { return emptyWorkspace(); }
}
export function formatFileSize(size: number): string {
  return size < 1024 ? `${size} B` : size < 1048576 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1048576).toFixed(1)} MB`;
}
export class FileApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export async function fileJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  const data = await response.json();
  if (!response.ok || data.error) throw new FileApiError(response.status, data.error ?? `HTTP ${response.status}`);
  return data;
}
