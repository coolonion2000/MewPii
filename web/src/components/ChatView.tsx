import { useEffect, useReducer, useRef, useState } from 'react';
import type { Conversation } from '../api';
import MessageItem from './MessageItem';
import Composer from './Composer';
import StatsBar from './StatsBar';
import Trajectory from './Trajectory';
import ExtensionUI, { InlineQuestions } from './ExtensionUI';
import { IconTrash, IconPencil, IconX } from '../icons';
import { exportHtml } from '../export';
import type { PiiMessage } from '../types';
import { t } from '../i18n';

interface Props {
  conv: Conversation;
  onRefresh: () => void;
  onForked?: (cwd: string, sessionFile: string) => void;
}

export default function ChatView({ conv, onRefresh, onForked }: Props) {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => conv.subscribe(force), [conv]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [showTraj, setShowTraj] = useState(false);
  const [draft, setDraft] = useState<string>();
  const snap = conv.snapshot;

  const allMessages: PiiMessage[] = conv.streaming
    ? [...conv.messages, conv.streaming]
    : conv.messages;

  // toolCallId → toolResult message
  const toolResults = new Map<string, PiiMessage>();
  for (const m of conv.messages) {
    if (m.role === 'toolResult') toolResults.set(String(m.toolCallId), m);
  }

  // auto-scroll while streaming
  const lastMsg = allMessages[allMessages.length - 1];
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastMsg, conv.streaming, conv.tools]);

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

      {showTraj ? (
        <div className="chat-scroll">
          <Trajectory conv={conv} />
        </div>
      ) : (
      <div className="chat-scroll" ref={scrollRef}>
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
