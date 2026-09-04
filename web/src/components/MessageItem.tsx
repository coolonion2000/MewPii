import { memo, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconX } from '../icons';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { PiiMessage } from '../types';
import type { ToolActivity } from '../api';
import ToolCard, { type ToolCallBlock } from './ToolCard';
import { t } from '../i18n';
import {
  canRenderMessageMarkdown,
  isContentBlock,
} from '../ui-reliability';

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
  language: string;
  onFork: (entryId: string) => void;
  onBranch: (entryId: string) => void;
  onOpenFile?: (path: string) => void;
  /** live counter data for the streaming message header (pi-web style) */
  live?: { model?: string; tokens?: number; tps?: number } | undefined;
}

const MARKDOWN_PLUGINS = [remarkGfm];
const STREAMING_MARKDOWN_REFRESH_MS = 250;

/** Keep expensive Markdown parsing behind a primitive-prop memo boundary. */
const MarkdownBody = memo(function MarkdownBody({ text }: { text: string }) {
  return <Markdown remarkPlugins={MARKDOWN_PLUGINS}>{text}</Markdown>;
});

/**
 * Streaming deltas may arrive faster than Markdown can parse a growing block.
 * Refresh rich output at a bounded cadence, and fall back to a cheap text node
 * once the growing input exceeds the interactive parser budget. Finalized
 * messages render immediately, with their own cap for giant transcripts.
 */
