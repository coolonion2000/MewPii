import { useMemo, useState } from 'react';
import type { PiiMessage } from '../types';
import type { ToolActivity } from '../api';
import { t } from '../i18n';

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
}

const TOOL_ICONS: Record<string, string> = {
  read: 'R',
  bash: '›_',
  edit: 'E',
  write: 'W',
  grep: 'G',
  find: 'F',
  ls: 'L',
};

/** Short human-readable headline argument for the collapsed header. */
function headlineArg(name: string, args?: Record<string, unknown>): string {
  if (!args) return '';
  const pick = (k: string) => (typeof args[k] === 'string' ? String(args[k]) : undefined);
  switch (name) {
    case 'read':
    case 'write':
    case 'edit':
      return pick('path') ?? '';
    case 'bash': {
      const cmd = pick('command') ?? '';
      return cmd.length > 80 ? cmd.slice(0, 80) + '…' : cmd;
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

function resultText(result?: PiiMessage): { text: string; isError: boolean } {
  if (!result) return { text: '', isError: false };
  const content = result.content;
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content
      .map((b) => (b as { type?: string; text?: string }))
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('\n');
  }
  return { text, isError: Boolean(result.isError) };
}

function diffLines(text: string): boolean {
  return text.split('\n').some((l) => l.startsWith('+') || l.startsWith('-'));
}

function ColorizedPre({ text, isError }: { text: string; isError?: boolean }) {
  const colored = useMemo(() => diffLines(text), [text]);
  if (!colored) return <pre className={`tool-pre ${isError ? 'is-error' : ''}`}>{text}</pre>;
  return (
    <pre className="tool-pre">
      {text.split('\n').map((line, i) => {
        const cls = line.startsWith('+') && !line.startsWith('+++') ? 'diff-add'
          : line.startsWith('-') && !line.startsWith('---') ? 'diff-del'
          : '';
        return cls ? <div key={i} className={cls}>{line}</div> : <div key={i}>{line}</div>;
      })}
    </pre>
  );
}

export default function ToolCard({ call, result, activity }: Props) {
  const [open, setOpen] = useState(false);
  const name = call.name ?? activity?.toolName ?? 'tool';
  const args = call.arguments ?? activity?.args;
  const running = activity?.running ?? (!result && Boolean(call.id));
  const { text: output, isError } = resultText(result);
  const error = isError || activity?.isError;

  // input section: command / content / patch depending on tool
  let inputText = '';
  if (args) {
    if (name === 'bash') inputText = String(args.command ?? '');
    else if (name === 'write') inputText = String(args.content ?? '');
    else if (name === 'edit') inputText = String(args.oldText ?? '') + '\n→\n' + String(args.newText ?? '');
    else inputText = JSON.stringify(args, null, 2);
  }

  return (
    <div className="tool-card">
      <div className="tool-card-header" onClick={() => setOpen((o) => !o)}>
        <span className="tool-icon">{TOOL_ICONS[name] ?? 'T'}</span>
        <span className="tool-name">{name}</span>
        <span className="tool-arg">{headlineArg(name, args)}</span>
        <span className={`tool-status ${running ? 'running' : error ? 'error' : 'ok'}`} />
        <span className={`tool-chevron ${open ? 'open' : ''}`}>▸</span>
      </div>
      {open && (
        <div className="tool-card-body">
          {inputText && (
            <div className="tool-section">
              <div className="tool-section-label">{t('input')}</div>
              <ColorizedPre text={inputText} />
            </div>
          )}
          {(output || running) && (
            <div className="tool-section">
              <div className="tool-section-label">{t('output')}</div>
              {output ? (
                <ColorizedPre text={output} isError={error} />
              ) : (
                <div style={{ color: 'var(--dsw-alias-label-caption)', fontSize: 12 }}>{t('executing')}</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
