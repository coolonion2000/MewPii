import { useEffect, useReducer } from 'react';
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

/** dsh-style trajectory stats bar: rounds · steps | LLM · tool time | TTFT · tok/s | cache hit | tokens | cost | context */
export default function StatsBar({ conv }: { conv: Conversation }) {
  const [, force] = useReducer((x: number) => x + 1, 0);
  const streaming = Boolean(conv.snapshot?.isStreaming);

  // 1s ticker while streaming so elapsed/tok-s update live
  useEffect(() => {
    if (!streaming) return;
    const timer = setInterval(force, 1000);
    return () => clearInterval(timer);
  }, [streaming]);

  const stats = conv.snapshot?.stats;
  const run = conv.runStats;
  const hasRun = run.agentStartedAt !== undefined;
  if (!stats && !hasRun) return null;

  const now = Date.now();
  const parts: string[] = [];

  // rounds & steps
  const rounds = stats?.userMessages ?? 0;
  const steps = (stats?.toolCalls ?? 0) || run.steps;
  if (rounds || steps) parts.push(`${rounds} ${t('rounds')} · ${steps} ${t('steps')}`);

  // timing (live or last run)
  if (hasRun) {
    const totalMs = (streaming ? now : now) - (run.agentStartedAt ?? now);
    const llmMs = streaming ? Math.max(0, totalMs - run.toolMs) : run.llmMs;
    const seg = [`LLM ${fmtDur(llmMs)}`];
    if (run.toolMs > 0) seg.push(`${t('toolTime')} ${fmtDur(run.toolMs)}`);
    parts.push(seg.join(' · '));

    const ttft = run.firstDeltaAt && run.agentStartedAt ? run.firstDeltaAt - run.agentStartedAt : undefined;
    if (ttft !== undefined) {
      const estTokens = Math.round(run.outputChars / 3.5);
      const genSec = Math.max(0.5, ((streaming ? now : (run.agentStartedAt ?? now) + run.llmMs) - (run.firstDeltaAt ?? now)) / 1000);
      const tps = Math.round(estTokens / genSec);
      parts.push(`${t('ttft')} ${(ttft / 1000).toFixed(1)}s · ${tps} tok/s`);
    }
  }

  // tokens & cache & cost
  if (stats && stats.tokens.total > 0) {
    const inputTotal = stats.tokens.input + stats.tokens.cacheRead + stats.tokens.cacheWrite;
    const hit = inputTotal > 0 ? Math.round((stats.tokens.cacheRead / inputTotal) * 100) : 0;
    if (inputTotal > 0) parts.push(`${t('cacheHit')} ${hit}%`);
    parts.push(`${t('inputTok')} ${fmtNum(inputTotal)} tok · ${t('outputTok')} ${fmtNum(stats.tokens.output)} tok`);
    if (stats.cost > 0) parts.push(`$${stats.cost.toFixed(4)}`);
  }

  if (stats?.contextPercent != null) parts.push(`${t('context')} ${Math.round(stats.contextPercent)}%`);

  // extension-published statuses (MCP, ADHD, LSP, ...) join the same line
  const statusItems = Object.entries(conv.statuses).map(([key, value]) => (
    <span key={key} className="stats-seg status-seg" title={key}>{stripAnsi(value)}</span>
  ));

  return (
    <div className="stats-bar">
      {parts.map((p, i) => <span key={i} className="stats-seg">{p}</span>)}
      {statusItems}
    </div>
  );
}
