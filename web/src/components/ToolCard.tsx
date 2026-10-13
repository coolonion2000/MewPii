import { memo, useEffect, useMemo, useState } from 'react';
import SubagentTaskCard from './SubagentTaskCard';
import ImagePreview from './ImagePreview';
import type { PiiMessage } from '../types';
import { stripAnsi, type ToolActivity } from '../api';
import { imageDataUrl } from '../image-preview-utils';
import { hasToolResultImage, toolResultContent } from '../tool-result-content';
import { t } from '../i18n';
import { ToolIcon, IconChevronRight, type ToolIconName } from '../icons';
import {
  isContentBlock,
  MAX_NUMBERED_CODE_LINES,
  preferredToolOutput,
  sameToolCardMemoInputs,
  validContentBlocks,
} from '../ui-reliability';

export interface ToolCallBlock {
  type: 'toolCall';
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

interface Props {
  call: ToolCallBlock;
  result?: PiiMessage;
  activity?: ToolActivity;
  onOpenFile?: (path: string) => void;
  /** Memo invalidation key for labels read from the global i18n catalog. */
  language: string;
}



interface EditEntry {
  oldText?: string;
  newText?: string;
}

/** Short human-readable headline argument for the collapsed header. */
function headlineArg(name: string, args?: Record<string, unknown>): string {
  if (!args) return '';
  const pick = (k: string) => (typeof args[k] === 'string' ? String(args[k]) : undefined);
  switch (name) {
    case 'read':
    case 'write':
    case 'edit':
      return pick('path') ?? pick('file_path') ?? '';
    case 'bash': {
      const cmd = pick('command') ?? '';
      return cmd.length > 80 ? cmd.slice(0, 80) + '\u2026' : cmd;
    }
    case 'grep':
      return pick('pattern') ?? '';
    case 'find':
      return pick('pattern') ?? pick('path') ?? '';
    case 'ls':
      return pick('path') ?? '.';
    default:
      return '';
  }
}

function resultText(result?: PiiMessage): { text: string; isError: boolean; diff?: string } {
  if (!result) return { text: '', isError: false };
  const content = result.content;
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = validContentBlocks(content)
      .filter((block) => block.type === 'text')
      .map((block) => typeof block.text === 'string' ? block.text : '')
      .join('\n');
  }
  const details = (result as { details?: { diff?: string } }).details;
  return { text: stripAnsi(text), isError: Boolean(result.isError), diff: details?.diff };
}

/** Renders text with diff line coloring. */
export function DiffPre({ text, isError, className }: { text: string; isError?: boolean; className?: string }) {
  const lines = useMemo(() => {
    let count = 1;
    for (let index = 0; index < text.length && count <= MAX_NUMBERED_CODE_LINES; index++) {
      if (text.charCodeAt(index) === 10) count += 1;
    }
    return count <= MAX_NUMBERED_CODE_LINES ? text.split('\n') : undefined;
  }, [text]);
  return (
    <pre className={`tool-pre ${isError ? 'is-error' : ''} ${className ?? ''}`}>
      {lines ? lines.map((line, i) => {
        const cls =
          line.startsWith('+') && !line.startsWith('+++')
            ? 'diff-add'
            : line.startsWith('-') && !line.startsWith('---')
              ? 'diff-del'
              : '';
        return <div key={i} className={cls}>{line}</div>;
      }) : text}
    </pre>
  );
}

