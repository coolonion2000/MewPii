/** Do not infer successful compaction from a generic settled/idle event. @author coolonion */
import type { CompactionState } from './protocol.js';
export function updateCompactionState(previous: CompactionState | undefined,
  event: { type: string; reason?: string; aborted?: boolean; errorMessage?: string;
    result?: { tokensBefore?: number; estimatedTokensAfter?: number }; willRetry?: boolean },
  now = Date.now()): CompactionState | undefined {
  if (event.type === 'compaction_start') return { status: 'running', reason: event.reason ?? 'unknown', startedAt: now };
  if (event.type !== 'compaction_end') return previous;
  return { status: event.aborted ? 'cancelled' : event.errorMessage || !event.result ? 'failed' : 'completed',
    reason: event.reason ?? previous?.reason ?? 'unknown', startedAt: previous?.startedAt, endedAt: now,
    tokensBefore: event.result?.tokensBefore, estimatedTokensAfter: event.result?.estimatedTokensAfter,
    willRetry: event.willRetry, errorMessage: event.errorMessage };
}
