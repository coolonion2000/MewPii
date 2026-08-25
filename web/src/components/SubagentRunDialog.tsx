import { useEffect, useState } from 'react';
import { IconX, IconBot } from '../icons';
import { t } from '../i18n';

interface RunDetail {
  runId: string;
  agent: string;
  task: string;
  state: string;
  alive: boolean;
  cwd?: string;
  parentSessionPath?: string;
  startedAt?: number;
  lastUpdate?: number;
  log: string;
}

/** Live view of an in-flight pi-subagents run: task, state, streaming log. */
export default function SubagentRunDialog({ runId, onClose, onOpenParent }: {
  runId: string;
  onClose: () => void;
  onOpenParent?: (cwd: string, sessionPath: string) => void;
}) {
  const [detail, setDetail] = useState<RunDetail>();

  useEffect(() => {
    let alive = true;
    const load = () => {
      fetch(`/api/subagent-run?runId=${encodeURIComponent(runId)}`)
        .then(async (r) => {
          if (!r.ok) throw new Error(String(r.status));
          return r.json();
        })
        .then((d: RunDetail) => {
          if (alive) setDetail(d);
        })
        .catch(() => undefined);
    };
    load();
    const timer = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [runId]);

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal srun-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dp-head">
          <IconBot size={15} />
          <h3>{detail?.agent ?? 'subagent'}</h3>
          {detail && (
            <span className={`srun-state ${detail.alive ? 'alive' : ''}`}>
              {detail.alive ? `● ${t('running')}` : detail.state}
            </span>
          )}
          <span className="spacer" />
          {detail?.parentSessionPath && detail.cwd && onOpenParent && (
            <button
              className="btn btn-sm"
              onClick={() => onOpenParent(detail.cwd!, detail.parentSessionPath!)}
            >
              {t('subagentOpenParent2')}
            </button>
          )}
          <button className="btn btn-icon" onClick={onClose}><IconX size={13} /></button>
        </div>
        {detail?.task && <div className="srun-task">{detail.task}</div>}
        <div className="srun-log mono">
          {detail?.log?.trim() ? detail.log : <span className="dim">{t('subagentNoLog')}</span>}
        </div>
      </div>
    </div>
  );
}
