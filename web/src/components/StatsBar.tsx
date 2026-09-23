import { useEffect, useId, useRef, useState } from 'react';
import type { Conversation } from '../api';
import { stripAnsi } from '../api';
import { t } from '../i18n';

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

function StatRow({ label, value }: { label: string; value: string }) {
  return <div className="stats-detail-row"><span>{label}</span><strong>{value}</strong></div>;
}

/** Compact footer with separate session, lifetime-token and environment details. */
export default function StatsBar({ conv }: { conv: Conversation }) {
  const [open, setOpen] = useState<'session' | 'tokens' | 'environment' | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  useEffect(() => setOpen(null), [conv]);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(null);
    };
    document.addEventListener('pointerdown', closeOutside, true);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside, true);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const stats = conv.snapshot?.stats;
  const run = conv.runStats;
  const now = Date.now();
  const runEnd = run.endedAt ?? (run.agentStartedAt ? now : undefined);
  const hasRun = Boolean(run.agentStartedAt && runEnd);
  const statusItems = Object.entries(conv.statuses).map(([key, value]) => ({ key, value: stripAnsi(value) }));
  if (!stats && !hasRun && statusItems.length === 0) return null;

  const rounds = stats?.userMessages ?? 0;
  const steps = stats?.toolCalls ?? run.steps;
  const totalMs = hasRun ? Math.max(0, runEnd! - run.agentStartedAt!) : 0;
  const nonToolMs = Math.max(0, totalMs - run.toolMs);
  const ttft = run.firstDeltaAt && run.agentStartedAt
    ? Math.max(0, run.firstDeltaAt - run.agentStartedAt)
    : undefined;
  // Pi streams characters, not token timestamps. This is an estimate, not provider TPS.
  const estimatedTokens = Math.round(run.outputChars / 3.5);
  const generationMs = run.firstDeltaAt && runEnd ? Math.max(500, runEnd - run.firstDeltaAt) : 0;
  const estimatedTps = generationMs > 0 ? Math.round(estimatedTokens / (generationMs / 1000)) : undefined;

  const inputTotal = stats
    ? stats.tokens.input + stats.tokens.cacheRead + stats.tokens.cacheWrite
    : 0;
  const cacheHit = inputTotal > 0 && stats
    ? Math.round(stats.tokens.cacheRead / inputTotal * 100)
    : undefined;

  const toggle = (panel: 'session' | 'tokens' | 'environment') =>
    setOpen((current) => current === panel ? null : panel);

  return (
    <div className="stats-footer" ref={rootRef}>
      {open && (
        <div className="stats-popover" id={panelId} role="region" aria-label={
          open === 'session' ? t('sessionStats') : open === 'tokens' ? t('tokenStats') : t('runtimeStatus')
        }>
          {open === 'session' && (stats || hasRun) && <>
            <div className="stats-popover-title">{t('sessionStats')}</div>
            <StatRow label={t('rounds')} value={String(rounds)} />
            <StatRow label={t('steps')} value={String(steps)} />
            {hasRun && <>
              <div className="stats-popover-subtitle">{run.endedAt ? t('lastRun') : t('currentRun')}</div>
              <StatRow label={t('elapsedTime')} value={fmtDur(totalMs)} />
              <StatRow label={t('nonToolTime')} value={fmtDur(nonToolMs)} />
              <StatRow label={t('toolTime')} value={fmtDur(run.toolMs)} />
              {ttft !== undefined && <StatRow label={t('ttft')} value={`${(ttft / 1000).toFixed(1)}s`} />}
              {estimatedTps !== undefined && <StatRow label={t('estimatedTps')} value={`~${estimatedTps} tok/s`} />}
            </>}
          </>}
          {open === 'tokens' && stats && <>
            <div className="stats-popover-title">{t('tokenStats')} <small>{t('sessionCumulative')}</small></div>
            <StatRow label={t('inputTok')} value={fmtNum(stats.tokens.input)} />
            <StatRow label={t('outputTok')} value={fmtNum(stats.tokens.output)} />
            <StatRow label={t('cacheRead')} value={fmtNum(stats.tokens.cacheRead)} />
            <StatRow label={t('cacheWrite')} value={fmtNum(stats.tokens.cacheWrite)} />
            {cacheHit !== undefined && <StatRow label={t('cacheHit')} value={`${cacheHit}%`} />}
            <StatRow label={t('totalTokens')} value={fmtNum(stats.tokens.total)} />
            {stats.cost > 0 && <StatRow label={t('cost')} value={`$${stats.cost.toFixed(4)}`} />}
            {stats.contextPercent != null && <StatRow label={t('context')} value={`${Math.round(stats.contextPercent)}%`} />}
          </>}
          {open === 'environment' && statusItems.length > 0 && <>
            <div className="stats-popover-title">{t('runtimeStatus')}</div>
            {statusItems.map(({ key, value }) => <StatRow key={key} label={key} value={value} />)}
          </>}
        </div>
      )}
      <div className="stats-chip-row">
        {(stats || hasRun) && (
          <button type="button" className={`stats-chip ${open === 'session' ? 'active' : ''}`}
            aria-expanded={open === 'session'} aria-controls={panelId} onClick={() => toggle('session')}>
            {t('sessionStats')} · {rounds} {t('rounds')} {steps} {t('steps')}{estimatedTps !== undefined ? ` · ~${estimatedTps} tok/s` : ''}
          </button>
        )}
        {stats && (
          <button type="button" className={`stats-chip ${open === 'tokens' ? 'active' : ''}`}
            aria-expanded={open === 'tokens'} aria-controls={panelId} onClick={() => toggle('tokens')}>
            {t('tokenStats')} · {fmtNum(stats.tokens.total)} tok{cacheHit !== undefined ? ` · ${t('cacheHit')} ${cacheHit}%` : ''}
          </button>
        )}
        {statusItems.length > 0 && (
          <button type="button" className={`stats-chip ${open === 'environment' ? 'active' : ''}`}
            aria-expanded={open === 'environment'} aria-controls={panelId} onClick={() => toggle('environment')}>
            {t('runtimeStatus')} · {statusItems.length}
          </button>
        )}
      </div>
    </div>
  );
}
