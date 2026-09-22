/** Query a host's native child registry without commands or model turns. @author coolonion */
import type { EventBus } from '@earendil-works/pi-coding-agent';
export interface NativeChildView {
  runId: string; index: number; sessionId: string; sessionFile?: string;
  state: string; currentTool?: string; updatedAt: number; observedAt: number; live: boolean;
}
const bridges = new WeakMap<object, EventBus>();
export function bindSubagentRuntime(loader: object, bus: EventBus) { bridges.set(loader, bus); }
export function readSubagentRuntime(loader: object, sessionId?: string): NativeChildView[] {
  if (!sessionId) return [];
  let rows: NativeChildView[] = [];
  bridges.get(loader)?.emit('mewpii:subagent-snapshot:v1', { sessionId, reply(value: unknown) {
    const snapshot = value as { version?: number; rows?: NativeChildView[] } | undefined;
    if (snapshot?.version !== 1 || !Array.isArray(snapshot.rows)) return;
    rows = snapshot.rows.filter(row => row.sessionId === sessionId && typeof row.runId === 'string' &&
      Number.isInteger(row.index) && typeof row.state === 'string' && typeof row.live === 'boolean' &&
      Number.isFinite(row.updatedAt) && Number.isFinite(row.observedAt));
  } });
  return rows;
}
