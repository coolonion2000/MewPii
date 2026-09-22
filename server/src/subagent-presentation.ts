/** Read-only task state projection shared by list and detail. @author coolonion */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readSessionPreview } from './subagent-run-details.js';
import type { NativeChildView } from './subagent-runtime.js';

export interface RunRecord {
  runId?: string; sessionId?: string; toolCallId?: string; state?: string; status?: string;
  lastUpdate?: number; lastActivityAt?: number; activityState?: string;
  sessionFile?: string; pid?: number; agent?: string; label?: string;
  currentTool?: string; model?: string; steps?: RunRecord[];
  error?: string; timedOut?: boolean; startedAt?: number; endedAt?: number;
}
export interface PresentedState {
  effectiveState: string;
  stateSource: 'record' | 'live' | 'native' | 'unconfirmed';
  statusStale: boolean;
  updatedAt?: number;
}

/** Interpret only the explicit acceptance report in the latest assistant output. */
export function reportsUnmetCriteria(output?: string): boolean {
  const reports = [...(output ?? '').matchAll(/```acceptance-report\s*\n([\s\S]*?)\n```/g)];
  if (reports.length !== 1) return false;
  try {
    const report = JSON.parse(reports[0][1]);
    return Array.isArray(report.criteriaSatisfied) && report.criteriaSatisfied.some((item: unknown) =>
      item !== null && typeof item === 'object' && (item as { status?: string }).status === 'not-satisfied');
  } catch { return false; }
}
export function projectState(record: RunRecord, transcriptAt?: number, live?: { isStreaming: boolean }): PresentedState {
  const raw = record.state ?? record.status ?? 'unknown';
  const terminal = ['complete', 'completed', 'done', 'success', 'failed', 'error', 'timeout', 'timed_out', 'stopped', 'cancelled', 'canceled', 'aborted', 'rejected'].includes(raw);
  const recordedAt = terminal ? Math.max(record.lastActivityAt ?? 0, record.lastUpdate ?? 0) : record.lastActivityAt ?? record.lastUpdate ?? 0;
  const statusStale = Boolean(transcriptAt && transcriptAt > recordedAt + 1000);
  const updatedAt = Math.max(recordedAt, transcriptAt ?? 0) || undefined;
  if (live?.isStreaming) return { effectiveState: 'running', stateSource: 'live', statusStale, updatedAt };
  // A shared server PID does not prove a child is executing. New transcript
  // activity invalidates the old status, but does not itself prove execution.
  if (statusStale || (live && ['running', 'started'].includes(raw)))
    return { effectiveState: 'unknown', stateSource: 'unconfirmed', statusStale, updatedAt };
  if (['running', 'started'].includes(raw) && record.pid) {
    try { process.kill(record.pid, 0); }
    catch { return { effectiveState: 'interrupted', stateSource: 'record', statusStale, updatedAt }; }
  }
  return { effectiveState: record.activityState === 'needs_attention' && !terminal ? 'needs_attention' : raw,
    stateSource: raw === 'unknown' ? 'unconfirmed' : 'record', statusStale, updatedAt };
}

