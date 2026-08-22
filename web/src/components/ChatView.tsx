import { useEffect, useRef, useState } from 'react';
import type { Conversation } from '../api';
import MessageItem from './MessageItem';
import Composer from './Composer';
import StatsBar from './StatsBar';
import Trajectory from './Trajectory';
import ExtensionUI from './ExtensionUI';
import { exportHtml } from '../export';
import type { PiiMessage } from '../types';
import { t } from '../i18n';

interface Props {
  conv: Conversation;
  onRefresh: () => void;
}

export default function ChatView({ conv, onRefresh }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [showTraj, setShowTraj] = useState(false);
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
          <div className="sub">{snap?.cwd ?? conv.cwd}</div>
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

      {showTraj ? (
        <div className="chat-scroll">
          <Trajectory conv={conv} />
        </div>
      ) : (
      <div className="chat-scroll" ref={scrollRef}>
        <div className="chat-column">
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
              onFork={(entryId) => void conv.send({ type: 'fork', entryId }).then(onRefresh).catch(() => undefined)}
              onBranch={(entryId) => void conv.send({ type: 'branch', entryId }).catch(() => undefined)}
            />
          ))}
          {conv.lastError && <div className="msg-error">{conv.lastError}</div>}
          {conv.error && <div className="msg-error">连接中断：{conv.error}</div>}
        </div>
      </div>
      )}

      <div className="composer-wrap">
        <Composer conv={conv} />
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
