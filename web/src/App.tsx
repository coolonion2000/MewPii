import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Conversation, deleteSession, fetchProjects, getAgent, setAgent } from './api';
import { addUsedSession } from './used-sessions';
import type { ProjectGroup, SessionSummary } from './types';
import Sidebar from './components/Sidebar';
import ChatView from './components/ChatView';
import ModelsPanel from './components/ModelsPanel';
import FilesPanel from './components/FilesPanel';
import SkillsPanel from './components/SkillsPanel';
import ExtensionsPanel from './components/ExtensionsPanel';
import SettingsPanel from './components/SettingsPanel';
import { getLang, onLangChange, t } from './i18n';

export interface Selection {
  cwd: string;
  sessionPath?: string;
}

export type View = 'chat' | 'files' | 'models' | 'skills' | 'extensions' | 'settings';

interface Route {
  view: View;
  selection?: Selection;
  /** Set when landing on /chat/<id> before the id is resolved to a file. */
  pendingSessionId?: string;
}

const LAST_CWD_KEY = 'pii-last-cwd';

/** Clean path routes: /chat/<sessionId>, /chat, /files, /settings|models|skills|extensions. */
function parsePath(): Route {
  const path = location.pathname;
  // legacy hash links → translate once
  const legacy = location.hash.match(/^#\/([a-z]+)(?:\?(.+))?$/);
  if (legacy) {
    const view = (legacy[1] as View) || 'chat';
    const params = new URLSearchParams(legacy[2] ?? '');
    const cwd = params.get('cwd');
    const session = params.get('session');
    history.replaceState(null, '', '/');
    if (view === 'chat' && cwd) return { view, selection: { cwd, sessionPath: session ?? undefined } };
    return { view: view === 'chat' ? 'chat' : view, selection: cwd ? { cwd } : undefined };
  }
  const m = path.match(/^\/chat\/([0-9a-f-]{8,})$/);
  if (m) return { view: 'chat', selection: { cwd: '', sessionPath: undefined }, pendingSessionId: m[1] } as Route;
  if (path === '/chat') return { view: 'chat' };
  if (path === '/files') return { view: 'files' };
  if (path === '/models') return { view: 'models' };
  if (path === '/skills') return { view: 'skills' };
  if (path === '/extensions') return { view: 'extensions' };
  if (path === '/settings') return { view: 'settings' };
  return { view: 'chat' };
}

function toPath(route: Route, sessionId?: string): string {
  if (route.view === 'chat') {
    if (sessionId) return `/chat/${sessionId}`;
    return '/chat';
  }
  return `/${route.view}`;
}

export default function App() {
  const [projects, setProjects] = useState<ProjectGroup[]>([]);
  const [authRequired, setAuthRequired] = useState(false);
  const [agents, setAgents] = useState<string[]>([]);
  const [archivedSessions, setArchivedSessions] = useState<SessionSummary[]>([]);
  const [route, setRouteState] = useState<Route>(parsePath);
  const [dark, setDark] = useState(() => localStorage.getItem('pii-theme') !== 'light');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('pii-sidebar') === 'collapsed',
  );
  const [sidebarWidth, setSidebarWidth] = useState(
    () => Number(localStorage.getItem('pii-sidebar-w')) || 240,
  );
  const [, force] = useReducer((x: number) => x + 1, 0);
  const lang = getLang();

  useEffect(() => onLangChange(force), []);

  useEffect(() => {
    document.body.toggleAttribute('data-ds-dark-theme', dark);
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    localStorage.setItem('pii-theme', dark ? 'dark' : 'light');
  }, [dark, lang]);

  const toggleCollapse = useCallback(() => {
    setSidebarCollapsed((c) => {
      localStorage.setItem('pii-sidebar', c ? 'open' : 'collapsed');
      return !c;
    });
  }, []);

  const setRoute = useCallback((r: Route) => {
    setRouteState(r);
    if (r.selection?.cwd) localStorage.setItem(LAST_CWD_KEY, r.selection.cwd);
    // session id is appended once the session file is known (see effect below)
    history.replaceState(null, '', toPath(r));
  }, []);

  const setSelection = useCallback(
    (s: Selection | undefined) => setRoute({ view: 'chat', selection: s }),
    [setRoute],
  );

  useEffect(() => {
    const onPop = () => setRouteState(parsePath());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const refreshProjects = useCallback(() => {
    fetchProjects().then(setProjects).catch(() => undefined);
    fetch('/api/sessions/archive')
      .then((r) => r.json())
      .then(async (d: { archived: string[] }) => {
        if (!d.archived?.length) {
          setArchivedSessions([]);
          return;
        }
        const all = await fetchProjects(); // cheap enough; refetch with flag instead
        void all;
      })
      .catch(() => undefined);
    // archived list with details:
    fetch('/api/sessions?includeArchived=1')
      .then((r) => r.json())
      .then((d: { projects: ProjectGroup[] }) => {
        const flat = d.projects.flatMap((p) => p.sessions).filter((s) => s.archived);
        setArchivedSessions(flat);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    fetch('/api/auth/state').then((r) => r.json()).then((d: { authRequired?: boolean }) => setAuthRequired(Boolean(d.authRequired))).catch(() => undefined);
    const loadAgents = () =>
      fetch('/api/agents')
        .then((r) => r.json())
        .then((d: { agents?: string[] }) => {
          const list = d.agents ?? [];
          setAgents(list);
          // a previously selected agent that is no longer connected must not
          // 502 the whole UI — silently fall back to local mode
          const stored = getAgent();
          if (stored && !list.includes(stored)) {
            localStorage.removeItem('pii-agent');
            refreshProjects();
          }
        })
        .catch(() => undefined);
    loadAgents();
    const agentTimer = setInterval(loadAgents, 15_000);
    refreshProjects();
    // poll a cheap version counter; refetch only when the sessions dir changed
    let lastVersion = -1;
    const poll = async () => {
      if (document.hidden) return;
      try {
        const r = await fetch('/api/sessions/version');
        const d = (await r.json()) as { version: number };
        if (lastVersion !== -1 && d.version !== lastVersion) refreshProjects();
        lastVersion = d.version;
      } catch {
        // ignore
      }
    };
    void poll();
    const timer = setInterval(poll, 8_000);
    // also refresh immediately when the tab regains focus (you may have used pi CLI)
    const onVisible = () => {
      if (!document.hidden) {
        void poll();
        refreshProjects();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [refreshProjects]);

  const selection = route.selection;

  // Resolve /chat/<id> links to a concrete session file.
  useEffect(() => {
    const id = route.pendingSessionId;
    if (!id) return;
    fetch(`/api/sessions/resolve?id=${encodeURIComponent(id)}`)
      .then((r) => r.json())
      .then((d: { cwd?: string; path?: string }) => {
        if (d.cwd && d.path) {
          setRouteState({ view: 'chat', selection: { cwd: d.cwd, sessionPath: d.path } });
        } else {
          setRouteState({ view: 'chat' });
        }
      })
      .catch(() => setRouteState({ view: 'chat' }));
  }, [route.pendingSessionId]);

  // New sessions start in the last used directory.
  const effectiveSelection: Selection | undefined = selection?.cwd
    ? selection
    : selection && route.view === 'chat'
      ? { ...selection, cwd: localStorage.getItem(LAST_CWD_KEY) ?? projects[0]?.cwd ?? '/' }
      : selection;

  // One Conversation per selection; keep the instance stable while selected.
  const conv = useMemo(() => {
    if (route.view !== 'chat' || !effectiveSelection?.cwd) return undefined;
    const c = new Conversation(effectiveSelection.cwd, effectiveSelection.sessionPath);
    c.connect();
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.view, effectiveSelection?.cwd, effectiveSelection?.sessionPath]);

  useEffect(() => () => conv?.dispose(), [conv]);

  // When the host switches session files (newSession / fork / import), follow it:
  // otherwise navigating away and back would reconnect to the OLD session.
  useEffect(() => {
    const file = conv?.snapshot?.sessionFile;
    if (!file || !selection) return;
    if (selection.sessionPath && selection.sessionPath !== file) {
      setRouteState((prev) =>
        prev.view === 'chat' && prev.selection
          ? { view: 'chat', selection: { cwd: prev.selection.cwd, sessionPath: file } }
          : prev,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conv?.snapshot?.sessionFile]);

  // Keep the address bar clean: /chat/<sessionId> once the file is known.
  useEffect(() => {
    if (route.view !== 'chat') return;
    const file = conv?.snapshot?.sessionFile;
    if (!file) return;
    const m = file.match(/_([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/);
    const id = m?.[1] ?? conv?.snapshot?.sessionId;
    if (id && !location.pathname.endsWith(`/${id}`)) {
      history.replaceState(null, '', `/chat/${id}`);
    }
  }, [route.view, conv?.snapshot?.sessionFile, conv?.snapshot?.sessionId]);

  // App-level conv subscription: only re-render on meaningful transitions
  // (stream start/stop, first message, session file change) — never per delta.
  useEffect(() => {
    if (!conv) return;
    let prevStreaming = conv.snapshot?.isStreaming;
    let prevCount = conv.snapshot?.messages.length ?? conv.messages.length;
    let prevFile = conv.snapshot?.sessionFile;
    return conv.subscribe(() => {
      const streaming = conv.snapshot?.isStreaming;
      const count = conv.snapshot?.messages.length ?? conv.messages.length;
      const file = conv.snapshot?.sessionFile;
      // record "used in this tab" when a user message lands (title from the
      // session itself: name or first user text, never the latest message)
      const msgs = conv.messages;
      if (count > 0 && msgs.some((m) => m.role === 'user')) {
        const firstUser = msgs.find((m) => m.role === 'user');
        const firstText = firstUser
          ? typeof firstUser.content === 'string'
            ? firstUser.content
            : Array.isArray(firstUser.content)
              ? (firstUser.content as { type?: string; text?: string }[]).find((b) => b.type === 'text')?.text ?? ''
              : ''
          : '';
        addUsedSession({
          cwd: conv.snapshot?.cwd ?? conv.cwd,
          sessionPath: file ?? conv.sessionPath,
          title: conv.snapshot?.name || firstText.slice(0, 40) || '(新会话)',
        });
      }
      if (streaming !== prevStreaming || (prevCount === 0 && count > 0) || file !== prevFile) {
        prevStreaming = streaming;
        prevCount = count;
        prevFile = file;
        force();
      } else {
        prevCount = count;
      }
    });
  }, [conv]);

  // Refresh the sidebar when a run finishes, when the session file is
  // assigned, and when the first message lands (new session appears).
  const msgCount = conv?.snapshot?.messages.length ?? conv?.messages.length ?? 0;
  const prevCount = useRef(0);
  useEffect(() => {
    const count = msgCount;
    const wasEmpty = prevCount.current === 0;
    prevCount.current = count;
    if ((wasEmpty && count > 0) || (conv && !conv.snapshot?.isStreaming)) {
      refreshProjects();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msgCount, conv?.snapshot?.isStreaming, conv?.snapshot?.sessionFile]);

  const handleDelete = useCallback(
    async (path: string) => {
      await deleteSession(path).catch(() => undefined);
      if (selection?.sessionPath === path) setRoute({ view: 'chat' });
      refreshProjects();
    },
    [selection, refreshProjects, setRoute],
  );

  const handleRename = useCallback(
    async (path: string, name: string) => {
      await fetch('/api/sessions/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, name }),
      }).catch(() => undefined);
      refreshProjects();
    },
    [refreshProjects],
  );

  const handleArchive = useCallback(
    async (path: string, archived: boolean) => {
      await fetch('/api/sessions/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, archived }),
      }).catch(() => undefined);
      if (archived && selection?.sessionPath === path) setRoute({ view: 'chat' });
      refreshProjects();
    },
    [selection, refreshProjects, setRoute],
  );

  const startSidebarDrag = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = sidebarCollapsed ? 46 : sidebarWidth;
      // One-way transitions per drag: expanded drags may only collapse, and a
      // collapsed rail may only expand — never oscillate around the threshold.
      let phase: 'expanded' | 'collapsed' = sidebarCollapsed ? 'collapsed' : 'expanded';
      let width = startW;
      const onMove = (ev: MouseEvent) => {
        const raw = startW + ev.clientX - startX;
        if (phase === 'expanded') {
          if (raw < 110) {
            phase = 'collapsed';
            toggleCollapse();
            return;
          }
          width = Math.min(480, Math.max(170, raw));
          setSidebarWidth(width);
        } else {
          if (raw > 170) {
            phase = 'expanded';
            toggleCollapse();
            width = Math.min(480, Math.max(170, raw));
            setSidebarWidth(width);
          }
        }
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        localStorage.setItem('pii-sidebar-w', String(Math.max(170, Math.min(480, width))));
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [sidebarCollapsed, sidebarWidth, toggleCollapse],
  );

  const defaultCwd = effectiveSelection?.cwd ?? projects[0]?.cwd ?? '/';
  const isSettingsish = route.view === 'settings' || route.view === 'models' || route.view === 'skills' || route.view === 'extensions';

  return (
    <div className="app">
      <Sidebar
        projects={projects}
        archivedSessions={archivedSessions}
        selection={route.view === 'chat' ? selection : undefined}
        view={route.view}
        collapsed={sidebarCollapsed}
        width={sidebarWidth}
        onStartDrag={startSidebarDrag}
        onToggleCollapse={toggleCollapse}
        onNavigate={(view) =>
          // keep the chat selection intact when visiting settings/files so
          // coming back to chat restores the same conversation
          setRoute({ view, selection })
        }
        onSelect={setSelection}
        onDelete={handleDelete}
        onRename={handleRename}
        onArchive={handleArchive}
        onRefresh={refreshProjects}
        dark={dark}
        onToggleTheme={() => setDark((d) => !d)}
        authRequired={authRequired}
        agents={agents}
        currentAgent={getAgent()}
        onSelectAgent={(name) => setAgent(name || undefined)}
      />
      <div className="main">
        {isSettingsish && (
          <div className="unified-settings">
            <div className="us-rail">
              <div className="us-rail-title">{t('settingsNavTitle')}</div>
              {(
                [
                  ['general', t('tabGeneral')],
                  ['models', t('tabModels')],
                  ['skills', t('tabSkills')],
                  ['extensions', t('tabExtensions')],
                ] as const
              ).map(([tab, label]) => (
                <button
                  key={tab}
                  className={`us-tab ${
                    (route.view === 'settings' && tab === 'general') ||
                    (route.view === 'models' && tab === 'models') ||
                    (route.view === 'skills' && tab === 'skills') ||
                    (route.view === 'extensions' && tab === 'extensions')
                      ? 'active'
                      : ''
                  }`}
                  onClick={() => setRoute({ view: (tab === 'general' ? 'settings' : tab) as View, selection: { cwd: defaultCwd } })}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="us-panel">
              {route.view === 'settings' && <SettingsPanel dark={dark} onToggleTheme={() => setDark((d) => !d)} />}
              {route.view === 'models' && <ModelsPanel />}
              {route.view === 'skills' && <SkillsPanel key={defaultCwd} cwd={defaultCwd} />}
              {route.view === 'extensions' && <ExtensionsPanel key={defaultCwd} cwd={defaultCwd} />}
            </div>
          </div>
        )}
        {route.view === 'files' && <FilesPanel key={defaultCwd} cwd={defaultCwd} />}
        {route.view === 'chat' &&
          (conv ? (
            <ChatView
              key={`${effectiveSelection?.cwd}|${effectiveSelection?.sessionPath ?? 'new'}`}
              conv={conv}
              onRefresh={refreshProjects}
              onForked={(cwd, sessionFile) => setRoute({ view: 'chat', selection: { cwd, sessionPath: sessionFile } })}
              projects={projects}
              onSelectProject={(cwd) => setSelection({ cwd })}
            />
          ) : (
            <HeroLanding projects={projects} onSelect={setSelection} />
          ))}
      </div>
    </div>
  );
}


/** Landing view after login: jump straight into a new session (hero), no picker. */
function HeroLanding({ projects, onSelect }: { projects: ProjectGroup[]; onSelect: (s: Selection) => void }) {
  const done = useRef(false);
  useEffect(() => {
    if (done.current || projects.length === 0) return;
    done.current = true;
    const cwd = localStorage.getItem(LAST_CWD_KEY) ?? projects[0]?.cwd ?? '/';
    onSelect({ cwd });
  }, [projects, onSelect]);
  return null;
}