const MessageMarkdown = memo(function MessageMarkdown({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  const latestText = useRef(text);
  latestText.current = text;
  const [streamingText, setStreamingText] = useState(text);

  useEffect(() => {
    if (!streaming) return;
    const timer = window.setInterval(() => {
      setStreamingText((current) => {
        const latest = latestText.current;
        return current === latest ? current : latest;
      });
    }, STREAMING_MARKDOWN_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [streaming]);

  const visibleText = streaming ? streamingText : text;
  if (!canRenderMessageMarkdown(text.length, streaming)) {
    return <pre className="message-plain-text">{visibleText}</pre>;
  }
  return <MarkdownBody text={visibleText} />;
});

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

function MessageItem({ message, streaming, toolResults, tools, language, onFork, onBranch, onOpenFile, live }: Props) {
  const [preview, setPreview] = useState<string>();
  const entryId = message._entryId;

  if (message.role === 'user') {
    const content = message.content;
    const bubble = typeof content === 'string' ? (
      <div className="msg-user">{content}</div>
    ) : (
      <div className="msg-user">
        {((Array.isArray(content) ? content.filter(isContentBlock) : []) as unknown as Block[]).map((b, i) =>
          b.type === 'image' && typeof b.data === 'string' ? (
            <img
              key={i}
              src={`data:${typeof b.mimeType === 'string' ? b.mimeType : 'image/png'};base64,${b.data}`}
              alt="attachment"
              style={{ cursor: 'zoom-in' }}
              onClick={() => setPreview(`data:${b.mimeType};base64,${b.data}`)}
            />
          ) : (
            <span key={i}>{typeof b.text === 'string' ? b.text : ''}</span>
          ),
        )}
      </div>
    );
    return (
      <div className="msg-row user">
        {bubble}
        {!streaming && <MessageActions entryId={entryId} text={typeof content === 'string' ? content : ''} onFork={onFork} onBranch={onBranch} />}
        {preview && createPortal(
          <div className="lightbox" onClick={() => setPreview(undefined)}>
            <button
              type="button"
              className="lightbox-close"
              aria-label={t('close')}
            >
              <IconX size={18} />
            </button>
            <img src={preview} alt="preview" onClick={(e) => e.stopPropagation()} />
          </div>,
          document.body,
        )}
      </div>
    );
  }

  if (message.role === 'toolResult' || message.role === 'custom') {
    // toolResults render inside their ToolCard; custom entries (extension
    // context injections like ADHD rules) are not conversation content.
    return null;
  }

  // assistant
  const blocks = (
    Array.isArray(message.content) ? message.content.filter(isContentBlock) : []
  ) as unknown as Block[];
  const errorMessage = (message as { errorMessage?: string }).errorMessage;
  const stopReason = (message as { stopReason?: string }).stopReason;

  return (
    <div className="msg-row assistant">
      {streaming && live && (
        <div className="msg-live-header" title={t('liveCounter')}>
          {live.model && <span className="msg-live-model">{live.model}</span>}
          {live.model && <span className="msg-live-separator" aria-hidden="true">·</span>}
          {live.tokens === undefined ? (
            <span className="msg-live-pending">
              <span className="msg-live-dot" aria-hidden="true" />
              {t('thinking')}…
            </span>
          ) : (
            <span className="msg-live-metrics">
              <span>≈{live.tokens} tok</span>
              {live.tps !== undefined && (
                <>
                  <span className="msg-live-separator" aria-hidden="true">·</span>
                  <span>{live.tps.toFixed(1)} tok/s</span>
                </>
              )}
            </span>
          )}
        </div>
      )}
      <div className="msg-assistant">
      {blocks.map((b, i) => {
        if (b.type === 'thinking') {
          const isStreamingThis = streaming && i === blocks.length - 1;
          const thinking = typeof b.thinking === 'string' ? b.thinking : '';
          const len = thinking.length;
          return (
            <details key={i} className={`thinking-block ${isStreamingThis ? 'streaming' : ''}`} open={isStreamingThis}>
              <summary>
                {t('thinkingProcess')}
                {len > 0 && <span className="thinking-count">{len} {t('chars')}</span>}
              </summary>
              <div className="thinking-content">{thinking || t('thinkingEmpty')}</div>
            </details>
          );
        }
        if (b.type === 'text') {
          const text = typeof b.text === 'string' ? b.text : '';
          if (!text.trim()) return null;
          return (
            <div key={i} className="md">
              <MessageMarkdown text={text} streaming={streaming} />
            </div>
          );
        }
        if (b.type === 'toolCall') {
          const result = b.id ? toolResults.get(b.id) : undefined;
          const activity = b.id ? tools.get(b.id) : undefined;
          return <ToolCard key={b.id ?? i} call={b as ToolCallBlock} result={result} activity={activity} onOpenFile={onOpenFile} language={language} />;
        }
        return null;
      })}
      {errorMessage && stopReason === 'error' && <div className="msg-error">{errorMessage}</div>}
      </div>
      {!streaming && (
        <MessageActions
          entryId={entryId}
          text={blocks
            .filter((b) => b.type === 'text')
            .map((b) => typeof b.text === 'string' ? b.text : '')
            .join('\n')}
          onFork={onFork}
          onBranch={onBranch}
        />
      )}
    </div>
  );
}

function toolCallIds(message: PiiMessage): string[] {
  if (!Array.isArray(message.content)) return [];
  return (message.content.filter(isContentBlock) as unknown as Block[])
    .filter((block) => block.type === 'toolCall' && Boolean(block.id))
    .map((block) => block.id as string);
}

function sameLiveMetrics(previous: Props['live'], next: Props['live']): boolean {
  return previous === next || (
    previous?.model === next?.model &&
    previous?.tokens === next?.tokens &&
    previous?.tps === next?.tps
  );
}

function sameMessageItem(previous: Props, next: Props): boolean {
  if (
    previous.message !== next.message ||
    previous.streaming !== next.streaming ||
    previous.language !== next.language ||
    previous.onFork !== next.onFork ||
    previous.onBranch !== next.onBranch ||
    previous.onOpenFile !== next.onOpenFile ||
    !sameLiveMetrics(previous.live, next.live)
  )
    return false;
  if (
    previous.toolResults === next.toolResults &&
    previous.tools === next.tools
  )
    return true;
  for (const id of toolCallIds(next.message)) {
    if (previous.toolResults.get(id) !== next.toolResults.get(id)) return false;
    if (previous.tools.get(id) !== next.tools.get(id)) return false;
  }
  return true;
}

export default memo(MessageItem, sameMessageItem);
