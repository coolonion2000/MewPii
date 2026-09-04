import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';

export interface ActiveExec {
  toolName: string;
  summary: string;
  startedAt: number;
}

export interface RunInfo {
  sessionFile?: string;
  cwd: string;
  title: string;
  modelName?: string;
  startedAt: number | null;
  isStreaming: boolean;
  queued: number;
  active?: ActiveExec[];
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let generation = 0;
    const schedule = (delayMs: number) => {
      clearTimeout(timer);
      if (alive && !document.hidden)
        timer = setTimeout(() => void load(), delayMs);
    };
    const load = async () => {
      if (!alive || document.hidden) return;
      controller?.abort();
      const request = new AbortController();
      const currentGeneration = ++generation;
      controller = request;
      let nextDelay = 15_000;
      try {
        const response = await fetch('/api/runs', { signal: request.signal });
        const data = (await response.json()) as { runs?: RunInfo[] };
        if (!alive || currentGeneration !== generation) return;
        const next = data.runs ?? [];
        setRuns(next);
        if (next.some((run) => run.isStreaming)) nextDelay = 5_000;
      } catch {
        // A hidden tab aborts its request; visibility restoration reloads it.
      } finally {
        if (currentGeneration === generation) schedule(nextDelay);
      }
    };
    const onVisibility = () => {
      clearTimeout(timer);
      if (document.hidden) {
        generation++;
        controller?.abort();
      }
      else void load();
    };
    void load();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      alive = false;
      generation++;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
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
  useEffect(() => {
    if (!open || active === 0) return;
    let tick: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(tick);
      if (document.hidden) return;
      tick = setTimeout(() => {
        force((value) => value + 1);
        schedule();
      }, 1000);
    };
    const onVisibility = () => schedule();
    schedule();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearTimeout(tick);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [active, open]);

  // only surface the chip when something is actually running; idle hosts are noise
  if (active === 0) return null;
  const now = Date.now();

  return (
    <div className="menu-anchor" ref={anchorRef}>
      <button className="btn btn-sm runs-chip" onClick={() => setOpen((o) => !o)}>
        {active > 0 && <span className="runs-dot" />}
        {active > 0 ? t('runsActive', { n: String(active) }) : t('runsIdle', { n: String(runs.length) })}
      </button>
      {open && (
        <div className="menu menu-down runs-panel" onClick={(e) => e.stopPropagation()}>
          {runs.map((r, i) => (
            <button
              key={r.sessionFile ?? i}
              className="run-row"
              onClick={() => {
                setOpen(false);
                onOpenRun(r);
              }}
            >
              <span className={`run-status ${r.active?.length ? 'exec' : r.isStreaming ? 'running' : 'idle'}`} />
              <div className="run-main">
                <div className="run-title">{r.title}</div>
                {r.active?.length ? (
                  r.active.map((a, j) => (
                    <div key={j} className="run-exec">
                      <span className="mono run-exec-tool">{a.toolName}</span>
                      <span className="run-exec-summary">{a.summary}</span>
                      <span className="run-exec-dur mono">{fmtDur(a.startedAt, now)}</span>
                    </div>
                  ))
                ) : r.isStreaming ? (
                  <div className="run-exec"><span className="run-exec-summary">{t('waitingModel')}…</span></div>
                ) : (
                  <div className="run-exec"><span className="run-exec-summary">{t('idle')}</span></div>
                )}
              </div>
              {r.queued > 0 && <span className="run-queued">+{r.queued}</span>}
              <span className="run-dur mono">{fmtDur(r.startedAt, now)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
