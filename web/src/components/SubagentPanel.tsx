import { useEffect, useState } from 'react';
import { IconBot, IconX } from '../icons';
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

/** Right-rail panel showing subagent runs of the CURRENT session. */
export default function SubagentPanel({ sessionFile, cwd, onOpenParent }: {
  sessionFile?: string;
  cwd: string;
  onOpenParent?: (cwd: string, sessionPath: string) => void;
}) {
  const [runs, setRuns] = useState<RunEntry[]>([]);
  const [dialogId, setDialogId] = useState<string>();
  const [collapsed, setCollapsed] = useState(true);
  const runningCount = runs.filter((r) => r.running).length;
  useEffect(() => {
    // auto-expand while any subagent runs, auto-collapse when all finish
    setCollapsed(runningCount === 0);
  }, [runningCount > 0]);

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

  if (runs.length === 0) return null;

  return (
    <div className="subagent-panel">
      <button className="subagent-panel-head" onClick={() => setCollapsed((c) => !c)}>
        <IconBot size={13} />
        <span>{runningCount > 0 ? t('subagentsRunning', { n: String(runningCount) }) : t('subagentsRecent', { n: String(runs.length) })}</span>
        <span className="spacer" />
        <IconX size={11} style={{ transform: collapsed ? 'rotate(45deg)' : undefined }} />
      </button>
      {!collapsed && (
        <div className="subagent-panel-list">
          {runs.map((r) => (
            <button
              key={r.path}
              className="subagent-panel-row"
              onClick={() => setDialogId(r.path.replace('pi-subagents-run://', ''))}
            >
              <span className={`subagent-dot ${r.running ? 'run' : 'done'}`} />
              <span className="subagent-panel-name">{r.name}</span>
              <span className={`subagent-panel-state ${r.running ? 'run' : ''}`}>{r.running ? t('running') : (r.runState ?? 'done')}</span>
            </button>
          ))}
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
