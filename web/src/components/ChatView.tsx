import { useEffect, useReducer, useRef, useState } from 'react';
import type { Conversation } from '../api';
import MessageItem from './MessageItem';
import Composer from './Composer';
import StatsBar from './StatsBar';
import { IconFolder, IconChevronDown } from '../icons';
import Trajectory from './Trajectory';
import ExtensionUI, { InlineQuestions } from './ExtensionUI';
import FilePreview from './FilePreview';
import { IconTrash, IconPencil, IconX } from '../icons';
import { exportHtml } from '../export';
import type { PiiMessage, ProjectGroup } from '../types';
import { t } from '../i18n';

interface Props {
  conv: Conversation;
  onRefresh: () => void;
  onForked?: (cwd: string, sessionFile: string) => void;
  projects?: ProjectGroup[];
  onSelectProject?: (cwd: string) => void;
}

export default function ChatView({ conv, onRefresh, onForked, projects, onSelectProject }: Props) {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => conv.subscribe(force), [conv]);
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
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [showTraj, setShowTraj] = useState(false);
  const [draft, setDraft] = useState<string>();
  const [previewPath, setPreviewPath] = useState<string>();
  const [projMenuOpen, setProjMenuOpen] = useState(false);
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

  const allMessages: PiiMessage[] = conv.streaming
    ? [...conv.messages, conv.streaming]
    : conv.messages;

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
    setShowJump(!atBottomRef.current && Boolean(conv.snapshot?.isStreaming));
  }, [lastMsg, conv.streaming, conv.tools, conv.snapshot?.isStreaming]);

  const title = snap?.name || firstUserText(allMessages) || '新会话';

  useEffect(() => {
    document.title = `Pii - ${title}`;
    return () => {
      document.title = 'Pii';
    };
  }, [title]);

  const saveTitle = () => {
    setEditingTitle(false);
    const name = titleDraft.trim();
    if (name && name !== snap?.name) {
      void conv.send({ type: 'setSessionName', name }).then(onRefresh).catch(() => undefined);
    }
  };

  // custom/system injections (e.g. ADHD ruleset) don't count as conversation
  const hasUserMessage = allMessages.some((m) => m.role === 'user');
  if (!hasUserMessage && !conv.snapshot?.isStreaming) {
    return (
      <>
        <div className="hero">
          <img className="hero-logo" src="/favicon.svg" alt="Pii" />
          <h1 className="hero-title">Pii</h1>
          <div className="hero-sub">{t('heroTagline')}</div>
          <div className="hero-chips">
            <div className="menu-anchor">
              <button className="model-chip" onClick={(e) => { e.stopPropagation(); setProjMenuOpen(!projMenuOpen); }}>
                <IconFolder size={13} />
                <span className="model-chip-name">{(conv.cwd || projects?.[0]?.cwd || '/').split('/').filter(Boolean).pop()}</span>
                <IconChevronDown size={11} />
              </button>
              {projMenuOpen && (
                <div className="menu" onClick={(e) => e.stopPropagation()}>
                  {(projects ?? []).map((p) => (
                    <button
                      key={p.cwd}
                      className={`menu-item ${conv.cwd === p.cwd ? 'active' : ''}`}
                      onClick={() => { setProjMenuOpen(false); onSelectProject?.(p.cwd); }}
                    >
                      <span>{p.cwd.split('/').filter(Boolean).pop()}</span>
                      <span className="dim mono" style={{ fontSize: 10.5 }}>{p.cwd}</span>
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
        <div style={{ minWidth: 0 }}>
          {editingTitle ? (
            <input
              autoFocus
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveTitle();
                if (e.key === 'Escape') setEditingTitle(false);
              }}
              style={{
                font: 'inherit', fontWeight: 600, fontSize: 14, width: 360, maxWidth: '60vw',
                background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
                border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, padding: '2px 8px', outline: 'none',
              }}
            />
          ) : (
            <div
              className="title"
              title={t('doubleClickRename')}
              onDoubleClick={() => {
                setTitleDraft(snap?.name ?? title);
                setEditingTitle(true);
              }}
            >
              {title}
            </div>
          )}
          <div className="sub" title={snap?.cwd ?? conv.cwd}>{(snap?.cwd ?? conv.cwd).split('/').filter(Boolean).pop()}</div>
        </div>
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
      </div>

      <StatsBar conv={conv} />

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
              <button className="btn btn-sm" onClick={() => conv.loadOlder()}>
                {t('loadOlder')} ({conv.historyFrom})
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
                      const tokens = Math.round(Math.max(partialLen, run.outputChars) / 3.5);
                      const nowMs = Date.now();
                      const recentChars = conv.deltaSamples
                        .filter((d) => nowMs - d.t <= 5000)
                        .reduce((sum, d) => sum + d.n, 0);
                      const tps = run.firstDeltaAt ? recentChars / 3.5 / 5 : 0;
                      return { model: snap?.model?.name, tokens, tps };
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
          {conv.lastError && <div className="msg-error">{conv.lastError}</div>}
          {conv.reconnecting && <div className="msg-error">{t('reconnecting')}</div>}
          {!conv.reconnecting && !conv.connected && <div className="msg-error">{t('disconnected')}</div>}
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
              onEdit={(m) => setDraft(m)}
            />
          ))}
        </div>
      )}

      <div className="composer-wrap">
        <InlineQuestions conv={conv} />
        <Composer conv={conv} draft={draft} onDraft={setDraft} />
      </div>
      </div>
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
      {previewPath && (
        <>
          <div className="preview-resize" onMouseDown={startPreviewDrag} />
          <FilePreview
            cwd={snap?.cwd ?? conv.cwd}
            path={previewPath}
            width={previewWidth}
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


function QueueItem({ kind, index, msg, conv, onEdit }: {
  kind: 'steer' | 'followUp';
  index: number;
  msg: string;
  conv: Conversation;
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
          title={t('queueMove', { mode: other === 'steer' ? t('queuedSteer') : t('queuedFollowUp') })}
          onClick={() => void conv.send({ type: 'queue_move', from: apiQueue, to: apiOther, index }).catch(() => undefined)}
        >
          ⇄
        </button>
        <button
          className="btn btn-icon btn-sm"
          title={t('queueEdit')}
          onClick={() => {
            onEdit(msg);
            void conv.send({ type: 'queue_remove', queue: apiQueue, index }).catch(() => undefined);
          }}
        >
          <IconPencil size={11} />
        </button>
        <button
          className="btn btn-icon btn-sm"
          title={t('queueRemove')}
          onClick={() => void conv.send({ type: 'queue_remove', queue: apiQueue, index }).catch(() => undefined)}
        >
          <IconX size={11} />
        </button>
      </span>
    </div>
  );
}
