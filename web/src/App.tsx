import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  Conversation,
  deleteSession,
  fetchProjects,
  getAgent,
  setAgent,
} from "./api";
import { addUsedSession } from "./used-sessions";
import { conversationDraftKey, getComposerDraft, setComposerDraft } from "./draft-store";
import { reconcileConversationBinding } from "./conversation-identity";
import type { ProjectGroup, SessionSummary } from "./types";
import {
  acceptsGeneration,
  appRoutePath,
  createGenerationGate,
  initialCwd,
  parseAppRoute,
  parseStoredSelection,
  sameOrderedStrings,
  sessionIdFromPath,
  shouldRefreshSessionCatalog,
  type AppRoute,
  type AppView,
  type SessionCatalogRefreshState,
  type SelectionState,
} from "./state-utils";
import Sidebar from "./components/Sidebar";
import ChatView from "./components/ChatView";
import ErrorBoundary from "./components/ErrorBoundary";
import { getLang, onLangChange, t } from "./i18n";
import {
  sidebarResizeStep,
  type SidebarDragPhase,
} from "./ui-reliability";

const ModelsPanel = lazy(() => import("./components/ModelsPanel"));
const FilesPanel = lazy(() => import("./components/FilesPanel"));
const TerminalPanel = lazy(() => import("./components/TerminalPanel"));
const SkillsPanel = lazy(() => import("./components/SkillsPanel"));
const ExtensionsPanel = lazy(() => import("./components/ExtensionsPanel"));
const SettingsPanel = lazy(() => import("./components/SettingsPanel"));

export type Selection = SelectionState;
export type View = AppView;
type Route = AppRoute;

const LAST_CWD_KEY = "pii-last-cwd";
const LAST_SESSION_KEY = "pii-last-session";

function normalizeSelection(selection: Selection | undefined): Selection | undefined {
  if (!selection?.sessionPath || selection.sessionId) return selection;
  return { ...selection, sessionId: sessionIdFromPath(selection.sessionPath) };
}

function rememberSession(selection: Selection | undefined): void {
  if (!selection?.sessionPath) {
    localStorage.removeItem(LAST_SESSION_KEY);
    return;
  }
  localStorage.setItem(LAST_SESSION_KEY, JSON.stringify(normalizeSelection(selection)));
}

function PanelLoading() {
  return (
    <div className="session-loading" role="status">
      <span className="working-dot" aria-hidden="true" />
      <span>{t("loadingSession")}</span>
    </div>
  );
}

/** Clean path routes: /chat/<sessionId>, /chat, /files, /settings|models|skills|extensions. */
function parsePath(): Route {
  const route = parseAppRoute(location.pathname, location.hash);
  if (
    route.view === "chat" &&
    !route.selection &&
    !route.pendingSessionId &&
    /^\/chat\/?$/.test(location.pathname)
  ) {
    route.selection = parseStoredSelection(localStorage.getItem(LAST_SESSION_KEY));
  }
  if (location.hash.startsWith("#/"))
    history.replaceState(null, "", appRoutePath(route));
  return route;
}

