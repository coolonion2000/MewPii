import { useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import type { Conversation } from '../api';
import MessageItem from './MessageItem';
import Composer from './Composer';
import StatsBar from './StatsBar';
import RunsChip, { type RunInfo } from './RunsChip';
import SubagentPanel from './SubagentPanel';
import { IconFolder, IconChevronDown } from '../icons';
import Trajectory from './Trajectory';
import ExtensionUI, { InlineQuestions } from './ExtensionUI';
import FilePreview from './FilePreview';
import { IconTrash, IconPencil, IconX } from '../icons';
import { exportHtml } from '../export';
import type { PiiMessage, ProjectGroup, SessionSnapshot } from '../types';
import { calculateLiveOutputMetrics, shouldShowDisconnected } from '../state-utils';
import {
  armCompletionSound,
  playCompletionSound,
  shouldPlayCompletionSound,
} from '../completion-sound';
import { t } from '../i18n';

interface Props {
  conv: Conversation;
  onRefresh: () => void;
  onForked?: (cwd: string, sessionFile: string, sessionId?: string) => void;
  projects?: ProjectGroup[];
  onSelectProject?: (cwd: string) => void;
}

export default function ChatView({ conv, onRefresh, onForked, projects, onSelectProject }: Props) {
  const [, force] = useReducer((x: number) => x + 1, 0);
  // React rechecks the revision after subscribing, so even a snapshot arriving
  // between render and commit cannot leave this view on stale empty state.
  useSyncExternalStore(conv.subscribe, conv.getRevision, conv.getRevision);

  const runIsStreaming = Boolean(conv.snapshot?.isStreaming);
  const completionStateRef = useRef({ conversation: conv, isStreaming: runIsStreaming });
  useEffect(() => {
    const arm = () => {
      armCompletionSound();
      window.removeEventListener('pointerdown', arm);
      window.removeEventListener('keydown', arm);
    };
    window.addEventListener('pointerdown', arm);
    window.addEventListener('keydown', arm);
    return () => {
      window.removeEventListener('pointerdown', arm);
      window.removeEventListener('keydown', arm);
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
    completionStateRef.current = { conversation: conv, isStreaming: runIsStreaming };
  }, [conv, runIsStreaming]);

  // 1s ticker while streaming so the live t/s decays smoothly between deltas
  useEffect(() => {
    if (!conv.snapshot?.isStreaming) return;
    const timer = setInterval(force, 1000);
    return () => clearInterval(timer);
  }, [conv.snapshot?.isStreaming]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const isNearBottom = () => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  const [showTraj, setShowTraj] = useState(false);
  const [draft, setDraft] = useState<string>();
  const [previewPath, setPreviewPath] = useState<string>();
  const [projMenuOpen, setProjMenuOpen] = useState(false);
  useEffect(() => {
    if (!projMenuOpen) return;
    const close = () => setProjMenuOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [projMenuOpen]);
  const [previewWidth, setPreviewWidth] = useState(() => Number(localStorage.getItem('pii-preview-w')) || 480);

  const startPreviewDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = previewWidth;
    const onMove = (ev: MouseEvent) => {
      const w = Math.min(window.innerWidth * 0.75, Math.max(280, startW + (startX - ev.clientX)));
      setPreviewWidth(w);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setPreviewWidth((w) => {
        localStorage.setItem('pii-preview-w', String(Math.round(w)));
        return w;
      });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  const snap = conv.snapshot;

  const baseMessages: PiiMessage[] = [
    ...conv.messages,
    ...conv.optimistic.map((o) => o.message),
  ];
  const allMessages: PiiMessage[] = conv.streaming
    ? [...baseMessages, conv.streaming]
    : baseMessages;

  // toolCallId → toolResult message
  const toolResults = new Map<string, PiiMessage>();
  for (const m of conv.messages) {
    if (m.role === 'toolResult') toolResults.set(String(m.toolCallId), m);
  }

  // auto-scroll while streaming — ONLY when the user is already at the bottom;
  // scrolling up to read history must never yank them back down
  const lastMsg = allMessages[allMessages.length - 1];
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
    setShowJump(!atBottomRef.current);
  }, [lastMsg, conv.streaming, conv.tools, conv.snapshot?.isStreaming]);

  const title = snap?.name || firstUserText(allMessages) || '新会话';

  useEffect(() => {
    document.title = `MewPii - ${title}`;
    return () => {
      document.title = 'MewPii';
    };
  }, [title]);

  // Existing sessions should show a loading state until their first snapshot;
  // rendering the new-session hero here makes a successful refresh look empty.
  if (!snap && conv.sessionPath) {
    return (
      <div className="session-loading" role="status">
        <span className="working-dot" aria-hidden="true" />
        <span>{t('loadingSession')}</span>
      </div>
    );
  }

  // custom/system injections (e.g. ADHD ruleset) don't count as conversation
  const hasUserMessage = allMessages.some((m) => m.role === 'user');
  if (!hasUserMessage && !conv.snapshot?.isStreaming) {
    return (
      <>
        <div className="hero">
          <img className="hero-logo-wide logo-on-dark" src="/logo-wide-dark.png" alt="MewPii" />
          <img className="hero-logo-wide logo-on-light" src="/logo-wide-light.png" alt="MewPii" />
          <div className="hero-sub">{t('heroTagline')}</div>
          <div className="hero-chips">
            <div className="menu-anchor">
              <button className="model-chip" onClick={(e) => { e.stopPropagation(); setProjMenuOpen(!projMenuOpen); }}>
                <IconFolder size={13} />
                <span className="model-chip-name">{(conv.cwd || projects?.[0]?.cwd || '/').split('/').filter(Boolean).pop()}</span>
                <IconChevronDown size={11} />
              </button>
              {projMenuOpen && (
                <div className="menu menu-down" onClick={(e) => e.stopPropagation()}>
                  {(projects ?? []).map((p) => (
                    <button
                      key={p.cwd}
                      className={`menu-item proj-item ${conv.cwd === p.cwd ? 'active' : ''}`}
                      onMouseEnter={(e) => {
                        const wrap = e.currentTarget.querySelector('.proj-path-wrap');
                        const span = wrap?.querySelector('.proj-path');
                        if (wrap && span && (span as HTMLElement).scrollWidth > (wrap as HTMLElement).clientWidth + 4) {
                          e.currentTarget.classList.add('can-scroll');
                        }
                      }}
                      onMouseLeave={(e) => e.currentTarget.classList.remove('can-scroll')}
                      onClick={() => { setProjMenuOpen(false); onSelectProject?.(p.cwd); }}
                    >
                      <span className="proj-name">{p.cwd.split('/').filter(Boolean).pop()}</span>
                      <span className="proj-path-wrap"><span className="dim mono proj-path">{p.cwd}</span></span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="hero-composer">
            <Composer conv={conv} draft={draft} onDraft={setDraft} />
          </div>
        </div>
        <ExtensionUI conv={conv} />
      </>
    );
  }

  return (
    <>
      <div className="chat-header">
        <div className="chat-session-title" title={title}>{title}</div>
        <div className="spacer" />
        {snap?.isStreaming && (
          <span style={{ fontSize: 12, color: 'var(--dsw-alias-state-business-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: 'var(--dsw-alias-state-business-primary)', animation: 'pulse 1.2s ease-in-out infinite' }} />
            {t('running')}
          </span>
        )}
        <button className={`btn btn-sm ${showTraj ? 'tab-active' : ''}`} onClick={() => setShowTraj((v) => !v)}>
          {t('trajectory')}
        </button>
        <button
          className="btn btn-sm"
          title={t('clone')}
          onClick={() => {
            const last = [...allMessages].reverse().find((m) => m._entryId);
            if (!last?._entryId) return;
            void conv
              .send({ type: 'fork', entryId: last._entryId })
              .then((data) => {
                onRefresh();
                const file = data?.sessionFile as string | undefined;
                if (file && onForked) onForked(conv.snapshot?.cwd ?? conv.cwd, file);
              })
              .catch(() => undefined);
          }}
        >
          {t('clone')}
        </button>
        <button className="btn btn-sm" title={t('compact')} onClick={() => void conv.send({ type: 'compact' }).catch(() => undefined)}>
          {t('compact')}
        </button>
        <button className="btn btn-sm" title={t('export')} onClick={() => exportHtml(title, snap?.cwd ?? conv.cwd, conv.messages)}>
          {t('export')}
        </button>
        <button className="btn btn-sm" onClick={() => conv.send({ type: 'newSession' }).then(onRefresh).catch(() => undefined)}>
          {t('newSession')}
        </button>
        <RunsChip onOpenRun={(run: RunInfo) => {
          if (run.sessionFile && onForked) onForked(run.cwd, run.sessionFile);
        }} />
      </div>

      <StatsBar conv={conv} />

      <div className="chat-body">
      <div className="chat-main">
      {showTraj ? (
        <div className="chat-scroll">
          <Trajectory conv={conv} />
        </div>
      ) : (
      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={() => {
          atBottomRef.current = isNearBottom();
          if (atBottomRef.current) setShowJump(false);
        }}
      >
        <div className="chat-column">
          {conv.historyFrom > 0 && (
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <button className="btn btn-sm" disabled={conv.historyInFlight} onClick={() => conv.loadOlder()}>
                {conv.historyInFlight ? '…' : t('loadOlder')} ({conv.historyFrom})
              </button>
            </div>
          )}
          {allMessages.length === 0 && (
            <div className="empty-state" style={{ minHeight: 240 }}>
              <div className="big">{t('startChat')}</div>
              <div>{t('piWorksIn')} {snap?.cwd ?? conv.cwd}</div>
            </div>
          )}
          {allMessages.map((m, i) => (
            <MessageItem
              key={`${m._entryId ?? (m as { timestamp?: number }).timestamp ?? i}-${i}`}
              message={m}
              streaming={conv.streaming === m}
              live={
                conv.streaming === m
                  ? (() => {
                      const run = conv.runStats;
                      const partial = m.content;
                      const partialLen = Array.isArray(partial)
                        ? (partial as Record<string, unknown>[]).reduce(
                            (n, b) => n + String(b.text ?? b.thinking ?? '').length,
                            0,
                          )
                        : 0;
                      const metrics = calculateLiveOutputMetrics({
                        visibleChars: partialLen,
                        outputChars: run.outputChars,
                        firstDeltaAt: run.firstDeltaAt,
                        deltaSamples: conv.deltaSamples,
                        now: Date.now(),
                      });
                      return { model: snap?.model?.name, ...metrics };
                    })()
                  : undefined
              }
              toolResults={toolResults}
              tools={conv.tools}
              onFork={(entryId) =>
                void conv
                  .send({ type: 'fork', entryId })
                  .then((data) => {
                    onRefresh();
                    const file = data?.sessionFile as string | undefined;
                    if (file && onForked) onForked(conv.snapshot?.cwd ?? conv.cwd, file);
                    else conv.toast(t('forkFailed'), 'error');
                  })
                  .catch((err) => conv.reportError(err instanceof Error ? err.message : String(err)))
              }
              onOpenFile={(p) => setPreviewPath(p)}
              onBranch={(entryId) =>
                void conv
                  .send({ type: 'branch', entryId })
                  .then((data) => {
                    const text = data?.editorText as string | undefined;
                    if (text) setDraft(text);
                    else conv.toast(t('branchedHere'));
                    // branch truncates the conversation; the browser would clamp
                    // the scroll to the top — bring the composer back into view
                    atBottomRef.current = true;
                    requestAnimationFrame(() => {
                      const el = scrollRef.current;
                      if (el) el.scrollTop = el.scrollHeight;
                    });
                  })
                  .catch((err) => conv.reportError(err instanceof Error ? err.message : String(err)))
              }
            />
          ))}
          {conv.snapshot?.isStreaming && (() => {
            const c = conv.streaming?.content;
            const hasContent = Array.isArray(c) && c.some(
              (b: Record<string, unknown>) =>
                (b.type === 'text' && String(b.text ?? '').trim()) ||
                (b.type === 'thinking' && String(b.thinking ?? '').trim()) ||
                b.type === 'toolCall',
            );
            if (hasContent) return null;
            const elapsed = conv.runStats.agentStartedAt
              ? Math.max(0, Math.floor((Date.now() - conv.runStats.agentStartedAt) / 1000))
              : 0;
            return (
              <div className="working-indicator">
                <span className="working-dot" />
                <span>{t('waitingModel')}</span>
                <span className="working-elapsed">{elapsed}秒</span>
              </div>
            );
          })()}
          {conv.retry && (
            <div className="retry-banner">
              <span className="working-dot" style={{ background: 'var(--dsw-alias-state-warn-primary)' }} />
              <span>
                {t('retrying', { attempt: String(conv.retry.attempt), max: String(conv.retry.maxAttempts) })}
                {conv.retry.delayMs > 0 && ` · ${Math.round(conv.retry.delayMs / 1000)}s`}
                {conv.retry.errorMessage && <span className="dim"> · {conv.retry.errorMessage.slice(0, 80)}</span>}
              </span>
            </div>
          )}
          {conv.compaction && (
            <div className="compaction-banner">
              <span className="composer-spinner" style={{ width: 13, height: 13 }} />
              <span>
                {t('compacting')}
                <span className="dim">
                  {' · '}
                  {conv.compaction.reason === 'manual'
                    ? t('compactReasonManual')
                    : conv.compaction.reason === 'threshold'
                      ? t('compactReasonThreshold')
                      : t('compactReasonOverflow')}
                </span>
              </span>
            </div>
          )}
          {conv.lastError && (
            <div className="msg-error msg-error-dismissible" role="alert">
              <span className="msg-error-text">{conv.lastError}</span>
              <button
                type="button"
                className="msg-error-close"
                aria-label={t('close')}
                onClick={() => conv.clearError()}
              >
                <IconX size={14} />
              </button>
            </div>
          )}
          {conv.reconnecting && <div className="msg-error">{t('reconnecting')}</div>}
          {shouldShowDisconnected(conv.connected, conv.reconnecting, conv.error) && (
            <div className="msg-error">{t('disconnected')}</div>
          )}
        </div>
      </div>
      )}
      {(conv.queue.steering.length > 0 || conv.queue.followUp.length > 0) && (
        <div className="queue-strip">
          <div className="queue-header">
            <button
              className="btn btn-sm"
              title={t('queueClear')}
              onClick={() => void conv.send({ type: 'queue_clear' }).catch(() => undefined)}
            >
              <IconTrash size={11} /> {t('queueClear')}
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

      {showJump && (
        <button
          className="jump-bottom"
          onClick={() => {
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
            atBottomRef.current = true;
            setShowJump(false);
          }}
        >
          ↓ {t('jumpToBottom')}
        </button>
      )}
      <div className="composer-wrap">
        <InlineQuestions conv={conv} />
        <Composer conv={conv} draft={draft} onDraft={setDraft} />
      </div>
      <SubagentPanel
        sessionFile={snap?.sessionFile}
        cwd={snap?.cwd ?? conv.cwd}
        onOpenParent={onForked}
      />
      </div>
      {previewPath && (
        <>
          <div className="preview-resize" onMouseDown={startPreviewDrag} />
          <FilePreview
            cwd={snap?.cwd ?? conv.cwd}
            path={previewPath}
            width={previewWidth}
            agent={conv.agent}
            sessionId={snap?.sessionId}
            onClose={() => setPreviewPath(undefined)}
          />
        </>
      )}
      </div>

      <ExtensionUI conv={conv} />
    </>
  );
}

function firstUserText(messages: PiiMessage[]): string {
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const c = m.content;
    if (typeof c === 'string') return c.slice(0, 60);
    if (Array.isArray(c)) {
      const t = c.find((b) => (b as { type?: string }).type === 'text') as { text?: string } | undefined;
      if (t?.text) return t.text.slice(0, 60);
    }
  }
  return '';
}


function QueueItem({ kind, index, msg, conv, capabilities, onEdit }: {
  kind: 'steer' | 'followUp';
  index: number;
  msg: string;
  conv: Conversation;
  capabilities?: SessionSnapshot['queueCapabilities'];
  onEdit: (m: string) => void;
}) {
  const other = kind === 'steer' ? 'followUp' : 'steer';
  const apiQueue = kind === 'steer' ? 'steering' : 'followUp';
  const apiOther = other === 'steer' ? 'steering' : 'followUp';
  return (
    <div className={`queue-item queue-${kind}`}>
      <span className="queue-label">{kind === 'steer' ? t('queuedSteer') : t('queuedFollowUp')}</span>
      <span className="queue-text">{msg}</span>
      <span className="queue-actions">
        <button
          className="btn btn-icon btn-sm"
          title={capabilities?.reason ?? t('queueMove', { mode: other === 'steer' ? t('queuedSteer') : t('queuedFollowUp') })}
          disabled={!capabilities?.reorder}
          onClick={() => {
            if (!capabilities) return;
            void conv.send({
              type: 'queue_move',
              from: apiQueue,
              to: apiOther,
              index,
              expectedMessage: msg,
              revision: capabilities.revision,
            }).catch(() => undefined);
          }}
        >
          ⇄
        </button>
        <button
          className="btn btn-icon btn-sm"
          title={capabilities?.reason ?? t('queueEdit')}
          disabled={!capabilities?.remove}
          onClick={() => {
            if (!capabilities) return;
            void conv.send({
              type: 'queue_remove',
              queue: apiQueue,
              index,
              expectedMessage: msg,
              revision: capabilities.revision,
            }).then(() => onEdit(msg)).catch(() => undefined);
          }}
        >
          <IconPencil size={11} />
        </button>
        <button
          className="btn btn-icon btn-sm"
          title={capabilities?.reason ?? t('queueRemove')}
          disabled={!capabilities?.remove}
          onClick={() => {
            if (!capabilities) return;
            void conv.send({
              type: 'queue_remove',
              queue: apiQueue,
              index,
              expectedMessage: msg,
              revision: capabilities.revision,
            }).catch(() => undefined);
          }}
        >
          <IconX size={11} />
        </button>
      </span>
    </div>
  );
}
