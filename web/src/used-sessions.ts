/** Sessions used (messaged) in this browser tab; cleared on refresh. */

export interface UsedSession {
  cwd: string;
  sessionPath?: string;
  sessionId?: string;
  title: string;
  at: number;
}

let used: UsedSession[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

export function addUsedSession(s: Omit<UsedSession, 'at'>): void {
  const key = (s.sessionPath ?? '') + '|' + s.cwd;
  used = [{ ...s, at: Date.now() }, ...used.filter((u) => (u.sessionPath ?? '') + '|' + u.cwd !== key)].slice(0, 20);
  emit();
}

export function getUsedSessions(): UsedSession[] {
  return used;
}

export function subscribeUsedSessions(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
