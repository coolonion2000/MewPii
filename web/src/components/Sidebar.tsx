import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectGroup, SessionSummary } from '../types';
import type { Selection, View } from '../App';
import { setLang, getLang, t } from '../i18n';
import DirectoryPicker from './DirectoryPicker';
import {
  IconPlus, IconSearch, IconSettings, IconTrash, IconStar, IconStarFilled,
  IconArchive, IconUnarchive, IconPencil, IconFolder, IconChevronLeft,
  IconChevronRight, IconRefresh, IconSun, IconMoon, IconExport, IconChat, IconLogout,
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
  authRequired?: boolean;
  agents?: string[];
  currentAgent?: string;
  onSelectAgent?: (name: string) => void;
}

function basename(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

/** dsh-style: titles truncate to the first N characters with an ellipsis. */
function shortTitle(text: string, n = 12): string {
  const t = text.trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
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
    onToggleCollapse, onNavigate, onSelect, onDelete, onRename, onArchive, onRefresh, dark, onToggleTheme, authRequired,
    agents, currentAgent, onSelectAgent,
  } = props;

  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [openProjects, setOpenProjects] = useState<Set<string>>(loadOpenProjects);
  const [renamingPath, setRenamingPath] = useState<string>();
  const [renameDraft, setRenameDraft] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [projectOrder, setProjectOrder] = useState<string[]>([]);
  const dragCwd = useRef<string | undefined>(undefined);
  const importRef = useRef<HTMLInputElement>(null);
  const [openParents, setOpenParents] = useState<Set<string>>(new Set());
  const [favs, setFavs] = useState<string[]>([]);
  const stateLoaded = useRef(false);

  useEffect(() => {
    fetch('/api/state')
      .then((r) => r.json())
      .then((d: { favorites?: string[]; projectOrder?: string[] }) => {
        const serverFavs = d.favorites ?? [];
        const serverOrder = d.projectOrder ?? [];
        // migrate legacy localStorage values if the server has none
        const legacyFavs = JSON.parse(localStorage.getItem('pii-favs') ?? '[]') as string[];
        const legacyOrder = JSON.parse(localStorage.getItem('pii-project-order') ?? '[]') as string[];
        const mergedFavs = serverFavs.length ? serverFavs : legacyFavs;
        const mergedOrder = serverOrder.length ? serverOrder : legacyOrder;
        setFavs(mergedFavs);
        setProjectOrder(mergedOrder);
        stateLoaded.current = true;
        if (!serverFavs.length && (legacyFavs.length || legacyOrder.length)) {
          void fetch('/api/state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ favorites: mergedFavs, projectOrder: mergedOrder }),
          }).catch(() => undefined);
        }
      })
      .catch(() => {
        stateLoaded.current = true;
      });
  }, []);

  const persistState = useCallback((favorites: string[], order: string[]) => {
    void fetch('/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ favorites, projectOrder: order }),
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    localStorage.setItem(OPEN_KEY, JSON.stringify([...openProjects]));
  }, [openProjects]);

  const toggleFav = (cwd: string) => {
    setFavs((prev) => {
      const next = prev.includes(cwd) ? prev.filter((c) => c !== cwd) : [...prev, cwd];
      persistState(next, projectOrder);
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
    const favRank = (cwd: string) => (favs.includes(cwd) ? 0 : 1);
    const orderRank = (cwd: string) => {
      const i = projectOrder.indexOf(cwd);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    return [...filtered].sort(
      (a, b) => favRank(a.cwd) - favRank(b.cwd) || orderRank(a.cwd) - orderRank(b.cwd),
    );
  }, [filtered, favs, projectOrder]);

  const newSessionCwd = selection?.cwd ?? projects[0]?.cwd ?? '/';

  const toggleProject = (cwd: string) =>
    setOpenProjects((prev) => {
      const next = new Set(prev);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });

  const renderSessionRow = (
    s: SessionSummary,
    depth: number,
    kids?: { count: number; open: boolean; toggle: () => void },
  ) => {
    const indent = 4 + depth * 8;
    if (renamingPath === s.path) {
      return (
        <input
          key={s.path}
          autoFocus
          className="sidebar-search"
          style={{ margin: `2px 0 2px ${indent + 14}px`, padding: '5px 8px', fontSize: 12.5 }}
          value={renameDraft}
          draggable={false}
          onDragStart={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onMouseDown={(e) => e.stopPropagation()}
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
      );
    }
    return (
      <div
        key={s.path}
        className={`session-item ${selection?.sessionPath === s.path ? 'active' : ''}`}
        style={{ marginLeft: indent }}
        onClick={() => {
          onSelect({ cwd: s.cwd || '', sessionPath: s.path });
          if (kids && !kids.open) kids.toggle();
        }}
      >
        {kids ? (
          <button
            className={`sub-chevron ${kids.open ? 'open' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              kids.toggle();
            }}
          >
            <IconChevronRight size={10} />
          </button>
        ) : (
          <span className="sub-chevron-placeholder" />
        )}
        <span className={`status-dot ${s.running ? 'on' : ''}`} />
        <span className="title" title={s.name || s.firstMessage}>{s.name || s.firstMessage || '(空会话)'}</span>
        {kids && <span className="sub-count">{kids.count}</span>}
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
  };

  const renderProjectSessions = (p: ProjectGroup) => {
    const byParent = new Map<string, SessionSummary[]>();
    const tops: SessionSummary[] = [];
    const pathSet = new Set(p.sessions.map((s) => s.path));
    const isSubagent = (s: SessionSummary) => {
      const label = (s.name || s.firstMessage || '').toLowerCase();
      return label.startsWith('subagent');
    };
    for (const s of p.sessions) {
      // Only true subagent sessions nest; forks/clones stay top-level siblings.
      if (s.parentSessionPath && pathSet.has(s.parentSessionPath) && isSubagent(s)) {
        const list = byParent.get(s.parentSessionPath) ?? [];
        list.push(s);
        byParent.set(s.parentSessionPath, list);
      } else {
        tops.push(s);
      }
    }
    // auto-expand the ancestor chain of the selected session
    if (selection?.sessionPath) {
      let cur: SessionSummary | undefined = p.sessions.find((x) => x.path === selection.sessionPath);
      const toOpen: string[] = [];
      while (cur?.parentSessionPath && pathSet.has(cur.parentSessionPath)) {
        toOpen.push(cur.parentSessionPath);
        cur = p.sessions.find((x) => x.path === cur!.parentSessionPath);
      }
      const missing = toOpen.filter((x) => !openParents.has(x));
      if (missing.length > 0) {
        setOpenParents((prev) => {
          const next = new Set(prev);
          for (const x of missing) next.add(x);
          return next;
        });
      }
    }
    const renderNode = (s: SessionSummary, depth: number): React.ReactNode => {
      const kids = byParent.get(s.path) ?? [];
      const open = openParents.has(s.path);
      const toggle = () =>
        setOpenParents((prev) => {
          const next = new Set(prev);
          if (next.has(s.path)) next.delete(s.path);
          else next.add(s.path);
          return next;
        });
      return (
        <div key={s.path}>
          {kids.length > 0
            ? renderSessionRow(s, depth, { count: kids.length, open, toggle })
            : renderSessionRow(s, depth)}
          {kids.length > 0 && open && (
            <div className="subagent-group">{kids.map((k) => renderNode(k, depth + 1))}</div>
          )}
        </div>
      );
    };
    return tops.map((s) => renderNode(s, 0));
  };

  if (collapsed) {
    return (
      <div className="sidebar sidebar-collapsed">
        <div className="sidebar-resize" onMouseDown={onStartDrag} />
        <img className="brand-logo" src="/favicon.png" alt="MewPii" style={{ margin: '2px auto 8px' }} />
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
      <div className="brand-row">
        <img className="brand-logo-wide logo-on-dark" src="/logo-wide-dark.png" alt="MewPii" />
        <img className="brand-logo-wide logo-on-light" src="/logo-wide-light.png" alt="MewPii" />
        <span className="spacer" />
        <button className="btn btn-icon" title={t('collapseSidebar')} onClick={onToggleCollapse}>
          <IconChevronLeft />
        </button>
      </div>
      <div style={{ padding: '0 12px 10px' }}>
        <button className="new-session-btn" onClick={() => onSelect({ cwd: newSessionCwd })}>
          <IconPlus size={15} />
          <span>{t('newSession')}</span>
        </button>
      </div>
      <div className="agent-row">
        {(agents?.length ?? 0) > 0 ? (
          <select
            className="agent-select-wide"
            title={t('agentSelect')}
            value={currentAgent ?? ''}
            onChange={(e) => onSelectAgent?.(e.target.value)}
          >
            <option value="">{t('agentLocal')}</option>
            {agents!.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        ) : (
          <span className="agent-local">{t('agentLocal')}</span>
        )}
      </div>
      <div className="wb-header">
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
        <button className="btn btn-icon" title={t('pickFolder')} onClick={() => setPickerOpen(true)}>
          <IconPlus />
        </button>
      </div>
      {pickerOpen && (
        <DirectoryPicker
          initialPath={newSessionCwd}
          onPick={(cwd) => {
            setPickerOpen(false);
            onSelect({ cwd });
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
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
            <div
              className="project-group"
              key={p.cwd}
              draggable
              onDragStart={(e) => {
                dragCwd.current = p.cwd;
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
              }}
              onDrop={(e) => {
                e.preventDefault();
                const from = dragCwd.current;
                if (!from || from === p.cwd) return;
                setProjectOrder((prev) => {
                  const base = sorted.map((x) => x.cwd).filter((c) => c !== from);
                  const idx = base.indexOf(p.cwd);
                  base.splice(idx === -1 ? base.length : idx, 0, from);
                  persistState(favs, base);
                  return base;
                });
              }}
            >
              <div className="project-header" title={p.cwd} onClick={() => toggleProject(p.cwd)}>
                <IconFolder className={`folder-icon ${fav ? 'fav' : ''}`} />
                <span className="path">{basename(p.cwd)}</span>
                <span className="project-actions" onClick={(e) => e.stopPropagation()}>
                  <button className="btn btn-icon add-btn" title={fav ? t('unpin') : t('pinTop')} onClick={() => toggleFav(p.cwd)}>
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
                  <span className="title" title={s.name || s.firstMessage}>{s.name || s.firstMessage || '(空会话)'}</span>
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
        <div className="footer-row">
          <button className={`btn btn-icon ${view === 'chat' ? 'tab-active' : ''}`} title={t('navChat')} onClick={() => onNavigate('chat')}>
            <IconChat size={15} />
          </button>
          <button className={`btn btn-icon ${view === 'files' ? 'tab-active' : ''}`} title={t('navFiles')} onClick={() => onNavigate('files')}>
            <IconFolder size={15} />
          </button>
          <span style={{ flex: 1 }} />
          <button className="btn btn-icon" title={t('refresh')} onClick={onRefresh}><IconRefresh size={14} /></button>
          <button className="btn btn-icon" title="Language" onClick={() => setLang(getLang() === 'zh' ? 'en' : 'zh')} style={{ fontSize: 12 }}>
            {getLang() === 'zh' ? 'EN' : '中'}
          </button>
          <button className="btn btn-icon" title={dark ? t('toLight') : t('toDark')} onClick={onToggleTheme}>
            {dark ? <IconSun size={14} /> : <IconMoon size={14} />}
          </button>
        </div>
        <div className="footer-row">
          <button className={`btn btn-sm ${view !== 'chat' && view !== 'files' ? 'tab-active' : ''}`} onClick={() => onNavigate('settings')}>{t('navSettings')}</button>
          <span style={{ flex: 1 }} />
          {authRequired && (
            <button
              className="btn btn-icon"
              title={t('logout')}
              onClick={() => {
                void fetch('/api/auth/logout', { method: 'POST' }).then(() => location.assign('/login'));
              }}
            >
              <IconLogout size={13} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
