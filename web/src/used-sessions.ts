/** Sessions opened in this browser tab; cleared on refresh. */

import type { ProjectGroup } from './types';

export interface UsedSession {
  agent?: string;
  cwd: string;
  sessionPath?: string;
  sessionId?: string;
  title: string;
  at: number;
}

let used: UsedSession[] = [];
let dismissed: UsedSession[] = [];
const listeners = new Set<() => void>();

function sameSession(a: UsedSession, b: Omit<UsedSession, 'at'>): boolean {
  return a.agent === b.agent && a.cwd === b.cwd && (
    Boolean(a.sessionId && a.sessionId === b.sessionId) ||
    Boolean(a.sessionPath && a.sessionPath === b.sessionPath)
  );
}

function emit(): void {
  for (const fn of listeners) fn();
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