export async function presentRun(record: RunRecord, dir: string, liveViews: { sessionFile?: string; isStreaming: boolean }[], nativeViews: NativeChildView[] = []) {
  const steps = [];
  for (const step of record.steps?.length ? record.steps : record.sessionFile ? [record] : []) {
    let current: RunRecord = { ...step, lastUpdate: record.lastUpdate, pid: record.pid };
    let nativeAccepted = false;
    // Detached children can have a newer native status record. Only accept a
    // matching child ID and transcript, never a title/PID-based association.
    if (step.runId && /^[a-z0-9_-]+$/i.test(step.runId) && step.sessionFile) {
      try {
        const native = JSON.parse(await readFile(join(dirname(dir), step.runId, 'status.json'), 'utf8')) as RunRecord;
        if (native.runId === step.runId && native.sessionFile === step.sessionFile &&
            (native.lastUpdate ?? 0) > (step.lastActivityAt ?? record.lastUpdate ?? 0)) {
          current = native;
          nativeAccepted = true;
        }
      } catch { /* Foreground children need not have separate status files. */ }
    }
    const preview = await readSessionPreview(step.sessionFile);
    let presentation = projectState(current, preview.updatedAt, liveViews.find(v => v.sessionFile === step.sessionFile));
    if (nativeAccepted && presentation.stateSource === 'record') presentation.stateSource = 'native';
    // Match original parent identity AND native child ID, never title or shared PID.
    const runtime = nativeViews.find(v => v.sessionId === record.sessionId && v.runId === step.runId && v.index === 0 &&
      (!v.sessionFile || !step.sessionFile || v.sessionFile === step.sessionFile));
    // A workflow write timestamp is not the child's state timestamp.
    const childRecordedAt = nativeAccepted ? current.lastUpdate ?? 0 : step.lastActivityAt ?? 0;
    if (runtime && (runtime.live || runtime.updatedAt >= childRecordedAt)) {
      presentation = runtime.live
        ? { effectiveState: runtime.state, stateSource: 'native', statusStale: false, updatedAt: runtime.updatedAt }
        : projectState({ state: runtime.state, lastUpdate: runtime.updatedAt }, preview.updatedAt);
      if (presentation.stateSource === 'record') presentation.stateSource = 'native';
      current = { ...current, currentTool: runtime.currentTool };
    }
    const ended = ['completed', 'complete', 'done', 'success'].includes(presentation.effectiveState);
    const latest = preview.messages.at(-1);
    const outcome = ended && latest?.role === 'assistant' && reportsUnmetCriteria(latest.outputText) ? 'reported-unmet' as const : undefined;
    steps.push({ ...presentation, outcome, key: step.label ?? step.agent ?? 'step', runId: step.runId,
      sessionFile: step.sessionFile, currentTool: current.currentTool, agent: step.agent, model: step.model });
  }
  const latestAt = Math.max(0, ...steps.map(s => s.updatedAt ?? 0));
  let presentation = projectState(record, latestAt || undefined, liveViews.find(v => v.sessionFile === record.sessionFile));
  const workflowRuntime = nativeViews.find(v => v.sessionId === record.sessionId && v.runId === record.runId && v.index === -1 && v.live);
  if (workflowRuntime) presentation = { effectiveState: workflowRuntime.state, stateSource: 'native', statusStale: false, updatedAt: workflowRuntime.updatedAt };
  const active = steps.find(s => ['live', 'native'].includes(s.stateSource) && ['running', 'started'].includes(s.effectiveState)) ??
    steps.find(s => s.stateSource === 'native' && s.effectiveState === 'needs_attention');
  if (active && presentation.effectiveState !== 'stopping') presentation = { ...presentation, effectiveState: active.effectiveState, stateSource: active.stateSource, statusStale: false };
  // Child completion is not workflow completion: continuation may remain.
  const state = record.state ?? record.status ?? 'unknown';
  const error = typeof record.error === 'string' ? record.error.slice(0, 4000) : undefined;
  const failed = ['failed', 'error', 'rejected', 'timeout', 'timed_out'].includes(state);
  // Classify only explicit runner diagnostics, never words in model output.
  const issue = !failed ? undefined : error?.startsWith('unsupported-continuation:') ? 'continuation' :
    /\bspawn pi ENOENT\b/.test(error ?? '') ? 'startup' :
    record.timedOut || ['timeout', 'timed_out'].includes(state) || /^Subagent timed out after \d+ms\./.test(error ?? '') ? 'timeout' : 'failed';
  return { ...presentation, outcome: steps.some(step => step.outcome === 'reported-unmet') ? 'reported-unmet' as const : undefined,
    toolCallId: record.toolCallId, title: record.steps?.map(s => s.label ?? s.agent).filter(Boolean).join(' · '), steps,
    childSummary: { total: steps.length, completed: steps.filter(s => ['complete', 'completed', 'done', 'success'].includes(s.effectiveState)).length },
    workflow: { state, error, issue, startedAt: record.startedAt, updatedAt: record.lastUpdate, endedAt: record.endedAt },
  };
}
