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
  steps?: { key: string; state: string; durationMs?: number; agent?: string; tokens?: number; cost?: number }[];
}

/** Compact elapsed-time string ("8分32秒"). */
function fmtDur(startedAt: number, now: number): string {
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}小时${m % 60}分`;
  if (m > 0) return `${m}分${s % 60}秒`;
  return `${s}秒`;
}

/** Compact number formatting (12.3k / 4.5M). */
function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

/** Live view of an in-flight pi-subagents run: task, state, streaming log. */
export default function SubagentRunDialog({ runId, onClose, onOpenParent }: {
  runId: string;
  onClose: () => void;
  onOpenParent?: (cwd: string, sessionPath: string) => void;
}) {
  const [detail, setDetail] = useState<RunDetail>();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

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
          {detail?.startedAt != null && (
            <span className="srun-elapsed mono">{fmtDur(detail.startedAt, now)}</span>
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
        {detail?.steps && detail.steps.length > 0 && (
          <div className="srun-steps">
            {detail.steps.map((st, i) => (
              <div key={st.key} className="srun-step">
                <span className={`srun-step-state ${st.state}`}>
                  {st.state === 'completed' ? '✓' : st.state === 'started' || st.state === 'running' ? '◔' : '·'}
                </span>
                <span className="srun-step-key mono">Step {i + 1}/{detail.steps!.length}: {st.key}</span>
                <span className={`srun-step-label ${st.state}`}>{st.state}</span>
                <span className="srun-step-meta mono">
                  {st.tokens !== undefined && st.tokens > 0 ? `${fmtNum(st.tokens)} tok` : ''}
                  {st.cost !== undefined && st.cost > 0 ? ` · $${st.cost.toFixed(4)}` : ''}
                </span>
                {st.durationMs !== undefined && (
                  <span className="srun-step-dur mono">{(st.durationMs / 1000).toFixed(1)}s</span>
                )}
              </div>
            ))}
          </div>
        )}
        <div className="srun-log mono">
          {detail?.log?.trim() ? detail.log : <span className="dim">{t('subagentNoLog')}</span>}
        </div>
      </div>
    </div>
  );
}
