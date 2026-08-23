import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectGroup, SessionSummary } from '../types';
import type { Selection, View } from '../App';
import { setLang, getLang, t } from '../i18n';
import {
  IconPlus, IconSearch, IconSettings, IconTrash, IconStar, IconStarFilled,
  IconArchive, IconUnarchive, IconPencil, IconFolder, IconChevronLeft,
  IconChevronRight, IconRefresh, IconSun, IconMoon, IconRobot, IconExport, IconChat,
} from '../icons';

interface Props {
  projects: ProjectGroup[];
  archivedSessions: SessionSummary[];
  selection?: Selection;
  view: View;
  collapsed: boolean;
  width: number;
  onStartDrag: (e: React.MouseEvent) => void;
  onToggleCollapse: () => void;
  onNavigate: (view: View) => void;
  onSelect: (s: Selection) => void;
  onDelete: (path: string) => void;
  onRename: (path: string, name: string) => void;
  onArchive: (path: string, archived: boolean) => void;
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

const OPEN_KEY = 'pii-open-projects';

function loadOpenProjects(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

export default function Sidebar(props: Props) {
  const {
    projects, archivedSessions, selection, view, collapsed, width, onStartDrag,
    onToggleCollapse, onNavigate, onSelect, onDelete, onRename, onArchive, onRefresh, dark, onToggleTheme,
  } = props;

  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [openProjects, setOpenProjects] = useState<Set<string>>(loadOpenProjects);
  const [renamingPath, setRenamingPath] = useState<string>();
  const [renameDraft, setRenameDraft] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const [openParents, setOpenParents] = useState<Set<string>>(new Set());
  const [favs, setFavs] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('pii-favs') ?? '[]') as string[];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    localStorage.setItem(OPEN_KEY, JSON.stringify([...openProjects]));
  }, [openProjects]);

  const toggleFav = (cwd: string) => {
    setFavs((prev) => {
      const next = prev.includes(cwd) ? prev.filter((c) => c !== cwd) : [...prev, cwd];
      localStorage.setItem('pii-favs', JSON.stringify(next));
      return next;
    });
  };

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

  const sorted = useMemo(() => {
    const rank = (cwd: string) => (favs.includes(cwd) ? 0 : 1);
    return [...filtered].sort((a, b) => rank(a.cwd) - rank(b.cwd));
  }, [filtered, favs]);

  const newSessionCwd = selection?.cwd ?? projects[0]?.cwd ?? '/';

  const toggleProject = (cwd: string) =>
    setOpenProjects((prev) => {
      const next = new Set(prev);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });

  const renderSessionRow = (s: SessionSummary, isSub: boolean) =>
    renamingPath === s.path ? (
      <input
        key={s.path}
        autoFocus
        className="sidebar-search"
        style={{ margin: `2px 0 2px ${isSub ? 30 : 12}px`, padding: '5px 8px', fontSize: 12.5 }}
        value={renameDraft}
        onChange={(e) => setRenameDraft(e.target.value)}
        onBlur={() => setRenamingPath(undefined)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            if (renameDraft.trim()) onRename(s.path, renameDraft.trim());
            setRenamingPath(undefined);
          }
          if (e.key === 'Escape') setRenamingPath(undefined);
        }}
      />
    ) : (
      <div
        key={s.path}
        className={`session-item ${isSub ? 'sub' : ''} ${selection?.sessionPath === s.path ? 'active' : ''}`}
        onClick={() => onSelect({ cwd: s.cwd || '', sessionPath: s.path })}
      >
        {isSub
          ? <IconRobot size={12} className="subagent-icon" />
          : <span className={`status-dot ${s.running ? 'on' : ''}`} />}
        <span className="title">{s.name || s.firstMessage || '(空会话)'}</span>
        <span className="time">{relTime(s.modified)}</span>
        <span className="session-actions" onClick={(e) => e.stopPropagation()}>
          <button
            className="btn btn-icon btn-sm"
            title={t('rename')}
            onClick={() => {
              setRenameDraft(s.name || '');
              setRenamingPath(s.path);
            }}
          >
            <IconPencil size={12} />
          </button>
          <button className="btn btn-icon btn-sm" title={t('archive')} onClick={() => onArchive(s.path, true)}>
            <IconArchive size={12} />
          </button>
          <button
            className="btn btn-icon btn-sm"
            title={t('deleteSession')}
            onClick={() => confirm(t('confirmDelete')) && onDelete(s.path)}
          >
            <IconTrash size={12} />
          </button>
        </span>
      </div>
    );

  const renderProjectSessions = (p: ProjectGroup) => {
    const children = new Map<string, SessionSummary[]>();
    const tops: SessionSummary[] = [];
    const pathSet = new Set(p.sessions.map((s) => s.path));
    for (const s of p.sessions) {
      if (s.parentSessionPath && pathSet.has(s.parentSessionPath)) {
        const list = children.get(s.parentSessionPath) ?? [];
        list.push(s);
        children.set(s.parentSessionPath, list);
      } else {
        tops.push(s);
      }
    }
    return tops.map((s) => {
      const kids = children.get(s.path) ?? [];
      if (kids.length === 0) return <div key={s.path}>{renderSessionRow(s, false)}</div>;
      const open = openParents.has(s.path);
      return (
        <div key={s.path} className="parent-with-subs">
          <div className="parent-row">
            <button
              className={`sub-chevron ${open ? 'open' : ''}`}
              title={`${kids.length} subagents`}
              onClick={(e) => {
                e.stopPropagation();
                setOpenParents((prev) => {
                  const next = new Set(prev);
                  if (next.has(s.path)) next.delete(s.path);
                  else next.add(s.path);
                  return next;
                });
              }}
            >
              <IconChevronRight size={10} />
            </button>
            <div style={{ flex: 1, minWidth: 0 }}>{renderSessionRow(s, false)}</div>
            <span className="sub-count">{kids.length}</span>
          </div>
          {open && <div className="subagent-group">{kids.map((k) => renderSessionRow(k, true))}</div>}
        </div>
      );
    });
  };

  if (collapsed) {
    return (
      <div className="sidebar sidebar-collapsed">
        <div className="sidebar-resize" onMouseDown={onStartDrag} />
        <button className="btn btn-icon" title={t('expandSidebar')} onClick={onToggleCollapse}>
          <IconChevronRight />
        </button>
        <button className="btn btn-icon" title={t('newSession')} onClick={() => onSelect({ cwd: newSessionCwd })}>
          <IconPlus />
        </button>
        <div style={{ flex: 1 }} />
        <button className={`btn btn-icon ${view === 'chat' ? 'tab-active' : ''}`} title={t('navChat')} onClick={() => onNavigate('chat')}>
          <IconChat />
        </button>
        <button className={`btn btn-icon ${view === 'files' ? 'tab-active' : ''}`} title={t('navFiles')} onClick={() => onNavigate('files')}>
          <IconFolder />
        </button>
        <button className={`btn btn-icon ${view !== 'chat' && view !== 'files' ? 'tab-active' : ''}`} title={t('navSettings')} onClick={() => onNavigate('settings')}>
          <IconSettings />
        </button>
      </div>
    );
  }

  return (
    <div className="sidebar" style={{ width }}>
      <div className="sidebar-resize" onMouseDown={onStartDrag} />
      <div className="wb-header">
        <button className="btn btn-icon" title={t('collapseSidebar')} onClick={onToggleCollapse}>
          <IconChevronLeft />
        </button>
        <span className="wb-title">{t('workspace')}</span>
        <span className="spacer" />
        <button className="btn btn-icon" title={t('searchSessions')} onClick={() => setSearchOpen((o) => !o)}>
          <IconSearch />
        </button>
        <button className={`btn btn-icon ${view !== 'chat' && view !== 'files' ? 'tab-active' : ''}`} title={t('navSettings')} onClick={() => onNavigate('settings')}>
          <IconSettings />
        </button>
        <button className="btn btn-icon" title={t('importSession')} onClick={() => importRef.current?.click()}>
          <IconExport size={14} style={{ transform: 'rotate(180deg)' }} />
        </button>
        <button className="btn btn-icon" title={t('newSession')} onClick={() => onSelect({ cwd: newSessionCwd })}>
          <IconPlus />
        </button>
      </div>
      <input
        ref={importRef}
        type="file"
        accept=".jsonl,application/jsonl"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          void file.arrayBuffer().then((buf) =>
            fetch('/api/sessions/import', { method: 'POST', body: buf })
              .then((r) => r.json())
              .then((d: { ok?: boolean; cwd?: string; sessionFile?: string; error?: string }) => {
                if (d.ok && d.cwd && d.sessionFile) onSelect({ cwd: d.cwd, sessionPath: d.sessionFile });
                else alert(t('importFailed') + ': ' + (d.error ?? ''));
                onRefresh();
              })
              .catch(() => undefined),
          );
        }}
      />

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
        {sorted.map((p) => {
          const isOpen = openProjects.has(p.cwd);
          const fav = favs.includes(p.cwd);
          return (
            <div className="project-group" key={p.cwd}>
              <div className="project-header" title={p.cwd} onClick={() => toggleProject(p.cwd)}>
                {fav ? <IconStarFilled size={11} className="fav-star" /> : null}
                <IconFolder className="folder-icon" />
                <span className="path">{basename(p.cwd)}</span>
                <span className="project-actions" onClick={(e) => e.stopPropagation()}>
                  <button className="btn btn-icon add-btn" title={t('pinTop')} onClick={() => toggleFav(p.cwd)}>
                    {fav ? <IconStarFilled size={12} /> : <IconStar size={12} />}
                  </button>
                  <button className="btn btn-icon add-btn" title={t('newSession')} onClick={() => onSelect({ cwd: p.cwd })}>
                    <IconPlus size={12} />
                  </button>
                </span>
              </div>
              {isOpen && renderProjectSessions(p)}
            </div>
          );
        })}

        {archivedSessions.length > 0 && (
          <div className="archived-section">
            <div className="project-header" onClick={() => setShowArchived((v) => !v)}>
              <IconArchive className="folder-icon dimmed" />
              <span className="path">{t('archivedSection')} ({archivedSessions.length})</span>
            </div>
            {showArchived &&
              archivedSessions.map((s) => (
                <div key={s.path} className="session-item archived">
                  <span className="status-dot" />
                  <span className="title">{s.name || s.firstMessage || '(空会话)'}</span>
                  <span className="time">{relTime(s.modified)}</span>
                  <span className="session-actions" onClick={(e) => e.stopPropagation()}>
                    <button className="btn btn-icon btn-sm" title={t('unarchive')} onClick={() => onArchive(s.path, false)}>
                      <IconUnarchive size={12} />
                    </button>
                    <button className="btn btn-icon btn-sm" title={t('deleteSession')} onClick={() => confirm(t('confirmDelete')) && onDelete(s.path)}>
                      <IconTrash size={12} />
                    </button>
                  </span>
                </div>
              ))}
          </div>
        )}

        {sorted.length === 0 && !archivedSessions.length && (
          <div style={{ padding: 16, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>
            {query ? t('noMatch') : t('noSessions')}
          </div>
        )}
      </div>

      <div className="sidebar-footer">
        <button className={`btn btn-sm ${view === 'chat' ? 'tab-active' : ''}`} onClick={() => onNavigate('chat')}>{t('navChat')}</button>
        <button className={`btn btn-sm ${view === 'files' ? 'tab-active' : ''}`} onClick={() => onNavigate('files')}>{t('navFiles')}</button>
        <button className={`btn btn-sm ${view !== 'chat' && view !== 'files' ? 'tab-active' : ''}`} onClick={() => onNavigate('settings')}>{t('navSettings')}</button>
        <span style={{ flex: 1 }} />
        <button className="btn btn-icon" title={t('refresh')} onClick={onRefresh}><IconRefresh size={14} /></button>
        <button className="btn btn-icon" title="Language" onClick={() => setLang(getLang() === 'zh' ? 'en' : 'zh')} style={{ fontSize: 12 }}>
          {getLang() === 'zh' ? 'EN' : '中'}
        </button>
        <button className="btn btn-icon" title={dark ? t('toLight') : t('toDark')} onClick={onToggleTheme}>
          {dark ? <IconSun size={14} /> : <IconMoon size={14} />}
        </button>
      </div>
    </div>
  );
}
