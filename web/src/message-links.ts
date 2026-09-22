/** Classify chat links without granting filesystem access. @author coolonion */
export type MessageLink = { kind: 'file'; path: string } | { kind: 'web' | 'anchor'; href: string } | { kind: 'invalid' };

export function messageLink(href: string | undefined, cwd?: string): MessageLink {
  if (!href || /[\u0000-\u001f\u007f]/.test(href)) return { kind: 'invalid' };
  if (href.startsWith('#')) return { kind: 'anchor', href };
  if (/^(https?:|mailto:|\/\/)/i.test(href)) return { kind: 'web', href };
  // Other protocols must never reach an active link (including file:// URLs).
  if (/^[a-z][a-z\d+.-]*:/i.test(href)) return { kind: 'invalid' };
  let path: string;
  try { path = decodeURIComponent(href.split(/[?#]/, 1)[0]); }
  catch { return { kind: 'invalid' }; }
  if (!path || /[\u0000-\u001f\u007f]/.test(path)) return { kind: 'invalid' };
  if (!path.startsWith('/')) {
    if (!cwd) return { kind: 'invalid' };
    path = `${cwd.replace(/\/$/, '')}/${path}`;
  }
  // Keep '..' intact: the server resolves symlinks and enforces exact-file access.
  return { kind: 'file', path };
}
