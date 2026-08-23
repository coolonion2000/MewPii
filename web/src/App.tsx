import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { Conversation, deleteSession, fetchProjects } from './api';
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
}

function parseHash(): Route {
  const m = location.hash.match(/^#\/([a-z]+)(?:\?(.+))?$/);
  const view = (m?.[1] as View) || 'chat';
  const params = new URLSearchParams(m?.[2] ?? '');
  const cwd = params.get('cwd');
  const session = params.get('session');
  if (view === 'chat' && cwd) return { view, selection: { cwd, sessionPath: session ?? undefined } };
  if ((view === 'files' || view === 'skills' || view === 'extensions' || view === 'models') && cwd)
    return { view, selection: { cwd } };
  return { view };
}

function toHash(route: Route): string {
  const params = new URLSearchParams();
  if (route.selection?.cwd) params.set('cwd', route.selection.cwd);
  if (route.selection?.sessionPath) params.set('session', route.selection.sessionPath);
  const qs = params.toString();
  return `#/${route.view}${qs ? `?${qs}` : ''}`;
}

export default function App() {
  const [projects, setProjects] = useState<ProjectGroup[]>([]);
  const [archivedSessions, setArchivedSessions] = useState<SessionSummary[]>([]);
  const [route, setRouteState] = useState<Route>(parseHash);
  const [dark, setDark] = useState(() => localStorage.getItem('pii-theme') !== 'light');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('pii-sidebar') === 'collapsed',
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
    history.replaceState(null, '', toHash(r));
  }, []);

  const setSelection = useCallback(
    (s: Selection | undefined) => setRoute({ view: 'chat', selection: s }),
    [setRoute],
  );

  useEffect(() => {
    const onHash = () => setRouteState(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
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
    refreshProjects();
    const timer = setInterval(refreshProjects, 15_000);
    return () => clearInterval(timer);
  }, [refreshProjects]);

  const selection = route.selection;
  // One Conversation per selection; keep the instance stable while selected.
  const conv = useMemo(() => {
    if (route.view !== 'chat' || !selection) return undefined;
    const c = new Conversation(selection.cwd, selection.sessionPath);
    c.connect();
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.view, selection?.cwd, selection?.sessionPath]);

  useEffect(() => (conv ? conv.subscribe(force) : undefined), [conv]);
  useEffect(() => () => conv?.dispose(), [conv]);

  // Refresh the sidebar when a run finishes (titles/mtimes change).
  useEffect(() => {
    if (conv && !conv.snapshot?.isStreaming) refreshProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conv?.snapshot?.isStreaming, conv?.snapshot?.sessionFile]);

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

  const defaultCwd = selection?.cwd ?? projects[0]?.cwd ?? '/';
  const isSettingsish = route.view === 'settings' || route.view === 'models' || route.view === 'skills' || route.view === 'extensions';

  return (
    <div className="app">
      <Sidebar
        projects={projects}
        archivedSessions={archivedSessions}
        selection={route.view === 'chat' ? selection : undefined}
        view={route.view}
        collapsed={sidebarCollapsed}
        onToggleCollapse={toggleCollapse}
        onNavigate={(view) =>
          setRoute({
            view,
            selection: view === 'chat' || view === 'files' ? selection : { cwd: defaultCwd },
          })
        }
        onSelect={setSelection}
        onDelete={handleDelete}
        onRename={handleRename}
        onArchive={handleArchive}
        onRefresh={refreshProjects}
        dark={dark}
        onToggleTheme={() => setDark((d) => !d)}
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
                  onClick={() => setRoute({ view: tab as View, selection: { cwd: defaultCwd } })}
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
            <ChatView key={`${selection?.cwd}|${selection?.sessionPath ?? 'new'}`} conv={conv} onRefresh={refreshProjects} />
          ) : (
            <div className="empty-state">
              <div className="big">pii</div>
              <div>{t('selectOrNew')}</div>
            </div>
          ))}
      </div>
    </div>
  );
}
