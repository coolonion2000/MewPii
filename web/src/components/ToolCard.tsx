import { memo, useMemo, useState } from 'react';
import type { PiiMessage } from '../types';
import { stripAnsi, type ToolActivity } from '../api';
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

function ToolCard({ call, result, activity, onOpenFile }: Props) {
  // auto-open while the tool is running, collapse when done (unless user toggled)
  const [userToggled, setUserToggled] = useState<boolean>();
  const rawName = call.name ?? activity?.toolName;
  const name = typeof rawName === 'string' ? rawName : 'tool';
  const rawArgs = call.arguments ?? activity?.args;
  const args = isContentBlock(rawArgs) ? rawArgs : undefined;
  const running = activity?.running ?? (!result && Boolean(call.id));
  const open = userToggled ?? running;
  const error = Boolean(result?.isError) || activity?.isError;
  const headline = headlineArg(name, args);

  let inputNode: React.ReactNode = null;
  let showOutput = '';
  if (open) {
    const { text: output, diff } = resultText(result);
    showOutput = preferredToolOutput(diff, output, activity?.liveOutput, running);
  }
  // Finalized cards are collapsed by default. Avoid stripping potentially
  // large outputs and formatting tool arguments until the body is visible.
  if (open && args) {
    if (name === 'bash') inputNode = <DiffPre text={String(args.command ?? '')} />;
    else if (name === 'write') inputNode = <DiffPre text={String(args.content ?? '')} />;
    else if (name === 'edit') inputNode = <EditInput args={args} />;
    else inputNode = <DiffPre text={JSON.stringify(args, null, 2)} />;
  }

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
            {showOutput ? (
              <DiffPre text={showOutput} isError={error} />
            ) : (
              <div style={{ color: 'var(--dsw-alias-label-caption)', fontSize: 12 }}>{t('executing')}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(ToolCard, sameToolCardMemoInputs);
