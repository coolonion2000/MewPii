/** Sessions opened in this browser tab, retained across refreshes. */

import type { ProjectGroup } from './types';

export interface UsedSession {
  agent?: string;
  cwd: string;
  sessionPath?: string;
  sessionId?: string;
  title: string;
  at: number;
}

const storageKey = 'mewpii.current-work.v1';
export function parseCurrentWork(value: string | null): { used: UsedSession[]; dismissed: UsedSession[] } {
  const valid = (items: unknown): UsedSession[] => Array.isArray(items) ? items.filter((s): s is UsedSession =>
    Boolean(s && typeof s === 'object' && typeof s.cwd === 'string' && typeof s.title === 'string'
      && typeof s.at === 'number' && Number.isFinite(s.at)
      && (s.agent === undefined || typeof s.agent === 'string')
      && (s.sessionId === undefined || typeof s.sessionId === 'string')
      && (s.sessionPath === undefined || typeof s.sessionPath === 'string')
      && (s.sessionId || s.sessionPath))).slice(0, 20) : [];
  try { const data = JSON.parse(value ?? '{}'); return {used: valid(data.used), dismissed: valid(data.dismissed)}; }
  catch { return {used: [], dismissed: []}; }
}
function restore() {
  try { return parseCurrentWork(sessionStorage.getItem(storageKey)); }
  catch { return {used: [], dismissed: []}; }
}
let { used, dismissed } = restore();
const listeners = new Set<() => void>();

function sameSession(a: UsedSession, b: Omit<UsedSession, 'at'>): boolean {
  return a.agent === b.agent && a.cwd === b.cwd && (
    Boolean(a.sessionId && a.sessionId === b.sessionId) ||
    Boolean(a.sessionPath && a.sessionPath === b.sessionPath)
  );
}

function emit(): void {
  try { sessionStorage.setItem(storageKey, JSON.stringify({used, dismissed})); } catch { /* private mode/quota: keep in-memory state */ }
  for (const fn of listeners) fn();
}

export function currentWorkEntry(input: {
  agent?: string; cwd: string; sessionPath?: string; sessionId?: string; name?: string;
  messages: readonly { role: string; content?: unknown }[];
}): Omit<UsedSession, 'at'> | undefined {
  if (!input.sessionId && !input.sessionPath) return;
  const content = input.messages.find(message => message.role === 'user')?.content;
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.find(block => block?.type === 'text' && typeof block.text === 'string')?.text ?? '' : '';
  const existing = used.find(s => sameSession(s, {...input, title: ''}));
  return {agent: input.agent, cwd: input.cwd, sessionId: input.sessionId, sessionPath: input.sessionPath,
    title: input.name || text.slice(0, 40) || existing?.title || '(新会话)'};
}

export function addUsedSession(s: Omit<UsedSession, 'at'>, options?: { reopen?: boolean }): void {
  // A blank project has no stable session identity and must not collide with
  // another new conversation in the same directory.
  if (!s.sessionPath && !s.sessionId) return;
  const matches = (item: UsedSession) => sameSession(item, s);
  if (options?.reopen) dismissed = dismissed.filter((item) => !matches(item));
  else if (dismissed.some(matches)) return;
  const existingIndex = used.findIndex(matches);
  const existing = existingIndex >= 0 ? used[existingIndex] : undefined;
  // Later snapshots may temporarily omit one identity field.
  s = { ...s, sessionId: s.sessionId || existing?.sessionId, sessionPath: s.sessionPath || existing?.sessionPath };
  if (
    existingIndex === 0 &&
    existing?.sessionId === s.sessionId &&
    existing?.sessionPath === s.sessionPath &&
    existing?.title === s.title
  )
    return;
  used = [
    { ...s, at: Date.now() },
    ...used.filter((item) => !matches(item)),
  ].slice(0, 20);
  emit();
}

/** Remove only the shortcut; the session and any running work stay untouched. */
export function removeUsedSession(s: UsedSession): void {
  const next = used.filter((item) => !sameSession(item, s));
  if (next.length === used.length) return;
  dismissed = [s, ...dismissed.filter((item) => !sameSession(item, s))].slice(0, 20);
  used = next;
  emit();
}

export function getUsedSessions(): UsedSession[] {
  return used;
}

export function subscribeUsedSessions(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Prefer the canonical workspace title over a paged conversation fallback. */
export function resolveUsedSessionTitle(
  session: UsedSession,
  projects: readonly ProjectGroup[],
): string {
  if (!session.sessionPath) return session.title;
  for (const project of projects) {
    const canonical = project.sessions.find(
      (candidate) => candidate.path === session.sessionPath,
    );
    if (canonical) return canonical.name || canonical.firstMessage || session.title;
  }
  return session.title;
}
