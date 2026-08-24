import { memo, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { PiiMessage } from '../types';
import type { ToolActivity } from '../api';
import ToolCard, { type ToolCallBlock } from './ToolCard';
import { t } from '../i18n';

interface Block {
  type: string;
  text?: string;
  thinking?: string;
  data?: string;
  mimeType?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

interface Props {
  message: PiiMessage;
  streaming: boolean;
  toolResults: Map<string, PiiMessage>;
  tools: Map<string, ToolActivity>;
  onFork: (entryId: string) => void;
  onBranch: (entryId: string) => void;
  onOpenFile?: (path: string) => void;
  /** live counter data for the streaming message header (pi-web style) */
  live?: { model?: string; tokens: number; tps: number } | undefined;
}

function MessageActions({ entryId, text, onFork, onBranch }: { entryId?: string; text: string; onFork: (id: string) => void; onBranch: (id: string) => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="msg-actions">
      <button
        className="btn btn-sm"
        title={t('copy')}
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }}
      >
        {copied ? t('copied') : t('copy')}
      </button>
      {entryId && <button className="btn btn-sm" title={t('forkTitle')} onClick={() => onFork(entryId)}>{t('fork')}</button>}
      {entryId && <button className="btn btn-sm" title={t('editTitle')} onClick={() => onBranch(entryId)}>{t('editFromHere')}</button>}
    </div>
  );
}

function MessageItem({ message, streaming, toolResults, tools, onFork, onBranch, onOpenFile, live }: Props) {
  const entryId = message._entryId;

  if (message.role === 'user') {
    const content = message.content;
    const bubble = typeof content === 'string' ? (
      <div className="msg-user">{content}</div>
    ) : (
      <div className="msg-user">
        {((Array.isArray(content) ? content : []) as Block[]).map((b, i) =>
          b.type === 'image' && b.data ? (
            <img key={i} src={`data:${b.mimeType};base64,${b.data}`} alt="attachment" />
          ) : (
            <span key={i}>{b.text}</span>
          ),
        )}
      </div>
    );
    return (
      <div className="msg-row user">
        {bubble}
        {!streaming && <MessageActions entryId={entryId} text={typeof content === 'string' ? content : ''} onFork={onFork} onBranch={onBranch} />}
      </div>
    );
  }

  if (message.role === 'toolResult') {
    // Rendered inside the matching ToolCard.
    return null;
  }

  // assistant
  const blocks = (Array.isArray(message.content) ? message.content : []) as Block[];
  const errorMessage = (message as { errorMessage?: string }).errorMessage;
  const stopReason = (message as { stopReason?: string }).stopReason;

  return (
    <div className="msg-row assistant">
      {streaming && live && (
        <div className="msg-live-header">
          {live.model && <span className="msg-live-model">{live.model}</span>}
          <span className="msg-live-tokens" title={t('liveCounter')}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
            </svg>
            {live.tokens}
          </span>
          <span
            className="msg-live-tps"
            style={{
              background:
                live.tps >= 50 ? '#53b3cb' : live.tps >= 30 ? '#9bc53d' : live.tps >= 15 ? '#f9c22e' : '#e01a4f',
            }}
          >
            {live.tps.toFixed(1)} t/s
          </span>
        </div>
      )}
      <div className="msg-assistant">
      {blocks.map((b, i) => {
        if (b.type === 'thinking') {
          const isStreamingThis = streaming && i === blocks.length - 1;
          const len = (b.thinking ?? '').length;
          return (
            <details key={i} className={`thinking-block ${isStreamingThis ? 'streaming' : ''}`} open={isStreamingThis}>
              <summary>
                {t('thinkingProcess')}
                {len > 0 && <span className="thinking-count">{len} {t('chars')}</span>}
              </summary>
              <div className="thinking-content">{b.thinking || t('thinkingEmpty')}</div>
            </details>
          );
        }
        if (b.type === 'text') {
          if (!b.text?.trim()) return null;
          return (
            <div key={i} className="md">
              <Markdown remarkPlugins={[remarkGfm]}>{b.text}</Markdown>
            </div>
          );
        }
        if (b.type === 'toolCall') {
          const result = b.id ? toolResults.get(b.id) : undefined;
          const activity = b.id ? tools.get(b.id) : undefined;
          return <ToolCard key={b.id ?? i} call={b as ToolCallBlock} result={result} activity={activity} onOpenFile={onOpenFile} />;
        }
        return null;
      })}
      {errorMessage && stopReason === 'error' && <div className="msg-error">{errorMessage}</div>}
      </div>
      {!streaming && (
        <MessageActions
          entryId={entryId}
          text={blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n')}
          onFork={onFork}
          onBranch={onBranch}
        />
      )}
    </div>
  );
}

export default memo(MessageItem);
