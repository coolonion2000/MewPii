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

function shortPath(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : cwd;
}

function relTime(iso: string): string {
  const diff = Date.now() - Date.parse(iso);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return t('justNow');
  if (m < 60) return `${m} ${t('minutesAgo')}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ${t('hoursAgo')}`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} ${t('daysAgo')}`;
  return new Date(iso).toLocaleDateString();
}

export default function Sidebar({ projects, selection, view, onNavigate, onSelect, onDelete, onRefresh, dark, onToggleTheme }: Props) {
  const [query, setQuery] = useState('');
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

  const newSessionCwd = projects[0]?.cwd ?? '/';

  return (
    <div className="sidebar">
      <div className="sidebar-brand">
        <span className="logo">π</span>
        <span>pii</span>
        <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', fontWeight: 400 }}>pi web</span>
      </div>
      <div className="sidebar-actions">
        <button className="btn btn-primary" onClick={() => onSelect({ cwd: newSessionCwd })}>
          ＋ {t('newSession')}
        </button>
      </div>
      <div style={{ padding: '0 12px 8px' }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('searchSessions')}
          style={{
            width: '100%', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
            padding: '6px 10px', fontSize: 13, fontFamily: 'inherit',
            background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
            outline: 'none',
          }}
        />
      </div>
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
                <span style={{ fontSize: 10 }}>{isCollapsed ? '▸' : '▾'}</span>
                <span className="path">{shortPath(p.cwd)}</span>
                <button
                  className="btn btn-icon add-btn"
                  title="在此项目中新建会话"
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
                    <div className="title">{s.name || s.firstMessage || '(空会话)'}</div>
                    <div className="meta">
                      {s.running && <span className="running-dot" title={t('running')} />}
                      <span>{s.messageCount} {t('messages')}</span>
                      <span>·</span>
                      <span>{relTime(s.modified)}</span>
                    </div>
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
        <button
          className={`btn btn-sm ${view === 'chat' ? 'tab-active' : ''}`}
          onClick={() => onNavigate('chat')}
        >
          {t('navChat')}
        </button>
        <button
          className={`btn btn-sm ${view === 'files' ? 'tab-active' : ''}`}
          onClick={() => onNavigate('files')}
        >
          {t('navFiles')}
        </button>
        <button
          className={`btn btn-sm ${view === 'models' ? 'tab-active' : ''}`}
          onClick={() => onNavigate('models')}
        >
          {t('navModels')}
        </button>
        <button
          className={`btn btn-sm ${view === 'resources' ? 'tab-active' : ''}`}
          onClick={() => onNavigate('resources')}
        >
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
