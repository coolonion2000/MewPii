import { useState } from 'react';
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

export default function MessageItem({ message, streaming, toolResults, tools, onFork, onBranch }: Props) {
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
          return <ToolCard key={b.id ?? i} call={b as ToolCallBlock} result={result} activity={activity} />;
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
