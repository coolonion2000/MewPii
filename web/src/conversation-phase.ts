/** Derive one user-facing state without trusting a stale running snapshot. */
export type ConversationPhase = 'connecting' | 'initializing' | 'ready' | 'running' | 'compacting' | 'reconnecting' | 'unresponsive' | 'failed' | 'stopping';

export interface ConversationPhaseInput {
  connected: boolean;
  transportOpen?: boolean;
  reconnecting?: boolean;
  serviceUnresponsive?: boolean;
  error?: string;
  snapshot?: { initializing?: boolean; isStreaming: boolean };
  compaction?: { status?: string; reason?: string };
}

export function conversationPhase(state: ConversationPhaseInput, stopping = false): ConversationPhase {
  if (state.serviceUnresponsive) return 'unresponsive';
  if (!state.connected) {
    if (state.reconnecting) return 'reconnecting';
    if (state.error && !state.transportOpen) return 'failed';
    return state.transportOpen ? 'initializing' : 'connecting';
  }
  if (stopping) return 'stopping';
  if (!state.snapshot || state.snapshot.initializing) return 'initializing';
  if (state.compaction && (!state.compaction.status || state.compaction.status === 'running')) return 'compacting';
  return state.snapshot.isStreaming ? 'running' : 'ready';
}

export function hasAuthoritativeRunState(state: ConversationPhaseInput): boolean {
  return state.connected && !state.serviceUnresponsive && Boolean(state.snapshot) && !state.snapshot?.initializing;
}

export const phaseTranslationKey = {
  connecting: 'sessionConnecting', initializing: 'sessionInitializing', ready: 'sessionReady',
  running: 'sessionRunning', compacting: 'sessionCompacting', reconnecting: 'reconnecting',
  unresponsive: 'serviceUnresponsive', failed: 'sessionFailed', stopping: 'stopping',
} as const;
