/** In-flow summary above the composer. @author coolonion */
import { useEffect, useRef, useState } from 'react';
import { IconBot } from '../icons';
import { t } from '../i18n';
import { useSubagents } from '../subagent-store';
import SubagentStatus from './SubagentStatus';

export default function SubagentPanel() {
  const { runs, open: openRun, error } = useSubagents();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!anchor.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape); };
  }, [open]);
  if (!runs.length) return null;
  const running = error ? 0 : runs.filter(run => run.presentation.effectiveState === 'running').length;
  return <div className="subagent-summary" ref={anchor}>
    <button className="subagent-summary-toggle" onClick={() => setOpen(value => !value)} aria-expanded={open}>
      <IconBot size={14} /><span>{t('subagentTask')} · {runs.length}</span><span className="dim">{error ? t('subagentUnknown') : running ? t('subagentsRunning', { n: String(running) }) : t('subagentViewDetails')}</span><span aria-hidden="true">⌃</span>
    </button>
    {open && <div className="subagent-summary-list">
      {runs.map(run => <button key={run.id} onClick={() => { openRun(run.id); setOpen(false); }}>
        <span className="subagent-run-label"><span>{run.presentation.title || run.name}</span>
          {run.presentation.workflow?.startedAt && <time className="dim">{new Date(run.presentation.workflow.startedAt).toLocaleString()}</time>}
        </span><SubagentStatus presentation={run.presentation} unavailable={error} />
      </button>)}
    </div>}
  </div>;
}