export default function App() {
  const [projects, setProjects] = useState<ProjectGroup[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [agents, setAgents] = useState<string[]>([]);
  const [archivedSessions, setArchivedSessions] = useState<SessionSummary[]>(
    [],
  );
  const [route, setRouteState] = useState<Route>(parsePath);
  const [terminalContext, setTerminalContext] = useState<{ cwd: string; agent?: string }>();
  const [terminalVisible, setTerminalVisible] = useState(false);
  const [filesCwd, setFilesCwd] = useState<string>();
  const appAgent = useMemo(() => getAgent(), []);
  const resolveGeneration = useRef(0);
  const projectsGeneration = useMemo(() => createGenerationGate(), []);
  const projectsController = useRef<AbortController | undefined>(undefined);
  const sidebarDragCleanup = useRef<(() => void) | undefined>(undefined);
  const [dark, setDark] = useState(
    () => localStorage.getItem("pii-theme") !== "light",
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem("pii-sidebar") === "collapsed",
  );
  const [sidebarWidth, setSidebarWidth] = useState(
    () => Number(localStorage.getItem("pii-sidebar-w")) || 240,
  );
  const [, force] = useReducer((x: number) => x + 1, 0);
  const lang = getLang();

  useEffect(() => onLangChange(force), []);

  useEffect(() => {
    document.body.toggleAttribute("data-ds-dark-theme", dark);
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    localStorage.setItem("pii-theme", dark ? "dark" : "light");
  }, [dark, lang]);

  const toggleCollapse = useCallback(() => {
    setSidebarCollapsed((c) => {
      localStorage.setItem("pii-sidebar", c ? "open" : "collapsed");
      return !c;
    });
  }, []);

  const setRoute = useCallback((route: Route) => {
    const next = route.selection
      ? { ...route, selection: normalizeSelection(route.selection) }
      : route;
    setRouteState(next);
    if (next.selection?.cwd)
      localStorage.setItem(LAST_CWD_KEY, next.selection.cwd);
    if (next.view === "chat") rememberSession(next.selection);
    history.replaceState(null, "", appRoutePath(next));
  }, []);

  const setSelection = useCallback(
    (s: Selection | undefined) => {
      if (s && (s.sessionPath || s.sessionId)) {
        const summary = projects.find((project) => project.cwd === s.cwd)?.sessions.find(
          (session) => session.path === s.sessionPath || session.id === s.sessionId,
        );
        addUsedSession({
          agent: appAgent,
          cwd: s.cwd,
          sessionPath: s.sessionPath,
          sessionId: s.sessionId,
          title: summary?.name || summary?.firstMessage || '(新会话)',
        }, { reopen: true });
      }
      setRoute({ view: "chat", selection: s });
    },
    [setRoute, projects, appAgent],
  );

  useEffect(() => {
    const onPop = () => setRouteState(parsePath());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const refreshProjects = useCallback(() => {
    projectsController.current?.abort();
    const controller = new AbortController();
    const generation = projectsGeneration.next();
    projectsController.current = controller;
    void fetchProjects(controller.signal, true)
      .then((allProjects) => {
        if (!projectsGeneration.accepts(generation, controller.signal.aborted)) return;
        setProjects(
          allProjects
            .map((project) => ({
              ...project,
              sessions: project.sessions.filter((session) => !session.archived),
            }))
            .filter((project) => project.sessions.length > 0),
        );
        setArchivedSessions(
          allProjects
            .flatMap((project) => project.sessions)
            .filter((session) => session.archived),
        );
        setProjectsLoaded(true);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setProjectsLoaded(true);
          console.error("[sessions] refresh failed", cause);
        }
      });
  }, [projectsGeneration]);

  useEffect(() => {
    fetch("/api/auth/state")
      .then((r) => r.json())
      .then((d: { authRequired?: boolean }) =>
        setAuthRequired(Boolean(d.authRequired)),
      )
      .catch(() => undefined);
    let agentTimer: ReturnType<typeof setTimeout> | undefined;
    let agentController: AbortController | undefined;
    let agentGeneration = 0;
    const scheduleAgents = () => {
      clearTimeout(agentTimer);
      if (!document.hidden)
        agentTimer = setTimeout(() => void loadAgents(), 15_000);
    };
    const loadAgents = async () => {
      if (document.hidden) return;
      agentController?.abort();
      const controller = new AbortController();
      const generation = ++agentGeneration;
      agentController = controller;
      try {
        const response = await fetch("/api/agents", {
          signal: controller.signal,
        });
        const data = (await response.json()) as { agents?: string[] };
        if (controller.signal.aborted || generation !== agentGeneration) return;
        const nextAgents = data.agents ?? [];
        setAgents((current) =>
          sameOrderedStrings(current, nextAgents) ? current : nextAgents,
        );
        // Keep a selected-but-offline agent explicit. Silently switching to
        // local or another remote would open the wrong workspace/session.
      } catch {
        // Hidden tabs abort their request; visibility restoration reloads it.
      } finally {
        if (generation === agentGeneration) scheduleAgents();
      }
    };
    void loadAgents();
    refreshProjects();
    // poll a cheap version counter; refetch only when the sessions dir changed
    let lastVersion = -1;
    let pollInFlight = false;
    const poll = async () => {
      if (document.hidden || pollInFlight) return;
      pollInFlight = true;
      try {
        const r = await fetch("/api/sessions/version");
        const d = (await r.json()) as { version: number };
        if (lastVersion !== -1 && d.version !== lastVersion) refreshProjects();
        lastVersion = d.version;
      } catch {
        // ignore
      } finally {
        pollInFlight = false;
      }
    };
    void poll();
    const timer = setInterval(poll, 8_000);
    // also refresh immediately when the tab regains focus (you may have used pi CLI)
    const onVisible = () => {
      if (document.hidden) {
        clearTimeout(agentTimer);
        agentGeneration += 1;
        agentController?.abort();
        return;
      }
      void poll();
      void loadAgents();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      projectsController.current?.abort();
      clearTimeout(agentTimer);
      agentGeneration += 1;
      agentController?.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [refreshProjects]);

  const selection = route.selection;

  // Resolve /chat/<id> links to a concrete session file.
  useEffect(() => {
    const id = route.pendingSessionId;
    if (!id) return;
    const generation = ++resolveGeneration.current;
    const controller = new AbortController();
    void fetch(`/api/sessions/resolve?id=${encodeURIComponent(id)}`, {
      signal: controller.signal,
    })
      .then((response) => {
        if (response.status === 404) return undefined;
        if (!response.ok) throw new Error(`resolve session: ${response.status}`);
        return response.json();
      })
      .then((d: {
        cwd?: string;
        path?: string;
        id?: string;
        live?: boolean;
      } | undefined) => {
        if (
          !acceptsGeneration(
            resolveGeneration.current,
            generation,
            controller.signal.aborted,
          )
        )
          return;
        setRouteState((current) => {
          if (current.pendingSessionId !== id) return current;
          if (d?.cwd && (d.path || d.live)) {
            localStorage.setItem(LAST_CWD_KEY, d.cwd);
            const resolved = {
              cwd: d.cwd,
              sessionPath: d.path || undefined,
              sessionId: d.id ?? id,
            };
            rememberSession(resolved);
            return { view: "chat", selection: resolved };
          }
          return { view: "chat" };
        });
      })
      .catch((cause) => {
        if (
          !acceptsGeneration(
            resolveGeneration.current,
            generation,
            controller.signal.aborted,
          )
        )
          return;
        setRouteState((current) =>
          current.pendingSessionId === id ? { view: "chat" } : current,
        );
        if (!(cause instanceof DOMException && cause.name === "AbortError"))
          console.error("[route] resolve failed", cause);
      });
    return () => controller.abort();
  }, [route.pendingSessionId]);

  const createConversation = (next: Selection, agent: string | undefined) =>
    new Conversation(next.cwd, next.sessionPath, agent, next.sessionId);
  const [conversationBinding, setConversationBinding] = useState(() =>
    reconcileConversationBinding(undefined, selection, appAgent, createConversation),
  );
  const nextBinding = reconcileConversationBinding(
    conversationBinding, selection, appAgent, createConversation,
  );
  // Adjust this component's state before commit, without connecting in render.
  // Preview canonicalization and /new follow the existing host; user switches
  // replace it. View-only changes retain the same connection and notices.
  if (nextBinding !== conversationBinding) setConversationBinding(nextBinding);
  const conv = nextBinding.conversation;

  // Connect after React commits so ChatView can subscribe before the first
  // snapshot arrives. Connecting during render can lose a fast initial frame.
  useEffect(() => {
    if (!conv) return;
    conv.connect();
    return () => conv.dispose();
  }, [conv]);

  useEffect(() => {
    if (!conv) return;
    return conv.subscribe(() => { if (conv.quitRequested) setSelection(undefined); });
  }, [conv, setSelection]);

  // Follow host-side session changes and persist a canonical refresh route.
  useEffect(() => {
    if (route.view !== "chat" || !selection) return;
    const file = conv?.snapshot?.sessionFile;
    if (!file) return;
    const id = conv?.snapshot?.sessionId ?? sessionIdFromPath(file);
    const next = { cwd: conv?.snapshot?.cwd ?? selection.cwd, sessionPath: file, sessionId: id };
    if (selection.sessionPath !== file || selection.sessionId !== id) {
      setRouteState((current) => current.selection === selection
        ? { ...current, selection: next }
        : current,
      );
    }
    rememberSession(next);
    if (id && !location.pathname.endsWith(`/${id}`))
      history.replaceState(null, "", `/chat/${id}`);
  }, [
    route.view,
    selection,
    conv?.snapshot?.sessionFile,
    conv?.snapshot?.sessionId,
  ]);

  // App-level conv subscription: only re-render on meaningful transitions
  // (stream start/stop, first message, session file change) — never per delta.
  useEffect(() => {
    if (!conv) return;
    let prevStreaming = conv.snapshot?.isStreaming;
    let prevCount = conv.snapshot?.messages.length ?? conv.messages.length;
    let prevFile = conv.snapshot?.sessionFile;
    let prevName = conv.snapshot?.name;
    let recordedSignature: string | undefined;
    const recordUsedSession = () => {
      const firstUser = conv.messages.find((message) => message.role === "user");
      if (!firstUser) return;
      const firstText =
        typeof firstUser.content === "string"
          ? firstUser.content
          : Array.isArray(firstUser.content)
            ? ((firstUser.content as { type?: string; text?: string }[]).find(
                (block) => block.type === "text",
              )?.text ?? "")
            : "";
      const file = conv.snapshot?.sessionFile ?? conv.sessionPath;
      const title = conv.snapshot?.name || firstText.slice(0, 40) || "(新会话)";
      const signature = [
        conv.snapshot?.cwd ?? conv.cwd,
        file ?? "",
        conv.snapshot?.sessionId ?? "",
        title,
      ].join("|");
      if (signature === recordedSignature) return;
      recordedSignature = signature;
      addUsedSession({
        agent: conv.agent,
        cwd: conv.snapshot?.cwd ?? conv.cwd,
        sessionPath: file,
        sessionId: conv.snapshot?.sessionId,
        title,
      });
    };
    recordUsedSession();
    return conv.subscribe(() => {
      const streaming = conv.snapshot?.isStreaming;
      const count = conv.snapshot?.messages.length ?? conv.messages.length;
      const file = conv.snapshot?.sessionFile;
      const name = conv.snapshot?.name;
      // Enrich the shortcut when the session gains a message, path or name.
      // Explicit sidebar selection adds it immediately, before hydration.
      if ((prevCount === 0 && count > 0) || file !== prevFile || name !== prevName)
        recordUsedSession();
      if (
        streaming !== prevStreaming ||
        (prevCount === 0 && count > 0) ||
        file !== prevFile
      ) {
        prevStreaming = streaming;
        prevCount = count;
        prevFile = file;
        force();
      } else {
        prevCount = count;
      }
      prevName = name;
    });
  }, [conv]);

  // Refresh the sidebar when a run finishes, when the session file is
  // assigned, and when the first message lands (new session appears).
  const msgCount =
    conv?.snapshot?.messages.length ?? conv?.messages.length ?? 0;
  const catalogRefreshState = useRef<{
    conversation?: Conversation;
    snapshot?: SessionCatalogRefreshState;
  }>({});
  useEffect(() => {
    const next = conv?.snapshot
      ? {
          messageCount: msgCount,
          isStreaming: conv.snapshot.isStreaming,
          sessionFile: conv.snapshot.sessionFile,
        }
      : undefined;
    const previous = catalogRefreshState.current;
    catalogRefreshState.current = { conversation: conv, snapshot: next };
    if (
      previous.conversation === conv &&
      shouldRefreshSessionCatalog(previous.snapshot, next)
    )
      refreshProjects();
  }, [
    conv,
    msgCount,
    conv?.snapshot?.isStreaming,
    conv?.snapshot?.sessionFile,
    refreshProjects,
  ]);

  const handleDelete = useCallback(
    (path: string) => {
      // optimistic: remove instantly; failures refetch authoritative state so
      // concurrent updates from another tab are never replaced by an old array.
      setProjects(
        projects
          .map((g) => ({
            ...g,
            sessions: g.sessions.filter((s) => s.path !== path),
          }))
          .filter((g) => g.sessions.length > 0),
      );
      setArchivedSessions(archivedSessions.filter((s) => s.path !== path));
      if (selection?.sessionPath === path) setRoute({ view: "chat" });
      deleteSession(path)
        .then(() => refreshProjects())
        .catch(refreshProjects);
    },
    [projects, archivedSessions, selection, refreshProjects, setRoute],
  );

  const handleRename = useCallback(
    (path: string, name: string) => {
      // optimistic: apply locally first; failure refetches instead of restoring
      // a stale whole-list snapshot.
      const apply = (list: ProjectGroup[]) =>
        list.map((g) => ({
          ...g,
          sessions: g.sessions.map((s) =>
            s.path === path ? { ...s, name } : s,
          ),
        }));
      setProjects(apply(projects));
      setArchivedSessions(
        archivedSessions.map((s) => (s.path === path ? { ...s, name } : s)),
      );
      fetch("/api/sessions/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, name }),
      })
        .then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          refreshProjects();
        })
        .catch(refreshProjects);
    },
    [projects, archivedSessions, refreshProjects],
  );

  const handleArchive = useCallback(
    (path: string, archived: boolean) => {
      // optimistic: move immediately; authoritative refetch compensates failure.
      if (archived) {
        let moved: SessionSummary | undefined;
        setProjects(
          projects
            .map((g) => {
              const keep = g.sessions.filter((s) => {
                if (s.path === path) moved = s;
                return s.path !== path;
              });
              return { ...g, sessions: keep };
            })
            .filter((g) => g.sessions.length > 0),
        );
        if (moved)
          setArchivedSessions([
            { ...moved, archived: true },
            ...archivedSessions,
          ]);
      } else {
        const moved = archivedSessions.find((s) => s.path === path);
        setArchivedSessions(archivedSessions.filter((s) => s.path !== path));
        if (moved) {
          setProjects(
            projects.map((g) =>
              g.cwd === moved.cwd
                ? {
                    ...g,
                    sessions: [{ ...moved, archived: false }, ...g.sessions],
                  }
                : g,
            ),
          );
        }
      }
      if (archived && selection?.sessionPath === path)
        setRoute({ view: "chat" });
      fetch("/api/sessions/archive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, archived }),
      })
        .then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          refreshProjects();
        })
        .catch(refreshProjects);
    },
    [projects, archivedSessions, selection, refreshProjects, setRoute],
  );

  const startSidebarDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      sidebarDragCleanup.current?.();
      const handle = e.currentTarget;
      const sidebar = handle.closest<HTMLElement>(".sidebar");
      if (!sidebar) return;
      const pointerId = e.pointerId;
      const startX = e.clientX;
      const startW = sidebarCollapsed ? 46 : sidebarWidth;
      let clientX = startX;
      let frame = 0;
      let done = false;
      let phase: SidebarDragPhase = sidebarCollapsed
        ? "may-expand"
        : "may-collapse";
      let result = sidebarResizeStep(phase, startW);
      const renderWidth = () => {
        frame = 0;
        sidebar.style.width = `${result.width}px`;
      };
      const onMove = (event: PointerEvent) => {
        if (event.pointerId !== pointerId) return;
        clientX = event.clientX;
        result = sidebarResizeStep(phase, startW + clientX - startX);
        phase = result.phase;
        if (!frame) frame = requestAnimationFrame(renderWidth);
      };
      const removeListeners = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("blur", onBlur);
        handle.removeEventListener("lostpointercapture", onCancel);
        if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
        document.body.classList.remove("is-resizing");
        sidebarDragCleanup.current = undefined;
      };
      const finish = (event?: PointerEvent) => {
        if (done || (event && event.pointerId !== pointerId)) return;
        done = true;
        if (event) {
          clientX = event.clientX;
          result = sidebarResizeStep(phase, startW + clientX - startX);
          phase = result.phase;
        }
        if (frame) cancelAnimationFrame(frame);
        sidebar.style.width = `${result.width}px`;
        setSidebarCollapsed(result.collapsed);
        localStorage.setItem(
          "pii-sidebar",
          result.collapsed ? "collapsed" : "open",
        );
        if (!result.collapsed) {
          setSidebarWidth(result.width);
          localStorage.setItem("pii-sidebar-w", String(Math.round(result.width)));
        }
        removeListeners();
      };
      const onBlur = () => finish();
      const onCancel = (event: PointerEvent) => {
        if (event.pointerId === pointerId) finish();
      };
      sidebarDragCleanup.current = () => {
        if (done) return;
        done = true;
        if (frame) cancelAnimationFrame(frame);
        removeListeners();
      };
      document.body.classList.add("is-resizing");
      handle.setPointerCapture?.(pointerId);
      window.addEventListener("pointermove", onMove, { passive: true });
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("blur", onBlur);
      handle.addEventListener("lostpointercapture", onCancel);
    },
    [sidebarCollapsed, sidebarWidth],
  );

  useEffect(() => () => sidebarDragCleanup.current?.(), []);

  const handleNavigate = useCallback(
    (view: View) => setRoute({ view, selection }),
    [selection, setRoute],
  );
  const handleToggleTheme = useCallback(() => setDark((value) => !value), []);
  const handleSelectAgent = useCallback(
    (name: string) => setAgent(name || undefined),
    [],
  );
  const handleForked = useCallback(
    (cwd: string, sessionFile: string, sessionId?: string) =>
      setRoute({
        view: "chat",
        selection: { cwd, sessionPath: sessionFile, sessionId },
      }),
    [setRoute],
  );
  const handleSelectProject = useCallback(
    (cwd: string) => setSelection({ cwd }),
    [setSelection],
  );

  const defaultCwd = selection?.cwd ?? projects[0]?.cwd ?? "/";
  const isSettingsish =
    route.view === "settings" ||
    route.view === "models" ||
    route.view === "skills" ||
    route.view === "extensions";

  return (
    <div className="app">
      <Sidebar
        projects={projects}
        archivedSessions={archivedSessions}
        selection={route.view === "chat" ? selection : undefined}
        view={route.view}
        collapsed={sidebarCollapsed}
        width={sidebarWidth}
        onStartDrag={startSidebarDrag}
        onToggleCollapse={toggleCollapse}
        // Keep the chat selection intact when visiting settings/files so
        // coming back to chat restores the same conversation.
        onNavigate={handleNavigate}
        onSelect={setSelection}
        onDelete={handleDelete}
        onRename={handleRename}
        onArchive={handleArchive}
        onRefresh={refreshProjects}
        dark={dark}
        onToggleTheme={handleToggleTheme}
        authRequired={authRequired}
        agents={agents}
        currentAgent={appAgent}
        onSelectAgent={handleSelectAgent}
        loading={!projectsLoaded}
        terminalVisible={terminalVisible}
        onToggleTerminal={() => {
          if (!terminalContext) setTerminalContext({ cwd: route.view === 'files' ? filesCwd || defaultCwd : defaultCwd, agent: appAgent });
          setTerminalVisible(value => !value);
        }}
      />
      <div className="main-workspace">
      <div className="main">
        {isSettingsish && (
          <div className="unified-settings">
            <div className="us-rail">
              <div className="us-rail-title">{t("settingsNavTitle")}</div>
              {(
                [
                  ["general", t("tabGeneral")],
                  ["models", t("tabModels")],
                  ["skills", t("tabSkills")],
                  ["extensions", t("tabExtensions")],
                ] as const
              ).map(([tab, label]) => (
                <button
                  key={tab}
                  className={`us-tab ${
                    (route.view === "settings" && tab === "general") ||
                    (route.view === "models" && tab === "models") ||
                    (route.view === "skills" && tab === "skills") ||
                    (route.view === "extensions" && tab === "extensions")
                      ? "active"
                      : ""
                  }`}
                  onClick={() =>
                    setRoute({
                      view: (tab === "general" ? "settings" : tab) as View,
                      selection,
                    })
                  }
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="us-panel">
              <Suspense fallback={<PanelLoading />}>
                {route.view === "settings" && (
                  <SettingsPanel
                    dark={dark}
                    onToggleTheme={handleToggleTheme}
                  />
                )}
                {route.view === "models" && <ModelsPanel />}
                {route.view === "skills" && (
                  <SkillsPanel key={defaultCwd} cwd={defaultCwd} />
                )}
                {route.view === "extensions" && (
                  <ExtensionsPanel key={defaultCwd} cwd={defaultCwd} />
                )}
              </Suspense>
            </div>
          </div>
        )}
        {route.view === "files" && (
          <Suspense fallback={<PanelLoading />}>
            <FilesPanel key={defaultCwd} cwd={defaultCwd} projects={projects.map(project => project.cwd)}
              onCwdChange={setFilesCwd}
              onReference={(path) => {
                const target = selection ?? { cwd: defaultCwd };
                const key = conversationDraftKey(getAgent(), target.cwd, target.sessionPath);
                const previous = getComposerDraft(key) ?? { text: '', images: [] };
                setComposerDraft(key, { ...previous, text: `${previous.text}${previous.text ? '\n\n' : ''}${JSON.stringify(path)}` });
                setRoute({ view: 'chat', selection: target });
              }} />
          </Suspense>
        )}
        {route.view === "chat" &&
          (route.pendingSessionId ? (
            <div className="session-loading" role="status">
              <span className="working-dot" aria-hidden="true" />
              <span>{t("loadingSession")}</span>
            </div>
          ) : conv ? (
            <ErrorBoundary
              key={`chat:${conv.agent ?? "local"}|${conv.cwd}|${conv.sessionPath ?? conv.requestedSessionId ?? "new"}`}
              className="chat-render-error"
            >
              <ChatView
                conv={conv}
                onRefresh={refreshProjects}
                onForked={handleForked}
                projects={projects}
                onSelectProject={handleSelectProject}
                dark={dark}
                language={lang}
              />
            </ErrorBoundary>
          ) : !projectsLoaded ? (
            <PanelLoading />
          ) : (
            <HeroLanding projects={projects} onSelect={setSelection} />
          ))}
      </div>
      {terminalContext && <Suspense fallback={null}>
        <TerminalPanel cwd={terminalContext.cwd} agent={terminalContext.agent} visible={terminalVisible} dark={dark}
          onHide={() => setTerminalVisible(false)} onClose={() => { setTerminalContext(undefined); setTerminalVisible(false); }} />
      </Suspense>}
      </div>
    </div>
  );
}

/** Landing view after login: jump straight into a new session (hero), no picker. */
function HeroLanding({
  projects,
  onSelect,
}: {
  projects: ProjectGroup[];
  onSelect: (s: Selection) => void;
}) {
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    const cwd = initialCwd(
      projects.map((project) => project.cwd),
      localStorage.getItem(LAST_CWD_KEY),
    );
    if (!cwd) return;
    done.current = true;
    onSelect({ cwd });
  }, [projects, onSelect]);
  return null;
}
