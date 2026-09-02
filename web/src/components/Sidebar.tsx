import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { ProjectGroup, SessionSummary } from '../types';
import type { Selection, View } from '../App';
import { setLang, getLang, t } from '../i18n';
import {
  normalizeSessionRename,
  parseStoredStringArray,
} from '../state-utils';
import {
  getUsedSessions,
  resolveUsedSessionTitle,
  subscribeUsedSessions,
} from '../used-sessions';
import DirectoryPicker from './DirectoryPicker';
import {
  IconPlus, IconSearch, IconSettings, IconTrash, IconStar, IconStarFilled,
  IconArchive, IconUnarchive, IconPencil, IconFolder, IconChevronLeft,
  IconChevronRight, IconRefresh, IconSun, IconMoon, IconExport, IconChat, IconLogout,
  IconCheck, IconX,
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
  const [deleteTarget, setDeleteTarget] = useState<SessionSummary>();
  const [showArchived, setShowArchived] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [projectOrder, setProjectOrder] = useState<string[]>([]);
  const dragCwd = useRef<string | undefined>(undefined);
  const importRef = useRef<HTMLInputElement>(null);
  const [openParents, setOpenParents] = useState<Set<string>>(new Set());
  const [favs, setFavs] = useState<string[]>([]);
  const stateVersion = useRef(-1);
  const stateChannel = useRef<BroadcastChannel | undefined>(undefined);

  const applyServerState = useCallback((state: { favorites?: string[]; projectOrder?: string[]; version?: number }) => {
    const version = state.version ?? 0;
    if (version < stateVersion.current) return;
    stateVersion.current = version;
    if (state.favorites) setFavs(state.favorites);
    if (state.projectOrder) setProjectOrder(state.projectOrder);
  }, []);

  const publishState = useCallback((state: { favorites?: string[]; projectOrder?: string[]; version?: number }) => {
    applyServerState(state);
    stateChannel.current?.postMessage(state);
  }, [applyServerState]);

  useEffect(() => {
    const channel = typeof BroadcastChannel === 'undefined'
      ? undefined
      : new BroadcastChannel(`pii-sidebar-state:${currentAgent ?? 'local'}`);
    stateChannel.current = channel;
    if (channel) channel.onmessage = (event: MessageEvent) => applyServerState(event.data as { favorites?: string[]; projectOrder?: string[]; version?: number });
    const controller = new AbortController();
    void fetch('/api/state', { signal: controller.signal })
      .then((r) => r.json())
      .then((d: { favorites?: string[]; projectOrder?: string[]; version?: number }) => {
        if (controller.signal.aborted) return;
        const serverFavs = d.favorites ?? [];
        const serverOrder = d.projectOrder ?? [];
        const legacyFavs = parseStoredStringArray(localStorage.getItem('pii-favs'));
        const legacyOrder = parseStoredStringArray(localStorage.getItem('pii-project-order'));
        const mergedFavs = serverFavs.length ? serverFavs : legacyFavs;
        const mergedOrder = serverOrder.length ? serverOrder : legacyOrder;
        applyServerState({ ...d, favorites: mergedFavs, projectOrder: mergedOrder });
        if (!serverFavs.length && (legacyFavs.length || legacyOrder.length)) {
          void fetch('/api/state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ favorites: mergedFavs, projectOrder: mergedOrder }),
          }).then((response) => response.json()).then(publishState).catch(() => undefined);
        }
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
      channel?.close();
      if (stateChannel.current === channel) stateChannel.current = undefined;
    };
  }, [applyServerState, currentAgent, publishState]);

  const mutateSidebarState = useCallback((path: string, body: Record<string, unknown>) => {
    void fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json();
      })
      .then(publishState)
      .catch(() => {
        void fetch('/api/state').then((response) => response.json()).then(publishState).catch(() => undefined);
      });
  }, [publishState]);

  useEffect(() => {
    localStorage.setItem(OPEN_KEY, JSON.stringify([...openProjects]));
  }, [openProjects]);

  const toggleFav = (cwd: string) => {
    setFavs((prev) => {
      const favorite = !prev.includes(cwd);
      mutateSidebarState('/api/state/favorites', { cwd, favorite });
      return favorite ? [...prev, cwd] : prev.filter((value) => value !== cwd);
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
  const agentOffline = Boolean(currentAgent && !agents?.includes(currentAgent));
  const usedSessions = useSyncExternalStore(
    subscribeUsedSessions,
    getUsedSessions,
    getUsedSessions,
  );
  const runningSessionPaths = useMemo(
    () =>
      new Set(
        projects.flatMap((project) =>
          project.sessions
            .filter((session) => session.running)
            .map((session) => session.path),
        ),
      ),
    [projects],
  );

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
      const renameValue = normalizeSessionRename(renameDraft, s.running);
      const cancelRename = () => setRenamingPath(undefined);
      const submitRename = () => {
        if (!renameValue) return;
        onRename(s.path, renameValue);
        setRenamingPath(undefined);
      };
      return (
        <div
          key={s.path}
          className="session-rename"
          style={{ margin: `2px 0 2px ${indent + 14}px` }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <input
            autoFocus
            className="sidebar-search"
            value={renameDraft}
            disabled={s.running}
            draggable={false}
            aria-label={t('rename')}
            onDragStart={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onChange={(e) => setRenameDraft(e.target.value)}
            onBlur={(e) => {
              const nextFocus = e.relatedTarget as Node | null;
              if (!e.currentTarget.parentElement?.contains(nextFocus)) cancelRename();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submitRename();
              }
              if (e.key === 'Escape') cancelRename();
            }}
          />
          <span className="session-rename-actions">
            <button
              type="button"
              className="btn btn-icon btn-sm"
              title={s.running ? t('renameRunning') : t('save')}
              aria-label={s.running ? t('renameRunning') : t('save')}
              disabled={!renameValue}
              onClick={submitRename}
            >
              <IconCheck size={13} />
            </button>
            <button
              type="button"
              className="btn btn-icon btn-sm"
              title={t('cancel')}
              aria-label={t('cancel')}
              onClick={cancelRename}
            >
              <IconX size={13} />
            </button>
          </span>
        </div>
      );
    }
    return (
      <div
        key={s.path}
        className={`session-item ${selection?.sessionPath === s.path ? 'active' : ''}`}
        style={{ marginLeft: indent }}
        onClick={() => {
          onSelect({ cwd: s.cwd || '', sessionPath: s.path, sessionId: s.id });
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
            title={s.running ? t('renameRunning') : t('rename')}
            aria-label={s.running ? t('renameRunning') : t('rename')}
            disabled={s.running}
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
            onClick={() => setDeleteTarget(s)}
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
        {(agents?.length ?? 0) > 0 || currentAgent ? (
          <select
            className="agent-select-wide"
            title={t('agentSelect')}
            value={currentAgent ?? ''}
            onChange={(e) => onSelectAgent?.(e.target.value)}
          >
            <option value="">{t('agentLocal')}</option>
            {agentOffline && currentAgent && <option value={currentAgent}>{currentAgent} ({t('disconnected')})</option>}
            {(agents ?? []).map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        ) : (
          <span className="agent-local">{t('agentLocal')}</span>
        )}
      </div>
      {usedSessions.length > 0 && (
        <section className="current-work" aria-label={t('currentWork')}>
          <div className="current-work-header">{t('currentWork')}</div>
          <div className="current-work-list">
            {usedSessions.slice(0, 5).map((session) => {
              const active = selection?.sessionPath === session.sessionPath;
              const running = Boolean(
                session.sessionPath && runningSessionPaths.has(session.sessionPath),
              );
              return (
                <button
                  type="button"
                  key={`${session.cwd}|${session.sessionPath ?? ''}`}
                  className={`current-work-item ${active ? 'active' : ''}`}
                  onClick={() =>
                    onSelect({
                      cwd: session.cwd,
                      sessionPath: session.sessionPath,
                      sessionId: session.sessionId,
                    })
                  }
                >
                  <span
                    className={`current-work-dot ${running ? 'running' : active ? 'active' : ''}`}
                    aria-hidden="true"
                  />
                  <span className="current-work-copy">
                    <span className="current-work-title">
                      {resolveUsedSessionTitle(session, projects)}
                    </span>
                    <span className="current-work-project">{basename(session.cwd)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}
      <div className="wb-header">
        <span className="wb-title">{t('workspace')}</span>
        <span className="spacer" />
        <button className="btn btn-icon" title={t('searchSessions')} onClick={() => setSearchOpen((o) => !o)}>
          <IconSearch />
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
                setProjectOrder(() => {
                  const visibleOrder = sorted.map((item) => item.cwd);
                  const base = visibleOrder.filter((cwd) => cwd !== from);
                  const index = base.indexOf(p.cwd);
                  base.splice(index === -1 ? base.length : index, 0, from);
                  mutateSidebarState('/api/state/project-order', { cwd: from, beforeCwd: p.cwd, visibleOrder });
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
                    <button className="btn btn-icon btn-sm" title={t('deleteSession')} onClick={() => setDeleteTarget(s)}>
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
        <button className={`footer-nav-btn ${view === 'chat' ? 'tab-active' : ''}`} title={t('navChat')} onClick={() => onNavigate('chat')}>
          <IconChat size={20} />
          <span>{t('navChat')}</span>
        </button>
        <button className={`footer-nav-btn ${view === 'files' ? 'tab-active' : ''}`} title={t('navFiles')} onClick={() => onNavigate('files')}>
          <IconFolder size={20} />
          <span>{t('navFiles')}</span>
        </button>
        <div className="footer-row">
          <button className={`btn btn-icon ${view !== 'chat' && view !== 'files' ? 'tab-active' : ''}`} title={t('navSettings')} onClick={() => onNavigate('settings')}>
            <IconSettings size={14} />
          </button>
          <span className="build-tag">v0.1.15</span>
          <span style={{ flex: 1 }} />
          <button className="btn btn-icon" title={t('refresh')} onClick={onRefresh}><IconRefresh size={13} /></button>
          <button className="btn btn-icon" title="Language" onClick={() => setLang(getLang() === 'zh' ? 'en' : 'zh')} style={{ fontSize: 11 }}>
            {getLang() === 'zh' ? 'EN' : '中'}
          </button>
          <button className="btn btn-icon" title={dark ? t('toLight') : t('toDark')} onClick={onToggleTheme}>
            {dark ? <IconSun size={13} /> : <IconMoon size={13} />}
          </button>
          {authRequired && (
            <button
              className="btn btn-icon"
              title={t('logout')}
              onClick={() => {
                void fetch('/api/auth/logout', { method: 'POST' }).then(() => location.assign('/login'));
              }}
            >
              <IconLogout size={12} />
            </button>
          )}
        </div>
      </div>
      {deleteTarget &&
        createPortal(
          <div
            className="modal-mask"
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setDeleteTarget(undefined);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setDeleteTarget(undefined);
            }}
          >
            <div className="modal confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-session-title">
              <h3 id="delete-session-title">{t('deleteSession')}</h3>
              <p>{t('confirmDelete')}</p>
              <div className="confirm-modal-session" title={deleteTarget.name || deleteTarget.firstMessage}>
                {deleteTarget.name || deleteTarget.firstMessage || '(空会话)'}
              </div>
              <div className="confirm-modal-actions">
                <button className="btn" onClick={() => setDeleteTarget(undefined)}>{t('cancel')}</button>
                <button
                  className="btn btn-danger"
                  autoFocus
                  onClick={() => {
                    const path = deleteTarget.path;
                    setDeleteTarget(undefined);
                    onDelete(path);
                  }}
                >
                  <IconTrash size={12} /> {t('deleteSession')}
                </button>
              </div>
            </div>
          </div>,
          document.querySelector('.main') ?? document.body,
        )}
    </div>
  );
}
