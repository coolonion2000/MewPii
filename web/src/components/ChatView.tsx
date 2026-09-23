import {
  Fragment,
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Conversation, ToolActivity } from "../api";
import MessageItem from "./MessageItem";
import ToolCard from "./ToolCard";
import Composer from "./Composer";
import StatsBar from "./StatsBar";
import ProviderActivity from "./ProviderActivity";
import { followChatTail } from "../chat-tail-follow";
import { filePreviewState } from "../file-preview-state";
import RunsChip, { type RunInfo } from "./RunsChip";
import SubagentPanel from "./SubagentPanel";
import ErrorBoundary from "./ErrorBoundary";
import { SubagentContext, useSubagentStore } from "../subagent-store";
import { IconFolder, IconChevronDown, IconMore, IconLs, IconGitFork, IconCompress, IconExport } from "../icons";
import ExtensionUI, {
  EditorWidgets,
  InlineQuestions,
  TranscriptNoticeView,
} from "./ExtensionUI";
import { IconTrash, IconPencil, IconX } from "../icons";
import type { PiiMessage, ProjectGroup, SessionSnapshot } from "../types";
import {
  calculateLiveOutputMetrics,
  messageTimelineKey,
  shouldShowDisconnected,
} from "../state-utils";
import {
  clampResizeWidth,
  collectToolCallIds,
  hasConversationHistory,
  orphanRunningTools,
  validContentBlocks,
} from "../ui-reliability";
import {
  armCompletionSound,
  playCompletionSound,
  shouldPlayCompletionSound,
} from "../completion-sound";
import { t } from "../i18n";

const Trajectory = lazy(() => import("./Trajectory"));
const FilePreview = lazy(() => import("./FilePreview"));
const SubagentRunDialog = lazy(() => import("./SubagentRunDialog"));

interface Props {
  conv: Conversation;
  onRefresh: () => void;
  onForked?: (cwd: string, sessionFile: string, sessionId?: string) => void;
  projects?: ProjectGroup[];
  onSelectProject?: (cwd: string) => void;
  dark: boolean;
  language: string;
}

