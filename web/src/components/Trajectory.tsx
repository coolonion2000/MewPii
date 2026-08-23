import { useMemo } from 'react';
import type { Conversation } from '../api';
import { stripAnsi } from '../api';
import type { PiiMessage } from '../types';
import { t } from '../i18n';

interface Step {
  key: string;
  at: number;
  durationMs?: number;
  kind: 'user' | 'assistant' | 'tool' | 'error';
  label: string;
  detail: string;
}

function fmtOffset(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `+${m}m${String(s % 60).padStart(2, '0')}s` : `+${s}s`;
}

function fmtDur(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

function textPreview(content: unknown, max = 60): string {
  if (typeof content === 'string') return content.slice(0, max);
  if (Array.isArray(content)) {
    for (const b of content as { type?: string; text?: string }[]) {
      if (b.type === 'text' && b.text?.trim()) return b.text.trim().slice(0, max);
    }
  }
  return '';
}

/** dsh-style trajectory: a step timeline of the whole session. */
export default function Trajectory({ conv }: { conv: Conversation }) {
  const steps = useMemo<Step[]>(() => {
    const msgs = conv.messages;
    const out: Step[] = [];
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      const at = (m as { timestamp?: number }).timestamp ?? 0;
      const next = msgs[i + 1] as { timestamp?: number } | undefined;
      const durationMs = next?.timestamp ? next.timestamp - at : undefined;

      if (m.role === 'user') {
        out.push({ key: `u${i}`, at, kind: 'user', label: 'user', detail: textPreview(m.content) });
      } else if (m.role === 'assistant') {
        const usage = (m as { usage?: { output?: number; input?: number } }).usage;
        const content = Array.isArray(m.content) ? (m.content as { type: string; name?: string }[]) : [];
        const toolNames = content.filter((b) => b.type === 'toolCall').map((b) => b.name).join(', ');
        const hasText = content.some((b) => b.type === 'text' && (b as { text?: string }).text?.trim());
        const hasThinking = content.some((b) => b.type === 'thinking');
        const parts = [
          String((m as { model?: string }).model ?? 'assistant'),
          hasThinking ? 'thinking' : '',
          hasText ? 'text' : '',
          toolNames ? `→ ${toolNames}` : '',
        ].filter(Boolean);
        const err = (m as { stopReason?: string }).stopReason === 'error';
        out.push({
          key: `a${i}`,
          at,
          durationMs,
          kind: err ? 'error' : 'assistant',
          label: 'LLM',
          detail: `${parts.join(' · ')}${usage?.output ? ` · ${usage.output} tok` : ''}${err ? ` · ${(m as { errorMessage?: string }).errorMessage ?? 'error'}` : ''}`,
        });
      } else if (m.role === 'toolResult') {
        const isError = Boolean((m as { isError?: boolean }).isError);
        out.push({
          key: `t${i}`,
          at,
          durationMs,
          kind: isError ? 'error' : 'tool',
          label: String((m as { toolName?: string }).toolName ?? 'tool'),
          detail: stripAnsi(textPreview(m.content, 80)),
        });
      }
    }
    return out;
  }, [conv.messages]);

  if (steps.length === 0) return <div className="dim" style={{ padding: 24 }}>—</div>;
  const t0 = steps[0].at;

  return (
    <div className="traj">
      <div className="traj-head traj-row">
        <span>+t</span>
        <span>{t('trajKind')}</span>
        <span>{t('trajContent')}</span>
        <span>{t('trajDuration')}</span>
      </div>
      {steps.map((s) => (
        <div key={s.key} className={`traj-row traj-${s.kind}`}>
          <span className="traj-time mono">{fmtOffset(s.at - t0)}</span>
          <span className={`traj-tag tag-${s.kind}`} title={s.label}>{s.label}</span>
          <span className="traj-detail">{s.detail}</span>
          <span className="traj-dur mono">{s.durationMs !== undefined ? fmtDur(s.durationMs) : '…'}</span>
        </div>
      ))}
      {conv.snapshot?.isStreaming && (
        <div className="traj-row traj-assistant">
          <span className="traj-time mono">…</span>
          <span className="traj-tag tag-assistant">LLM</span>
          <span className="traj-detail">{t('running')}…</span>
          <span className="traj-dur mono" />
        </div>
      )}
    </div>
  );
}
