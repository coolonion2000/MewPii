import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';

export interface RunInfo {
  sessionFile?: string;
  cwd: string;
  title: string;
  modelName?: string;
  startedAt: number | null;
  isStreaming: boolean;
  queued: number;
}

function fmtDur(startedAt: number | null, now: number): string {
  if (!startedAt) return '';
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}小时${m % 60}分`;
  if (m > 0) return `${m}分${s % 60}秒`;
  return `${s}秒`;
}

/** dsh-style "N background tasks running" chip with a dropdown panel. */
export default function RunsChip({ onOpenRun }: { onOpenRun: (run: RunInfo) => void }) {
  const [runs, setRuns] = useState<RunInfo[]>([]);
  const [open, setOpen] = useState(false);
  const [, force] = useState(0);
  const anchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      fetch('/api/runs')
        .then((r) => r.json())
        .then((d: { runs?: RunInfo[] }) => {
          if (alive) setRuns(d.runs ?? []);
        })
        .catch(() => undefined);
    };
    load();
    const timer = setInterval(load, 5000);
    const tick = setInterval(() => alive && force((x) => x + 1), 1000);
    return () => {
      alive = false;
      clearInterval(timer);
      clearInterval(tick);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (anchorRef.current && !anchorRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const active = runs.filter((r) => r.isStreaming).length;
  if (runs.length === 0) return null;
  const now = Date.now();

  return (
    <div className="menu-anchor" ref={anchorRef}>
      <button className="btn btn-sm runs-chip" onClick={() => setOpen((o) => !o)}>
        {active > 0 && <span className="runs-dot" />}
        {active > 0 ? t('runsActive', { n: String(active) }) : t('runsIdle', { n: String(runs.length) })}
      </button>
      {open && (
        <div className="menu runs-panel" onClick={(e) => e.stopPropagation()}>
          {runs.map((r, i) => (
            <button
              key={r.sessionFile ?? i}
              className="run-row"
              onClick={() => {
                setOpen(false);
                onOpenRun(r);
              }}
            >
              <span className={`run-status ${r.isStreaming ? 'running' : 'idle'}`} />
              <span className="run-title">{r.title}</span>
              <span className="run-meta">
                {r.isStreaming ? t('running') : t('idle')}
                {r.modelName ? ` · ${r.modelName}` : ''}
                {r.queued > 0 ? ` · +${r.queued}` : ''}
              </span>
              <span className="run-dur mono">{fmtDur(r.startedAt, now)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