/** edit tool input: render each edits[] entry as -old/+new pair. */
function EditInput({ args }: { args: Record<string, unknown> }) {
  const edits = [...(Array.isArray(args.edits) ? args.edits : [])] as EditEntry[];
  if (edits.length === 0 && typeof args.oldText === 'string') {
    edits.push({ oldText: args.oldText, newText: args.newText as string });
  }
  return (
    <div>
      {edits.map((e, i) => (
        <div key={i} className="edit-pair">
          {edits.length > 1 && <div className="tool-section-label">#{i + 1}</div>}
          <pre className="tool-pre">
            {String(e.oldText ?? '').split('\n').map((l, j) => (
              <div key={`o${j}`} className="diff-del">- {l}</div>
            ))}
            {String(e.newText ?? '').split('\n').map((l, j) => (
              <div key={`n${j}`} className="diff-add">+ {l}</div>
            ))}
          </pre>
        </div>
      ))}
    </div>
  );
}

function ToolResultImage({ data, mimeType }: { data: string; mimeType?: unknown }) {
  const src = useMemo(() => imageDataUrl(data, mimeType), [data, mimeType]);
  const [failed, setFailed] = useState(false);
  const [preview, setPreview] = useState(false);
  useEffect(() => { setFailed(false); setPreview(false); }, [src]);
  return <>
    <button type="button" className="tool-result-image" aria-label={t('imagePreview')} onClick={() => setPreview(true)}>
      {failed ? <span className="tool-output-empty">{t('imageLoadFailed')}</span> :
        <img src={src} alt={t('imagePreview')} loading="lazy" decoding="async" onError={() => setFailed(true)} />}
    </button>
    {preview && <ImagePreview src={src} onClose={() => setPreview(false)} />}
  </>;
}

function ToolCard({ call, result, activity, onOpenFile }: Props) {
  // Image results stay visible after completion, including restored history.
  // Explicit folding wins and unmounts the images/preview to avoid hidden work.
  const [userToggled, setUserToggled] = useState<boolean>();
  const hasImages = useMemo(() => hasToolResultImage(result?.content), [result?.content]);
  const rawName = call.name ?? activity?.toolName;
  const name = typeof rawName === 'string' ? rawName : 'tool';
  const rawArgs = call.arguments ?? activity?.args;
  const args = isContentBlock(rawArgs) ? rawArgs : undefined;
  const running = !result && (activity?.running ?? Boolean(call.id));
  const open = userToggled ?? (running || hasImages);
  const error = result ? Boolean(result.isError) : activity?.isError;
  const headline = headlineArg(name, args);

  let inputNode: React.ReactNode = null;
  let showOutput = '';
  if (name === 'subagent') {
    const { text: output, diff } = resultText(result);
    showOutput = preferredToolOutput(diff, output, activity?.liveOutput, running);
  }
  // Text-only finalized cards remain collapsed by default. Avoid formatting
  // large outputs and arguments until the body is visible.
  if (open && args) {
    if (name === 'bash') inputNode = <DiffPre text={String(args.command ?? '')} />;
    else if (name === 'write') inputNode = <DiffPre text={String(args.content ?? '')} />;
    else if (name === 'edit') inputNode = <EditInput args={args} />;
    else inputNode = <DiffPre text={JSON.stringify(args, null, 2)} />;
  }

  if (name === 'subagent') return <SubagentTaskCard call={call} output={showOutput} />;
  const details = isContentBlock(result?.details) ? result.details : undefined;
  const outputBlocks = open ? toolResultContent(result?.content, details?.diff) : [];
  if (open && !result && running && activity?.liveOutput) outputBlocks.push({ type: 'text', text: activity.liveOutput });
  return (
    <div className="tool-card">
      <div className="tool-card-header" onClick={() => setUserToggled(!open)}>
        <span className="tool-icon"><ToolIcon name={(name as ToolIconName) ?? 'tool'} /></span>
        <span className="tool-name">{name}</span>
        {onOpenFile && ['read', 'write', 'edit'].includes(name) && headline ? (
          <button
            className="tool-arg tool-arg-link"
            title={t('openFile')}
            onClick={(e) => {
              e.stopPropagation();
              onOpenFile(headline);
            }}
          >
            {headline}
          </button>
        ) : (
          <span className="tool-arg">{headline}</span>
        )}
        <span className={`tool-status ${running ? 'running' : error ? 'error' : 'ok'}`} />
        <span className={`tool-chevron ${open ? 'open' : ''}`}><IconChevronRight size={11} /></span>
      </div>
      {open && (
        <div className="tool-card-body">
          {inputNode && (
            <div className="tool-section">
              <div className="tool-section-label">{t('input')}</div>
              {inputNode}
            </div>
          )}
          <div className="tool-section">
            <div className="tool-section-label">{t('output')}</div>
            <div className="tool-output-content">
              {outputBlocks.length ? outputBlocks.map((block, index) => block.type === 'text'
                ? <DiffPre key={index} text={stripAnsi(block.text)} isError={error} />
                : block.type === 'image'
                  ? <ToolResultImage key={index} data={block.data} mimeType={block.mimeType} />
                  : <div key={index} className="tool-output-empty">{t('imageLoadFailed')}</div>)
                : <div className="tool-output-empty">{t(running ? 'executing' : 'toolNoOutput')}</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(ToolCard, sameToolCardMemoInputs);
