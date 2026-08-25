import { useEffect, useRef, useState } from 'react';
import { IconChevronDown, IconBot } from '../icons';
import { t } from '../i18n';
import SubagentRunDialog from './SubagentRunDialog';

interface RunEntry {
  path: string;
  name?: string;
  running?: boolean;
  runState?: string;
  parentSessionPath?: string;
  cwd: string;
}

/** Floating subagent indicator at the left of the composer; click to expand a popover. */
export default function SubagentPanel({ sessionFile, cwd, onOpenParent }: {
  sessionFile?: string;
  cwd: string;
  onOpenParent?: (cwd: string, sessionPath: string) => void;
}) {
  const [runs, setRuns] = useState<RunEntry[]>([]);
  const [dialogId, setDialogId] = useState<string>();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sessionFile) {
      setRuns([]);
      return;
    }
    let alive = true;
    const load = () => {
      fetch(`/api/subagent-runs?parent=${encodeURIComponent(sessionFile)}`)
        .then((r) => r.json())
        .then((d: { runs?: RunEntry[] }) => {
          if (alive) {
            const list = d.runs ?? [];
            list.sort((a, b) => Number(b.running ?? false) - Number(a.running ?? false));
            setRuns(list);
          }
        })
        .catch(() => undefined);
    };
    load();
    const timer = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [sessionFile]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (anchorRef.current && !anchorRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const runningCount = runs.filter((r) => r.running).length;
  if (runs.length === 0) return null;

  return (
    <div className="subagent-fab-anchor" ref={anchorRef}>
      <button
        className={`subagent-fab ${runningCount > 0 ? 'running' : ''}`}
        title={runningCount > 0 ? t('subagentsRunning', { n: String(runningCount) }) : t('subagentsRecent', { n: String(runs.length) })}
        onClick={() => setOpen((o) => !o)}
      >
        <IconChevronDown size={13} style={{ transform: 'rotate(180deg)' }} />
        {runningCount > 0 && <span className="subagent-fab-badge">{runningCount}</span>}
      </button>
      {open && (
        <div className="subagent-pop">
          <div className="subagent-pop-head">
            <IconBot size={13} />
            <span>{runningCount > 0 ? t('subagentsRunning', { n: String(runningCount) }) : t('subagentsRecent', { n: String(runs.length) })}</span>
          </div>
          <div className="subagent-panel-list">
            {runs.map((r) => (
              <button
                key={r.path}
                className="subagent-panel-row"
                onClick={() => {
                  setOpen(false);
                  setDialogId(r.path.replace('pi-subagents-run://', ''));
                }}
              >
                <span className={`subagent-dot ${r.running ? 'run' : 'done'}`} />
                <span className="subagent-panel-name">{r.name}</span>
                <span className={`subagent-panel-state ${r.running ? 'run' : ''}`}>{r.running ? t('running') : (r.runState ?? 'done')}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {dialogId && (
        <SubagentRunDialog
          runId={dialogId}
          onClose={() => setDialogId(undefined)}
          onOpenParent={onOpenParent}
        />
      )}
    </div>
  );
}
