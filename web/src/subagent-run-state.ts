/** Task status is authoritative; a shared runner PID is only liveness. @author coolonion */
import type { I18nKey } from './i18n';
import type { Presentation } from './subagent-store';

/** Child result and workflow outcome are separate; never promote workflow success. */
export function subagentStatusView(presentation?: Presentation, unavailable = false): {
  state: string; label: I18nKey; warning?: I18nKey; reason?: I18nKey; childrenCompleted: boolean;
} {
  const state = unavailable ? 'unknown' : presentation?.effectiveState ?? 'unknown';
  const failed = ['failed', 'error', 'rejected', 'timeout', 'timed_out'].includes(state);
  const issue = !unavailable && !presentation?.statusStale && failed ? presentation?.workflow?.issue : undefined;
  const summary = presentation?.childSummary;
  const childrenCompleted = Boolean(issue && summary && summary.total > 0 && summary.completed === summary.total &&
    presentation?.steps.length === summary.total && presentation.steps.every(step => ['complete', 'completed', 'done', 'success'].includes(step.effectiveState)));
  const unmet = !unavailable && !presentation?.statusStale && presentation?.outcome === 'reported-unmet' &&
    (childrenCompleted || ['complete', 'completed', 'done', 'success'].includes(state));
  return {
    state: unmet ? 'needs_attention' : childrenCompleted ? 'completed' : issue === 'timeout' ? 'timed_out' : state,
    label: unmet ? 'subagentOutcomeUnmet' : childrenCompleted ? 'subagentChildrenCompleted' : issue === 'timeout' ? 'subagentTimedOut' : issue === 'startup' ? 'subagentStartupFailed' : subagentStateKey(state),
    warning: childrenCompleted ? issue === 'continuation' ? 'subagentContinuationRequired' : 'subagentWorkflowException' : undefined,
    reason: issue === 'continuation' ? 'subagentContinuationFailure' : issue === 'timeout' ? 'subagentTimeoutReason' : issue === 'startup' ? 'subagentStartupReason' : issue ? 'subagentWorkflowFailureReason' : undefined,
    childrenCompleted,
  };
}

export function subagentStateKey(state?: string, activityState?: string, alive?: boolean): I18nKey {
  switch (state?.toLowerCase()) {
    case 'stopping': return 'subagentStopping';
    case 'needs_attention': return 'subagentNeedsAttention';
    case 'interrupted': return 'subagentInterrupted';
    case 'complete': case 'completed': case 'done': case 'success': return 'subagentCompleted';
    case 'rejected': case 'failed': case 'error': case 'timeout': case 'timed_out': return 'subagentFailed';
    case 'stopped': case 'cancelled': case 'canceled': case 'aborted': return 'subagentStopped';
    case 'paused': return 'subagentPaused';
    case 'queued': case 'pending': return 'subagentQueued';
  }
  if (activityState === 'needs_attention') return 'subagentNeedsAttention';
  if (state === 'running' || state === 'started') return alive === false ? 'subagentInterrupted' : 'running';
  return 'subagentUnknown';
}

export function subagentRunTerminal(state?: string): boolean {
  return ['complete', 'completed', 'done', 'success', 'rejected', 'failed', 'error', 'timeout', 'timed_out', 'stopped', 'cancelled', 'canceled', 'aborted']
    .includes(state?.toLowerCase() ?? '');
}
