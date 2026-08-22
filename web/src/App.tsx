import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { Conversation, deleteSession, fetchProjects } from './api';
import type { ProjectGroup } from './types';
import Sidebar from './components/Sidebar';
import ChatView from './components/ChatView';
import ModelsPanel from './components/ModelsPanel';
import FilesPanel from './components/FilesPanel';
import ResourcesPanel from './components/ResourcesPanel';
import SettingsPanel from './components/SettingsPanel';
import { getLang, onLangChange, t } from './i18n';

export interface Selection {
  cwd: string;
  sessionPath?: string;
}

export type View = 'chat' | 'files' | 'models' | 'resources' | 'settings';

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
  if ((view === 'files' || view === 'resources') && cwd) return { view, selection: { cwd } };
  return { view: view === 'chat' && !cwd ? 'chat' : view };
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
  const [route, setRouteState] = useState<Route>(parseHash);
  const [dark, setDark] = useState(() => localStorage.getItem('pii-theme') !== 'light');
  const [, force] = useReducer((x: number) => x + 1, 0);
  const lang = getLang();

  useEffect(() => onLangChange(force), []);

  useEffect(() => {
    document.body.toggleAttribute('data-ds-dark-theme', dark);
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    localStorage.setItem('pii-theme', dark ? 'dark' : 'light');
  }, [dark, lang]);

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
    fetchProjects()
      .then(setProjects)
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

  const defaultCwd = selection?.cwd ?? projects[0]?.cwd ?? '/';

  return (
    <div className="app">
      <Sidebar
        projects={projects}
        selection={route.view === 'chat' ? selection : undefined}
        view={route.view}
        onNavigate={(view) => setRoute({ view, selection: view === 'chat' ? selection : { cwd: defaultCwd } })}
        onSelect={setSelection}
        onDelete={handleDelete}
        onRefresh={refreshProjects}
        dark={dark}
        onToggleTheme={() => setDark((d) => !d)}
      />
      <div className="main">
        {route.view === 'models' && <ModelsPanel />}
        {route.view === 'files' && <FilesPanel key={defaultCwd} cwd={defaultCwd} />}
        {route.view === 'resources' && <ResourcesPanel key={defaultCwd} cwd={defaultCwd} />}
        {route.view === 'settings' && <SettingsPanel dark={dark} onToggleTheme={() => setDark((d) => !d)} />}
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