function ChatView({
  conv,
  onRefresh,
  onForked,
  projects,
  onSelectProject,
  dark,
  language,
}: Props) {
  const [, force] = useReducer((x: number) => x + 1, 0);
  // React rechecks the revision after subscribing, so even a snapshot arriving
  // between render and commit cannot leave this view on stale empty state.
  useSyncExternalStore(conv.subscribe, conv.getRevision, conv.getRevision);

  const runIsStreaming = Boolean(conv.snapshot?.isStreaming);
  const completionStateRef = useRef({
    conversation: conv,
    isStreaming: runIsStreaming,
  });
  useEffect(() => {
    const arm = () => {
      armCompletionSound();
      window.removeEventListener("pointerdown", arm);
      window.removeEventListener("keydown", arm);
    };
    window.addEventListener("pointerdown", arm);
    window.addEventListener("keydown", arm);
    return () => {
      window.removeEventListener("pointerdown", arm);
      window.removeEventListener("keydown", arm);
    };
  }, []);
  useEffect(() => {
    const previous = completionStateRef.current;
    if (
      previous.conversation === conv &&
      shouldPlayCompletionSound(
        previous.isStreaming,
        runIsStreaming,
        document.visibilityState,
        document.hasFocus(),
      )
    ) {
      playCompletionSound();
    }
    completionStateRef.current = {
      conversation: conv,
      isStreaming: runIsStreaming,
    };
  }, [conv, runIsStreaming]);

  // 1s ticker while streaming so the live t/s decays smoothly between deltas
  useEffect(() => {
    if (!conv.snapshot?.isStreaming) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (document.hidden) return;
      timer = setTimeout(() => {
        force();
        schedule();
      }, 1000);
    };
    const onVisibility = () => schedule();
    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [conv.snapshot?.isStreaming]);
  const tailFollowerRef = useRef<ReturnType<typeof followChatTail> | undefined>(
    undefined,
  );
  const previewDragCleanup = useRef<(() => void) | undefined>(undefined);
  const widthDragCleanup = useRef<(() => void) | undefined>(undefined);
  const [showJump, setShowJump] = useState(false);
  const [contentWidth, setContentWidth] = useState(
    () => Number(localStorage.getItem("pii-chat-w")) || 800,
  );

  const startWidthDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      widthDragCleanup.current?.();
      const handle = e.currentTarget;
      const dir = handle.classList.contains("right") ? -1 : 1;
      const pointerId = e.pointerId;
      const startX = e.clientX;
      const startW = contentWidth;
      let clientX = startX;
      let clientY = e.clientY;
      let frame = 0;
      let done = false;
      // Centered column grows on both sides. Left handle widens when dragged left,
      // right handle widens when dragged right; dir flips the sign accordingly.
      const widthForPointer = () =>
        clampResizeWidth(
          startW + (startX - clientX) * dir * 2,
          480,
          Math.max(480, window.innerWidth - 96),
        );
      const renderWidth = () => {
        frame = 0;
        document.documentElement.style.setProperty(
          "--chat-content-width",
          `${widthForPointer()}px`,
        );
        const rect = handle.getBoundingClientRect();
        handle.style.setProperty("--handle-y", `${clientY - rect.top}px`);
      };
      const onMove = (event: PointerEvent) => {
        if (event.pointerId !== pointerId) return;
        clientX = event.clientX;
        clientY = event.clientY;
        if (!frame) frame = requestAnimationFrame(renderWidth);
      };
      const removeListeners = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("blur", onBlur);
        handle.removeEventListener("lostpointercapture", onCancel);
        if (handle.hasPointerCapture?.(pointerId))
          handle.releasePointerCapture(pointerId);
        document.body.classList.remove("is-resizing");
        handle.classList.remove("dragging");
        widthDragCleanup.current = undefined;
      };
      const finish = (event?: PointerEvent) => {
        if (done || (event && event.pointerId !== pointerId)) return;
        done = true;
        if (event) clientX = event.clientX;
        if (frame) cancelAnimationFrame(frame);
        const width = widthForPointer();
        document.documentElement.style.setProperty(
          "--chat-content-width",
          `${width}px`,
        );
        localStorage.setItem("pii-chat-w", String(Math.round(width)));
        removeListeners();
        setContentWidth(width);
      };
      const onBlur = () => finish();
      const onCancel = (event: PointerEvent) => {
        if (event.pointerId === pointerId) finish();
      };
      widthDragCleanup.current = () => {
        if (done) return;
        done = true;
        if (frame) cancelAnimationFrame(frame);
        removeListeners();
      };
      document.body.classList.add("is-resizing");
      handle.classList.add("dragging");
      handle.setPointerCapture?.(pointerId);
      window.addEventListener("pointermove", onMove, { passive: true });
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("blur", onBlur);
      handle.addEventListener("lostpointercapture", onCancel);
    },
    [contentWidth],
  );

  useEffect(() => {
    document.documentElement.style.setProperty(
      "--chat-content-width",
      `${contentWidth}px`,
    );
  }, [contentWidth]);

  const bindScroll = useCallback(
    (node: HTMLDivElement | null) => {
      tailFollowerRef.current?.dispose();
      tailFollowerRef.current = undefined;
      const content = node?.querySelector<HTMLElement>(".chat-column");
      if (node && content)
        tailFollowerRef.current = followChatTail(node, content, (following) =>
          setShowJump(!following),
        );
    },
    [conv, conv.snapshot?.sessionId],
  );
  const [showTraj, setShowTraj] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsRef = useRef<HTMLDivElement>(null);
  useEffect(() => setActionsOpen(false), [conv]);
  useEffect(() => {
    if (!actionsOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!actionsRef.current?.contains(event.target as Node)) setActionsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActionsOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [actionsOpen]);
  const [draft, setDraft] = useState<string>();
  const [previewPath, setPreviewPath] = useState<string>();
  const previewState = useMemo(
    () =>
      filePreviewState(
        conv.snapshot?.cwd ?? conv.cwd,
        previewPath,
        conv.tools,
        conv.messages,
        conv.streaming,
      ),
    [
      previewPath,
      conv.tools,
      conv.messages,
      conv.streaming,
      conv.cwd,
      conv.snapshot?.cwd,
    ],
  );
  const subagents = useSubagentStore(conv.snapshot?.sessionFile);
  const subagentContext = useMemo(
    () => ({
      ...subagents,
      open: (id: string) => {
        setPreviewPath(undefined);
        subagents.open(id);
      },
    }),
    [subagents],
  );
  const [projMenuOpen, setProjMenuOpen] = useState(false);
  useEffect(() => {
    if (!projMenuOpen) return;
    const close = () => setProjMenuOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [projMenuOpen]);
  const [previewWidth, setPreviewWidth] = useState(
    () => Number(localStorage.getItem("pii-preview-w")) || 480,
  );

  const startPreviewDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      previewDragCleanup.current?.();
      const handle = e.currentTarget;
      const pane =
        handle.parentElement?.querySelector<HTMLElement>(".file-preview-pane");
      if (!pane) return;
      const pointerId = e.pointerId;
      const startX = e.clientX;
      const startW = previewWidth;
      let clientX = startX;
      let frame = 0;
      let done = false;
      const widthForPointer = () =>
        clampResizeWidth(
          startW + (startX - clientX),
          280,
          Math.max(280, window.innerWidth * 0.75),
        );
      const renderWidth = () => {
        frame = 0;
        pane.style.width = `${widthForPointer()}px`;
      };
      const onMove = (event: PointerEvent) => {
        if (event.pointerId !== pointerId) return;
        clientX = event.clientX;
        if (!frame) frame = requestAnimationFrame(renderWidth);
      };
      const removeListeners = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("blur", onBlur);
        handle.removeEventListener("lostpointercapture", onCancel);
        if (handle.hasPointerCapture?.(pointerId))
          handle.releasePointerCapture(pointerId);
        document.body.classList.remove("is-resizing");
        tailFollowerRef.current?.resume();
        previewDragCleanup.current = undefined;
      };
      const finish = (event?: PointerEvent) => {
        if (done || (event && event.pointerId !== pointerId)) return;
        done = true;
        if (event) clientX = event.clientX;
        if (frame) cancelAnimationFrame(frame);
        const width = widthForPointer();
        pane.style.width = `${width}px`;
        localStorage.setItem("pii-preview-w", String(Math.round(width)));
        removeListeners();
        setPreviewWidth(width);
      };
      const onBlur = () => finish();
      const onCancel = (event: PointerEvent) => {
        if (event.pointerId === pointerId) finish();
      };
      previewDragCleanup.current = () => {
        if (done) return;
        done = true;
        if (frame) cancelAnimationFrame(frame);
        removeListeners();
      };
      tailFollowerRef.current?.pause();
      document.body.classList.add("is-resizing");
      handle.setPointerCapture?.(pointerId);
      window.addEventListener("pointermove", onMove, { passive: true });
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("blur", onBlur);
      handle.addEventListener("lostpointercapture", onCancel);
    },
    [previewWidth],
  );

  useEffect(
    () => () => {
      previewDragCleanup.current?.();
      widthDragCleanup.current?.();
    },
    [],
  );
  const snap = conv.snapshot;

  const baseMessages = useMemo<PiiMessage[]>(
    () => [
      ...conv.messages.filter((message): message is PiiMessage =>
        Boolean(message && typeof message === "object"),
      ),
      ...conv.optimistic
        .map((item) => item.message)
        .filter((message): message is PiiMessage =>
          Boolean(message && typeof message === "object"),
        ),
    ],
    [conv.messages, conv.optimistic],
  );
  const { messageKeys, renderKeys, occurrences } = useMemo(() => {
    const anchors: string[] = [];
    const unique: string[] = [];
    const counts = new Map<string, number>();
    for (let index = 0; index < baseMessages.length; index++) {
      const base = messageTimelineKey(baseMessages[index], index);
      const occurrence = counts.get(base) ?? 0;
      counts.set(base, occurrence + 1);
      anchors.push(base);
      unique.push(occurrence === 0 ? base : `${base}:occurrence:${occurrence}`);
    }
    return { messageKeys: anchors, renderKeys: unique, occurrences: counts };
  }, [baseMessages]);
  const streamingMessage =
    conv.streaming && typeof conv.streaming === "object"
      ? conv.streaming
      : undefined;
  const streamingMessageKey = streamingMessage
    ? messageTimelineKey(streamingMessage, baseMessages.length)
    : undefined;
  const streamingRenderKey = streamingMessageKey
    ? `${streamingMessageKey}:stream:${occurrences.get(streamingMessageKey) ?? 0}`
    : undefined;
  const finalizedToolCallIds = useMemo(
    () => collectToolCallIds(baseMessages),
    [baseMessages],
  );
  const orphanTools = useMemo(
    () =>
      orphanRunningTools(
        conv.tools,
        finalizedToolCallIds,
        streamingMessage?.content,
      ),
    [conv.tools, finalizedToolCallIds, streamingMessage?.content],
  );
  const { noticesBeforeMessages, noticesByMessage } = useMemo(() => {
    const before = conv.transcriptNotices.filter(
      (notice) => notice.afterMessageKey === undefined,
    );
    const byMessage = new Map<string, typeof conv.transcriptNotices>();
    for (const notice of conv.transcriptNotices) {
      if (!notice.afterMessageKey) continue;
      const existing = byMessage.get(notice.afterMessageKey) ?? [];
      byMessage.set(notice.afterMessageKey, [...existing, notice]);
    }
    return { noticesBeforeMessages: before, noticesByMessage: byMessage };
  }, [conv.transcriptNotices]);

  // toolCallId → toolResult message
  const toolResults = useMemo(() => {
    const results = new Map<string, PiiMessage>();
    for (const message of conv.messages) {
      if (message.role === "toolResult")
        results.set(String(message.toolCallId), message);
    }
    return results;
  }, [conv.messages]);

  const title = useMemo(
    () => snap?.name || firstUserText(baseMessages) || "新会话",
    [baseMessages, snap?.name],
  );
  const handleFork = useCallback(
    (entryId: string) => {
      void conv
        .send({ type: "fork", entryId })
        .then((data) => {
          onRefresh();
          const file = data?.sessionFile as string | undefined;
          if (file && onForked) onForked(conv.snapshot?.cwd ?? conv.cwd, file);
          else conv.toast(t("forkFailed"), "error");
        })
        .catch((cause) =>
          conv.reportError(
            cause instanceof Error ? cause.message : String(cause),
          ),
        );
    },
    [conv, onForked, onRefresh],
  );
  const handleBranch = useCallback(
    (entryId: string) => {
      void conv
        .send({ type: "branch", entryId })
        .then((data) => {
          const text = data?.editorText as string | undefined;
          if (text) setDraft(text);
          else conv.toast(t("branchedHere"));
          tailFollowerRef.current?.jumpToBottom();
        })
        .catch((cause) =>
          conv.reportError(
            cause instanceof Error ? cause.message : String(cause),
          ),
        );
    },
    [conv],
  );
  const handleOpenFile = useCallback(
    (path: string) => {
      subagents.close();
      setPreviewPath(path);
    },
    [subagents.close],
  );
  const handleClosePreview = useCallback(() => setPreviewPath(undefined), []);
  const handleExport = useCallback(() => {
    void import("../export")
      .then(({ exportHtml }) =>
        exportHtml(title, conv.snapshot?.cwd ?? conv.cwd, conv.messages),
      )
      .catch((cause) =>
        conv.reportError(
          cause instanceof Error ? cause.message : String(cause),
        ),
      );
  }, [conv, title]);

  useEffect(() => {
    document.title = `MewPii - ${title}`;
    return () => {
      document.title = "MewPii";
    };
  }, [title]);

  // This is deliberately a plain derived value rather than a hook: existing
  // sessions return a loading placeholder until their first snapshot, and all
  // hooks must run in the same order before and after that snapshot arrives.
  const hasHistory = hasConversationHistory(
    baseMessages,
    conv.historyFrom,
    conv.totalMessages,
  );

  // Existing sessions should show a loading state until their first snapshot;
  // rendering the new-session hero here makes a successful refresh look empty.
  if (!snap && (conv.sessionPath || conv.requestedSessionId)) {
    return (
      <div className="session-loading" role={conv.error ? "alert" : "status"}>
        {!conv.error && <span className="working-dot" aria-hidden="true" />}
        <span>
          {conv.error
            ? `${conv.reconnecting ? t("reconnecting") : t("disconnected")} ${conv.error}`
            : t("loadingSession")}
        </span>
      </div>
    );
  }

  // custom/system injections (e.g. ADHD ruleset) don't count as conversation
  if (!hasHistory && !conv.snapshot?.isStreaming && !conv.compaction) {
    return (
      <>
        <div className="hero">
          <img
            className="hero-logo-wide"
            src={dark ? "/logo-wide-dark.png" : "/logo-wide-light.png"}
            alt="MewPii"
          />
          <div className="hero-sub">{t("heroTagline")}</div>
          <div className="hero-chips">
            <div className="menu-anchor">
              <button
                className="model-chip"
                onClick={(e) => {
                  e.stopPropagation();
                  setProjMenuOpen(!projMenuOpen);
                }}
              >
                <IconFolder size={13} />
                <span className="model-chip-name">
                  {(conv.cwd || projects?.[0]?.cwd || "/")
                    .split("/")
                    .filter(Boolean)
                    .pop()}
                </span>
                <IconChevronDown size={11} />
              </button>
              {projMenuOpen && (
                <div
                  className="menu menu-down"
                  onClick={(e) => e.stopPropagation()}
                >
                  {(projects ?? []).map((p) => (
                    <button
                      key={p.cwd}
                      className={`menu-item proj-item ${conv.cwd === p.cwd ? "active" : ""}`}
                      onMouseEnter={(e) => {
                        const wrap =
                          e.currentTarget.querySelector(".proj-path-wrap");
                        const span = wrap?.querySelector(".proj-path");
                        if (
                          wrap &&
                          span &&
                          (span as HTMLElement).scrollWidth >
                            (wrap as HTMLElement).clientWidth + 4
                        ) {
                          e.currentTarget.classList.add("can-scroll");
                        }
                      }}
                      onMouseLeave={(e) =>
                        e.currentTarget.classList.remove("can-scroll")
                      }
                      onClick={() => {
                        setProjMenuOpen(false);
                        onSelectProject?.(p.cwd);
                      }}
                    >
                      <span className="proj-name">
                        {p.cwd.split("/").filter(Boolean).pop()}
                      </span>
                      <span className="proj-path-wrap">
                        <span className="dim mono proj-path">{p.cwd}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          {conv.error && !conv.connected && (
            <div className="hero-connection-error" role="alert">
              {conv.reconnecting ? t("reconnecting") : t("disconnected")}{" "}
              {conv.error}
            </div>
          )}
          {conv.transcriptNotices.length > 0 && (
            <div className="hero-transcript-notices">
              {conv.transcriptNotices.map((notice) => (
                <TranscriptNoticeView key={notice.id} notice={notice} />
              ))}
            </div>
          )}
          <EditorWidgets conv={conv} placement="aboveEditor" />
          <div className="hero-composer">
            <Composer conv={conv} draft={draft} onDraft={setDraft} />
          </div>
          <EditorWidgets conv={conv} placement="belowEditor" />
          <StatsBar conv={conv} />
        </div>
        <ExtensionUI conv={conv} />
      </>
    );
  }

  return (
    <SubagentContext.Provider value={subagentContext}>
      <div className="chat-header">
        <div className="menu-anchor chat-actions" ref={actionsRef}>
          <button
            type="button"
            className="btn btn-icon chat-actions-trigger"
            title={t("sessionActions")}
            aria-label={t("sessionActions")}
            aria-haspopup="menu"
            aria-expanded={actionsOpen}
            onClick={() => setActionsOpen((open) => !open)}
          >
            <IconMore size={16} />
          </button>
          {actionsOpen && (
            <div className="menu menu-down chat-actions-menu" role="menu" aria-label={t("sessionActions")}>
              <button
                type="button"
                className={`menu-item ${showTraj ? "active" : ""}`}
                role="menuitemcheckbox"
                aria-checked={showTraj}
                onClick={() => {
                  setShowTraj((value) => !value);
                  setActionsOpen(false);
                }}
              >
                <IconLs size={15} /> {t("trajectory")}
              </button>
              <button
                type="button"
                className="menu-item"
                role="menuitem"
                disabled={!baseMessages.some((message) => message._entryId)}
                onClick={() => {
                  setActionsOpen(false);
                  let last: PiiMessage | undefined;
                  for (let index = baseMessages.length - 1; index >= 0; index--) {
                    if (baseMessages[index]._entryId) {
                      last = baseMessages[index];
                      break;
                    }
                  }
                  if (!last?._entryId) return;
                  void conv
                    .send({ type: "fork", entryId: last._entryId })
                    .then((data) => {
                      onRefresh();
                      const file = data?.sessionFile as string | undefined;
                      if (file && onForked)
                        onForked(conv.snapshot?.cwd ?? conv.cwd, file);
                    })
                    .catch((cause) => reportConversationError(conv, cause));
                }}
              >
                <IconGitFork size={15} /> {t("clone")}
              </button>
              <button
                type="button"
                className="menu-item"
                role="menuitem"
                onClick={() => {
                  setActionsOpen(false);
                  void conv
                    .send({ type: "compact" })
                    .catch((cause) => reportConversationError(conv, cause));
                }}
              >
                <IconCompress size={15} /> {t("compact")}
              </button>
              <button
                type="button"
                className="menu-item"
                role="menuitem"
                onClick={() => {
                  setActionsOpen(false);
                  handleExport();
                }}
              >
                <IconExport size={15} /> {t("export")}
              </button>
            </div>
          )}
        </div>
        <div className="chat-session-title" title={title}>
          {title}
        </div>
        <div className="spacer" />
        {snap?.isStreaming && (
          <span
            style={{
              fontSize: 12,
              color: "var(--dsw-alias-state-business-primary)",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span
              style={{
                display: "inline-block",
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "var(--dsw-alias-state-business-primary)",
                animation: "pulse 1.2s ease-in-out infinite",
              }}
            />
            {t("running")}
          </span>
        )}
        <RunsChip
          onOpenRun={(run: RunInfo) => {
            if (run.sessionFile && onForked) onForked(run.cwd, run.sessionFile);
          }}
        />
      </div>

      <div
        className={`chat-body ${subagents.selected ? "has-subagent-detail" : ""}`}
      >
        <div className="chat-main">
          {!showTraj && !subagents.selected && (
            <>
              <div
                className="chat-width-resize"
                title={t("resizeWidth")}
                onPointerDown={startWidthDrag}
                onPointerMove={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  e.currentTarget.style.setProperty(
                    "--handle-y",
                    `${e.clientY - rect.top}px`,
                  );
                }}
              />
              <div
                className="chat-width-resize right"
                title={t("resizeWidth")}
                onPointerDown={startWidthDrag}
                onPointerMove={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  e.currentTarget.style.setProperty(
                    "--handle-y",
                    `${e.clientY - rect.top}px`,
                  );
                }}
              />
            </>
          )}
          <div className="chat-scroll-frame">
          {showTraj ? (
            <div className="chat-scroll">
              <Suspense
                fallback={
                  <div className="session-loading" role="status">
                    …
                  </div>
                }
              >
                <Trajectory conv={conv} />
              </Suspense>
            </div>
          ) : (
            <div className="chat-scroll" ref={bindScroll} tabIndex={0}>
              <div className="chat-column">
                {conv.historyFrom > 0 && (
                  <div style={{ display: "flex", justifyContent: "center" }}>
                    <button
                      className="btn btn-sm"
                      disabled={conv.historyInFlight}
                      onClick={() => conv.loadOlder()}
                    >
                      {conv.historyInFlight ? "…" : t("loadOlder")} (
                      {conv.historyFrom})
                    </button>
                  </div>
                )}
                {baseMessages.length === 0 && !streamingMessage && (
                  <div className="empty-state" style={{ minHeight: 240 }}>
                    <div className="big">{t("startChat")}</div>
                    <div>
                      {t("piWorksIn")} {snap?.cwd ?? conv.cwd}
                    </div>
                  </div>
                )}
                {noticesBeforeMessages.map((notice) => (
                  <TranscriptNoticeView key={notice.id} notice={notice} />
                ))}
                <FinalizedTimeline
                  cwd={snap?.cwd ?? conv.cwd}
                  messages={baseMessages}
                  messageKeys={messageKeys}
                  renderKeys={renderKeys}
                  noticesByMessage={noticesByMessage}
                  toolResults={toolResults}
                  tools={conv.tools}
                  language={language}
                  onFork={handleFork}
                  onOpenFile={handleOpenFile}
                  onBranch={handleBranch}
                />
                {streamingMessage && streamingRenderKey && (
                  <Fragment key={streamingRenderKey}>
                    <MessageItem
                      cwd={snap?.cwd ?? conv.cwd}
                      message={streamingMessage}
                      streaming
                      live={(() => {
                        const run = conv.runStats;
                        const partialLen = validContentBlocks(
                          streamingMessage.content,
                        ).reduce(
                          (count, block) =>
                            count +
                            String(block.text ?? block.thinking ?? "").length,
                          0,
                        );
                        const metrics = calculateLiveOutputMetrics({
                          visibleChars: partialLen,
                          outputChars: run.outputChars,
                          firstDeltaAt: run.firstDeltaAt,
                          deltaSamples: conv.deltaSamples,
                          now: Date.now(),
                        });
                        return { model: snap?.model?.name, ...metrics };
                      })()}
                      toolResults={toolResults}
                      tools={conv.tools}
                      language={language}
                      onFork={handleFork}
                      onOpenFile={handleOpenFile}
                      onBranch={handleBranch}
                    />
                    {(streamingMessageKey
                      ? (noticesByMessage.get(streamingMessageKey) ?? [])
                      : []
                    ).map((notice) => (
                      <TranscriptNoticeView key={notice.id} notice={notice} />
                    ))}
                  </Fragment>
                )}
                {orphanTools.length > 0 && (
                  <div className="msg-row assistant">
                    <div className="msg-assistant">
                      {orphanTools.map((activity) => (
                        <ToolCard
                          key={activity.toolCallId}
                          call={{
                            type: "toolCall",
                            id: activity.toolCallId,
                            name: activity.toolName,
                            arguments: activity.args,
                          }}
                          activity={activity}
                          onOpenFile={handleOpenFile}
                          language={language}
                        />
                      ))}
                    </div>
                  </div>
                )}
                {conv.connected &&
                  conv.snapshot?.providerRequest &&
                  !conv.compaction &&
                  (conv.snapshot.providerRequest.phase !== "streaming" ||
                    (!validContentBlocks(streamingMessage?.content).some(
                      (block) =>
                        (block.type === "text" &&
                          String(block.text ?? "").trim()) ||
                        (block.type === "thinking" &&
                          String(block.thinking ?? "").trim()) ||
                        block.type === "toolCall",
                    ) &&
                      !orphanTools.length)) && (
                    <ProviderActivity
                      state={conv.snapshot.providerRequest}
                      language={language}
                    />
                  )}
                {conv.connected &&
                  conv.snapshot?.isStreaming &&
                  !conv.snapshot.providerRequest &&
                  !conv.retry &&
                  !conv.compaction &&
                  (() => {
                    const hasContent =
                      validContentBlocks(streamingMessage?.content).some(
                        (block) =>
                          (block.type === "text" &&
                            String(block.text ?? "").trim()) ||
                          (block.type === "thinking" &&
                            String(block.thinking ?? "").trim()) ||
                          block.type === "toolCall",
                      ) || orphanTools.length > 0;
                    if (hasContent) return null;
                    const elapsed = conv.runStats.agentStartedAt
                      ? Math.max(
                          0,
                          Math.floor(
                            (Date.now() - conv.runStats.agentStartedAt) / 1000,
                          ),
                        )
                      : 0;
                    return (
                      <div className="working-indicator">
                        <span className="working-dot" />
                        <span>{t("waitingModel")}</span>
                        <span className="working-elapsed">{elapsed}秒</span>
                      </div>
                    );
                  })()}
                {conv.connected &&
                  conv.retry &&
                  !conv.snapshot?.providerRequest && (
                    <div className="retry-banner">
                      <span
                        className="working-dot"
                        style={{
                          background: "var(--dsw-alias-state-warn-primary)",
                        }}
                      />
                      <span>
                        {t("retrying", {
                          attempt: String(conv.retry.attempt),
                          max: String(conv.retry.maxAttempts),
                        })}
                        {conv.retry.delayMs > 0 &&
                          ` · ${Math.round(conv.retry.delayMs / 1000)}s`}
                        {conv.retry.errorMessage && (
                          <span className="dim">
                            {" "}
                            · {conv.retry.errorMessage.slice(0, 80)}
                          </span>
                        )}
                      </span>
                    </div>
                  )}
                {conv.connected && conv.compaction && (
                  <div className="compaction-banner">
                    <span
                      className="composer-spinner"
                      style={{ width: 13, height: 13 }}
                    />
                    <span>
                      {t("compacting")}
                      <span className="dim">
                        {" · "}
                        {conv.compaction.reason === "manual"
                          ? t("compactReasonManual")
                          : conv.compaction.reason === "threshold"
                            ? t("compactReasonThreshold")
                            : conv.compaction.reason === "overflow"
                              ? t("compactReasonOverflow")
                              : ""}
                      </span>
                    </span>
                  </div>
                )}
                {conv.connected &&
                  snap?.compactionState &&
                  snap.compactionState.status !== "running" && (
                    <div className="compaction-banner" role="status">
                      {language.startsWith("zh")
                        ? `最近一次压缩${snap.compactionState.status === "completed" ? "已完成" : snap.compactionState.status === "cancelled" ? "已取消" : "失败"}`
                        : `Last compaction: ${snap.compactionState.status}`}
                      {snap.compactionState.status === "completed" &&
                        snap.compactionState.tokensBefore !== undefined && (
                          <span className="dim">
                            {" "}
                            ·{" "}
                            {snap.compactionState.tokensBefore.toLocaleString()}{" "}
                            tok
                            {snap.compactionState.estimatedTokensAfter !==
                              undefined &&
                              ` → ≈${snap.compactionState.estimatedTokensAfter.toLocaleString()} tok`}
                          </span>
                        )}
                      {snap.compactionState.errorMessage && (
                        <span className="dim">
                          {" "}
                          · {snap.compactionState.errorMessage}
                        </span>
                      )}
                    </div>
                  )}
                {conv.lastError && (
                  <div className="msg-error msg-error-dismissible" role="alert">
                    <span className="msg-error-text">{conv.lastError}</span>
                    <button
                      type="button"
                      className="msg-error-close"
                      aria-label={t("close")}
                      onClick={() => conv.clearError()}
                    >
                      <IconX size={14} />
                    </button>
                  </div>
                )}
                {conv.reconnecting && (
                  <div className="msg-error">{t("reconnecting")}</div>
                )}
                {shouldShowDisconnected(
                  conv.connected,
                  conv.reconnecting,
                  conv.error,
                ) && <div className="msg-error">{t("disconnected")}</div>}
              </div>
            </div>
          )}
          {showJump && !showTraj && (
            <button
              className="jump-bottom"
              onClick={() => {
                tailFollowerRef.current?.jumpToBottom();
                setShowJump(false);
              }}
            >
              ↓ {t("jumpToBottom")}
            </button>
          )}
          </div>
          {(conv.queue.steering.length > 0 ||
            conv.queue.followUp.length > 0) && (
            <div className="queue-strip">
              <div className="queue-header">
                <button
                  className="btn btn-sm"
                  title={t("queueClear")}
                  onClick={() =>
                    void conv
                      .send({ type: "queue_clear" })
                      .catch((cause) => reportConversationError(conv, cause))
                  }
                >
                  <IconTrash size={11} /> {t("queueClear")}
                </button>
              </div>
              {conv.queue.steering.map((msg, i) => (
                <QueueItem
                  key={`s${i}-${msg}`}
                  kind="steer"
                  index={i}
                  msg={msg}
                  conv={conv}
                  capabilities={conv.snapshot?.queueCapabilities}
                  onEdit={(m) => setDraft(m)}
                />
              ))}
              {conv.queue.followUp.map((msg, i) => (
                <QueueItem
                  key={`f${i}-${msg}`}
                  kind="followUp"
                  index={i}
                  msg={msg}
                  conv={conv}
                  capabilities={conv.snapshot?.queueCapabilities}
                  onEdit={(m) => setDraft(m)}
                />
              ))}
            </div>
          )}

          <EditorWidgets conv={conv} placement="aboveEditor" />
          <div className="composer-wrap">
            <SubagentPanel key={snap?.sessionFile} />
            <InlineQuestions conv={conv} />
            <Composer conv={conv} draft={draft} onDraft={setDraft} />
          </div>
          <EditorWidgets conv={conv} placement="belowEditor" />
          <StatsBar conv={conv} />
        </div>
        {subagents.selected && (
          <>
            <div className="preview-resize" onPointerDown={startPreviewDrag} />
            <ErrorBoundary
              key={`${snap?.sessionFile}:${subagents.selected}`}
              inline
              onDismiss={subagents.close}
            >
              <Suspense
                fallback={
                  <div className="subagent-detail-loading">
                    <button className="btn" onClick={subagents.close}>
                      {t("close")}
                    </button>
                    {t("subagentLoading")}
                  </div>
                }
              >
                <SubagentRunDialog width={previewWidth} />
              </Suspense>
            </ErrorBoundary>
          </>
        )}
        {previewPath && !subagents.selected && (
          <>
            <div className="preview-resize" onPointerDown={startPreviewDrag} />
            <Suspense fallback={null}>
              <FilePreview
                cwd={snap?.cwd ?? conv.cwd}
                path={previewPath}
                pending={previewState.pending}
                revision={previewState.revision}
                onNavigate={handleOpenFile}
                width={previewWidth}
                agent={conv.agent}
                sessionId={snap?.sessionId}
                onClose={handleClosePreview}
                language={language}
              />
            </Suspense>
          </>
        )}
      </div>

      <ExtensionUI conv={conv} />
    </SubagentContext.Provider>
  );
}

interface FinalizedTimelineProps {
  cwd: string;
  messages: PiiMessage[];
  messageKeys: string[];
  renderKeys: string[];
  noticesByMessage: Map<string, Conversation["transcriptNotices"]>;
  toolResults: Map<string, PiiMessage>;
  tools: Map<string, ToolActivity>;
  language: string;
  onFork: (entryId: string) => void;
  onBranch: (entryId: string) => void;
  onOpenFile: (path: string) => void;
}

/** A streaming text delta must not rebuild or rescan the finalized transcript. */
const FinalizedTimeline = memo(function FinalizedTimeline({
  cwd,
  messages,
  messageKeys,
  renderKeys,
  noticesByMessage,
  toolResults,
  tools,
  language,
  onFork,
  onBranch,
  onOpenFile,
}: FinalizedTimelineProps) {
  return messages.map((message, index) => (
    <Fragment key={renderKeys[index]}>
      <MessageItem
        cwd={cwd}
        message={message}
        streaming={false}
        toolResults={toolResults}
        tools={tools}
        language={language}
        onFork={onFork}
        onOpenFile={onOpenFile}
        onBranch={onBranch}
      />
      {(noticesByMessage.get(messageKeys[index]) ?? []).map((notice) => (
        <TranscriptNoticeView key={notice.id} notice={notice} />
      ))}
    </Fragment>
  ));
});

export default memo(ChatView);

function firstUserText(messages: PiiMessage[]): string {
  for (const m of messages) {
    if (m.role !== "user") continue;
    const c = m.content;
    if (typeof c === "string") return c.slice(0, 60);
    if (Array.isArray(c)) {
      const block = validContentBlocks(c).find((item) => item.type === "text");
      if (typeof block?.text === "string") return block.text.slice(0, 60);
    }
  }
  return "";
}

function reportConversationError(conv: Conversation, cause: unknown): void {
  conv.reportError(cause instanceof Error ? cause.message : String(cause));
}

function QueueItem({
  kind,
  index,
  msg,
  conv,
  capabilities,
  onEdit,
}: {
  kind: "steer" | "followUp";
  index: number;
  msg: string;
  conv: Conversation;
  capabilities?: SessionSnapshot["queueCapabilities"];
  onEdit: (m: string) => void;
}) {
  const other = kind === "steer" ? "followUp" : "steer";
  const apiQueue = kind === "steer" ? "steering" : "followUp";
  const apiOther = other === "steer" ? "steering" : "followUp";
  return (
    <div className={`queue-item queue-${kind}`}>
      <span className="queue-label">
        {kind === "steer" ? t("queuedSteer") : t("queuedFollowUp")}
      </span>
      <span className="queue-text">{msg}</span>
      <span className="queue-actions">
        <button
          className="btn btn-icon btn-sm"
          title={
            capabilities?.reason ??
            t("queueMove", {
              mode: other === "steer" ? t("queuedSteer") : t("queuedFollowUp"),
            })
          }
          disabled={!capabilities?.reorder}
          onClick={() => {
            if (!capabilities) return;
            void conv
              .send({
                type: "queue_move",
                from: apiQueue,
                to: apiOther,
                index,
                expectedMessage: msg,
                revision: capabilities.revision,
              })
              .catch((cause) => reportConversationError(conv, cause));
          }}
        >
          ⇄
        </button>
        <button
          className="btn btn-icon btn-sm"
          title={capabilities?.reason ?? t("queueEdit")}
          disabled={!capabilities?.remove}
          onClick={() => {
            if (!capabilities) return;
            void conv
              .send({
                type: "queue_remove",
                queue: apiQueue,
                index,
                expectedMessage: msg,
                revision: capabilities.revision,
              })
              .then(() => onEdit(msg))
              .catch((cause) => reportConversationError(conv, cause));
          }}
        >
          <IconPencil size={11} />
        </button>
        <button
          className="btn btn-icon btn-sm"
          title={capabilities?.reason ?? t("queueRemove")}
          disabled={!capabilities?.remove}
          onClick={() => {
            if (!capabilities) return;
            void conv
              .send({
                type: "queue_remove",
                queue: apiQueue,
                index,
                expectedMessage: msg,
                revision: capabilities.revision,
              })
              .catch((cause) => reportConversationError(conv, cause));
          }}
        >
          <IconX size={11} />
        </button>
      </span>
    </div>
  );
}
