import { useMemo, useState } from 'react';
import type { ProjectGroup } from '../types';
import type { Selection, View } from '../App';
import { setLang, getLang, t } from '../i18n';

interface Props {
  projects: ProjectGroup[];
  selection?: Selection;
  view: View;
  onNavigate: (view: View) => void;
  onSelect: (s: Selection) => void;
  onDelete: (path: string) => void;
  onRefresh: () => void;
  dark: boolean;
  onToggleTheme: () => void;
}

function basename(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

function relTime(iso: string): string {
  const diff = Date.now() - Date.parse(iso);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return t('justNow');
  if (m < 60) return `${m}${t('minutesAgo')}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}${t('hoursAgo')}`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}${t('daysAgo')}`;
  return new Date(iso).toLocaleDateString();
}

export default function Sidebar({ projects, selection, view, onNavigate, onSelect, onDelete, onRefresh, dark, onToggleTheme }: Props) {
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    if (!query.trim()) return projects;
    const q = query.toLowerCase();
    return projects
      .map((p) => ({
        ...p,
        sessions: p.sessions.filter(
          (s) =>
            s.name?.toLowerCase().includes(q) ||
            s.firstMessage.toLowerCase().includes(q) ||
            p.cwd.toLowerCase().includes(q),
        ),
      }))
      .filter((p) => p.sessions.length > 0);
  }, [projects, query]);

  const newSessionCwd = selection?.cwd ?? projects[0]?.cwd ?? '/';

  return (
    <div className="sidebar">
      <div className="wb-header">
        <span className="wb-title">{t('workspace')}</span>
        <span className="spacer" />
        <button className="btn btn-icon" title={t('searchSessions')} onClick={() => setSearchOpen((o) => !o)}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        </button>
        <button className={`btn btn-icon ${view === 'settings' ? 'tab-active' : ''}`} title={t('navSettings')} onClick={() => onNavigate('settings')}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 8h10M18 8h2M4 16h2M10 16h10"/><circle cx="16" cy="8" r="2"/><circle cx="8" cy="16" r="2"/></svg>
        </button>
        <button className="btn btn-icon" title={t('newSession')} onClick={() => onSelect({ cwd: newSessionCwd })}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14"/></svg>
        </button>
      </div>

      {searchOpen && (
        <div style={{ padding: '0 12px 8px' }}>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('searchSessions')}
            className="sidebar-search"
          />
        </div>
      )}

      <div className="sidebar-scroll">
        {filtered.map((p) => {
          const isCollapsed = collapsed.has(p.cwd);
          return (
            <div className="project-group" key={p.cwd}>
              <div
                className="project-header"
                title={p.cwd}
                onClick={() =>
                  setCollapsed((prev) => {
                    const next = new Set(prev);
                    if (next.has(p.cwd)) next.delete(p.cwd);
                    else next.add(p.cwd);
                    return next;
                  })
                }
              >
                <svg className="folder-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>
                </svg>
                <span className="path">{basename(p.cwd)}</span>
                <button
                  className="btn btn-icon add-btn"
                  title={t('newSession')}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect({ cwd: p.cwd });
                  }}
                >
                  ＋
                </button>
              </div>
              {!isCollapsed &&
                p.sessions.map((s) => (
                  <div
                    key={s.path}
                    className={`session-item ${selection?.sessionPath === s.path ? 'active' : ''}`}
                    onClick={() => onSelect({ cwd: s.cwd || p.cwd, sessionPath: s.path })}
                  >
                    <span className={`status-dot ${s.running ? 'on' : ''}`} />
                    <span className="title">{s.name || s.firstMessage || '(空会话)'}</span>
                    <span className="time">{relTime(s.modified)}</span>
                    <button
                      className="btn btn-icon btn-sm delete-btn"
                      title={t('deleteSession')}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(t('confirmDelete'))) onDelete(s.path);
                      }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div style={{ padding: 16, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>
            {query ? t('noMatch') : t('noSessions')}
          </div>
        )}
      </div>

      <div className="sidebar-footer">
        <button className={`btn btn-sm ${view === 'chat' ? 'tab-active' : ''}`} onClick={() => onNavigate('chat')}>
          {t('navChat')}
        </button>
        <button className={`btn btn-sm ${view === 'files' ? 'tab-active' : ''}`} onClick={() => onNavigate('files')}>
          {t('navFiles')}
        </button>
        <button className={`btn btn-sm ${view === 'models' ? 'tab-active' : ''}`} onClick={() => onNavigate('models')}>
          {t('navModels')}
        </button>
        <button className={`btn btn-sm ${view === 'resources' ? 'tab-active' : ''}`} onClick={() => onNavigate('resources')}>
          {t('navResources')}
        </button>
        <span style={{ flex: 1 }} />
        <button className="btn btn-icon" title={t('refresh')} onClick={onRefresh} style={{ fontSize: 14 }}>⟳</button>
        <button className="btn btn-icon" title="Language" onClick={() => setLang(getLang() === 'zh' ? 'en' : 'zh')} style={{ fontSize: 12 }}>
          {getLang() === 'zh' ? 'EN' : '中'}
        </button>
        <button className="btn btn-icon" title={dark ? t('toLight') : t('toDark')} onClick={onToggleTheme} style={{ fontSize: 14 }}>
          {dark ? '☀' : '☾'}
        </button>
      </div>
    </div>
  );
}
