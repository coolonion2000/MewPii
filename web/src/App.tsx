import {
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
import type { ProjectGroup, SessionSummary } from "./types";
import {
  acceptsGeneration,
  appRoutePath,
  createGenerationGate,
  initialCwd,
  parseAppRoute,
  parseStoredSelection,
  sessionIdFromPath,
  type AppRoute,
  type AppView,
  type SelectionState,
} from "./state-utils";
import Sidebar from "./components/Sidebar";
import ChatView from "./components/ChatView";
import ModelsPanel from "./components/ModelsPanel";
import FilesPanel from "./components/FilesPanel";
import SkillsPanel from "./components/SkillsPanel";
import ExtensionsPanel from "./components/ExtensionsPanel";
import SettingsPanel from "./components/SettingsPanel";
import { getLang, onLangChange, t } from "./i18n";

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
  const [authRequired, setAuthRequired] = useState(false);
  const [agents, setAgents] = useState<string[]>([]);
  const [archivedSessions, setArchivedSessions] = useState<SessionSummary[]>(
    [],
  );
  const [route, setRouteState] = useState<Route>(parsePath);
  const appAgent = useMemo(() => getAgent(), []);
  const resolveGeneration = useRef(0);
  const projectsGeneration = useMemo(() => createGenerationGate(), []);
  const projectsController = useRef<AbortController | undefined>(undefined);
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
    (s: Selection | undefined) => setRoute({ view: "chat", selection: s }),
    [setRoute],
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
    void Promise.all([
      fetchProjects(controller.signal),
      fetch("/api/sessions?includeArchived=1", { signal: controller.signal })
        .then((response) => {
          if (!response.ok) throw new Error(`archived sessions: ${response.status}`);
          return response.json() as Promise<{ projects: ProjectGroup[] }>;
        }),
    ])
      .then(([nextProjects, archived]) => {
        if (!projectsGeneration.accepts(generation, controller.signal.aborted)) return;
        setProjects(nextProjects);
        setArchivedSessions(
          archived.projects.flatMap((project) => project.sessions).filter((session) => session.archived),
        );
      })
      .catch((cause) => {
        if (!controller.signal.aborted) console.error("[sessions] refresh failed", cause);
      });
  }, [projectsGeneration]);

  useEffect(() => {
    fetch("/api/auth/state")
      .then((r) => r.json())
      .then((d: { authRequired?: boolean }) =>
        setAuthRequired(Boolean(d.authRequired)),
      )
      .catch(() => undefined);
    const loadAgents = () =>
      fetch("/api/agents")
        .then((r) => r.json())
        .then((d: { agents?: string[] }) => {
          const list = d.agents ?? [];
          setAgents(list);
          // Keep a selected-but-offline agent explicit. Silently switching to
          // local or another remote would open the wrong workspace/session.
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
        const r = await fetch("/api/sessions/version");
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
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      projectsController.current?.abort();
      clearInterval(agentTimer);
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
        if (!response.ok) throw new Error(`resolve session: ${response.status}`);
        return response.json();
      })
      .then((d: { cwd?: string; path?: string; id?: string }) => {
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
          if (d.cwd && d.path) {
            localStorage.setItem(LAST_CWD_KEY, d.cwd);
            const resolved = {
              cwd: d.cwd,
              sessionPath: d.path,
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

  const effectiveSelection = selection;

  // One Conversation per chat selection. View changes keep it alive and never
  // create a new host; only cwd/session/agent identity may replace it.
  const conv = useMemo(() => {
    if (!effectiveSelection?.cwd) return undefined;
    return new Conversation(
      effectiveSelection.cwd,
      effectiveSelection.sessionPath,
      appAgent,
    );
  }, [effectiveSelection?.cwd, effectiveSelection?.sessionPath, appAgent]);

  // Connect after React commits so ChatView can subscribe before the first
  // snapshot arrives. Connecting during render can lose a fast initial frame.
  useEffect(() => {
    if (!conv) return;
    conv.connect();
    return () => conv.dispose();
  }, [conv]);

  // Follow host-side session changes and persist a canonical refresh route.
  useEffect(() => {
    if (route.view !== "chat" || !selection) return;
    const file = conv?.snapshot?.sessionFile;
    if (!file) return;
    const id = conv?.snapshot?.sessionId ?? sessionIdFromPath(file);
    const next = { cwd: selection.cwd, sessionPath: file, sessionId: id };
    if (selection.sessionPath !== file || selection.sessionId !== id) {
      setRouteState((current) => ({ ...current, selection: next }));
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
    return conv.subscribe(() => {
      const streaming = conv.snapshot?.isStreaming;
      const count = conv.snapshot?.messages.length ?? conv.messages.length;
      const file = conv.snapshot?.sessionFile;
      // record "used in this tab" when a user message lands (title from the
      // session itself: name or first user text, never the latest message)
      const msgs = conv.messages;
      if (count > 0 && msgs.some((m) => m.role === "user")) {
        const firstUser = msgs.find((m) => m.role === "user");
        const firstText = firstUser
          ? typeof firstUser.content === "string"
            ? firstUser.content
            : Array.isArray(firstUser.content)
              ? ((firstUser.content as { type?: string; text?: string }[]).find(
                  (b) => b.type === "text",
                )?.text ?? "")
              : ""
          : "";
        addUsedSession({
          cwd: conv.snapshot?.cwd ?? conv.cwd,
          sessionPath: file ?? conv.sessionPath,
          sessionId: conv.snapshot?.sessionId,
          title: conv.snapshot?.name || firstText.slice(0, 40) || "(新会话)",
        });
      }
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
    });
  }, [conv]);

  // Refresh the sidebar when a run finishes, when the session file is
  // assigned, and when the first message lands (new session appears).
  const msgCount =
    conv?.snapshot?.messages.length ?? conv?.messages.length ?? 0;
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
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = sidebarCollapsed ? 46 : sidebarWidth;
      // One-way transitions per drag: expanded drags may only collapse, and a
      // collapsed rail may only expand — never oscillate around the threshold.
      let phase: "expanded" | "collapsed" = sidebarCollapsed
        ? "collapsed"
        : "expanded";
      let width = startW;
      const onMove = (ev: MouseEvent) => {
        const raw = startW + ev.clientX - startX;
        if (phase === "expanded") {
          if (raw < 110) {
            phase = "collapsed";
            toggleCollapse();
            return;
          }
          width = Math.min(480, Math.max(170, raw));
          setSidebarWidth(width);
        } else if (raw > 170) {
          phase = "expanded";
          toggleCollapse();
          width = Math.min(480, Math.max(170, raw));
          setSidebarWidth(width);
        }
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        localStorage.setItem(
          "pii-sidebar-w",
          String(Math.max(170, Math.min(480, width))),
        );
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [sidebarCollapsed, sidebarWidth, toggleCollapse],
  );

  const defaultCwd = effectiveSelection?.cwd ?? projects[0]?.cwd ?? "/";
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
        currentAgent={appAgent}
        onSelectAgent={(name) => setAgent(name || undefined)}
      />
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
              {route.view === "settings" && (
                <SettingsPanel
                  dark={dark}
                  onToggleTheme={() => setDark((d) => !d)}
                />
              )}
              {route.view === "models" && <ModelsPanel />}
              {route.view === "skills" && (
                <SkillsPanel key={defaultCwd} cwd={defaultCwd} />
              )}
              {route.view === "extensions" && (
                <ExtensionsPanel key={defaultCwd} cwd={defaultCwd} />
              )}
            </div>
          </div>
        )}
        {route.view === "files" && (
          <FilesPanel key={defaultCwd} cwd={defaultCwd} />
        )}
        {route.view === "chat" &&
          (route.pendingSessionId ? (
            <div className="session-loading" role="status">
              <span className="working-dot" aria-hidden="true" />
              <span>{t("loadingSession")}</span>
            </div>
          ) : conv ? (
            <ChatView
              key={`${effectiveSelection?.cwd}|${effectiveSelection?.sessionPath ?? "new"}`}
              conv={conv}
              onRefresh={refreshProjects}
              onForked={(cwd, sessionFile, sessionId) =>
                setRoute({
                  view: "chat",
                  selection: { cwd, sessionPath: sessionFile, sessionId },
                })
              }
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
