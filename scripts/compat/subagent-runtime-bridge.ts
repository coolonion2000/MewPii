/** Read-only native runtime bridge. No reconciliation, disk writes or task controls. @author coolonion */
type Child = { index: number; status?: string; sessionFile?: string; updatedAt?: number;
  currentActivityState?: string; activityState?: string; currentTool?: string };
type State = {
  foregroundRuns?: Map<string, { runId: string; sessionId?: string; updatedAt: number; children: Child[] }>;
  foregroundControls: Map<string, { runId: string; sessionId?: string; updatedAt: number; activeChildren?: Map<number, Child> }>;
  workflowControllers?: Map<string, AbortController>;
  asyncJobs: Map<string, { sessionId?: string; activityState?: string; updatedAt?: number }>;
};
export function runtimeSnapshot(state: State, sessionId: string, now = Date.now()) {
  const rows = new Map<string, { runId: string; index: number; sessionId: string; sessionFile?: string;
    state: string; currentTool?: string; updatedAt: number; observedAt: number; live: boolean }>();
  for (const run of state.foregroundRuns?.values() ?? []) {
    if (run.sessionId !== sessionId) continue;
    for (const child of run.children) {
      if (!['completed', 'failed', 'stopped', 'interrupted', 'rejected'].includes(child.status ?? '')) continue;
      rows.set(`${run.runId}:${child.index}`, { runId: run.runId, index: child.index, sessionId,
        sessionFile: child.sessionFile, state: child.status!, updatedAt: child.updatedAt ?? run.updatedAt, observedAt: now, live: false });
    }
  }
  for (const run of state.foregroundControls.values()) {
    if (run.sessionId !== sessionId) continue;
    for (const child of run.activeChildren?.values() ?? []) {
      const key = `${run.runId}:${child.index}`;
      const remembered = state.foregroundRuns?.get(run.runId)?.children.find(item => item.index === child.index);
      const attention = remembered?.status === 'detached' && (remembered.updatedAt ?? 0) >= (child.updatedAt ?? 0)
        ? remembered.activityState : child.currentActivityState;
      rows.set(key, { ...rows.get(key), runId: run.runId, index: child.index, sessionId,
        state: attention === 'needs_attention' ? 'needs_attention' : 'running',
        currentTool: child.currentTool, updatedAt: child.updatedAt ?? run.updatedAt, observedAt: now, live: true });
    }
  }
  for (const [runId, controller] of state.workflowControllers ?? []) {
    const job = state.asyncJobs.get(runId);
    if (job?.sessionId !== sessionId) continue;
    rows.set(`${runId}:-1`, { runId, index: -1, sessionId, live: true, observedAt: now,
      updatedAt: job.updatedAt ?? now, state: controller.signal.aborted ? 'stopping' : job.activityState === 'needs_attention' ? 'needs_attention' : 'running' });
  }
  return { version: 1, observedAt: now, rows: [...rows.values()] };
}

export function registerRuntimeBridge(events: { on: (name: string, cb: (data: unknown) => void) => () => void }, state: State) {
  return events.on('mewpii:subagent-snapshot:v1', (data) => {
    const request = data as { sessionId?: unknown; reply?: unknown } | undefined;
    if (typeof request?.sessionId !== 'string' || typeof request.reply !== 'function') return;
    request.reply(runtimeSnapshot(state, request.sessionId));
  });
}
