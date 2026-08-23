/** Mirror of server/src/protocol.ts — keep in sync. */

export type PiiMessage = Record<string, unknown> & { role: string; _entryId?: string };

export interface SessionStatsLite {
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
  contextTokens: number | null;
  contextWindow: number | null;
  contextPercent: number | null;
}

export interface SessionSummary {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  running: boolean;
  archived?: boolean;
  /** Present for sessions forked from / spawned by another session (subagents). */
  parentSessionPath?: string;
}

export interface ProjectGroup {
  cwd: string;
  sessions: SessionSummary[];
}

export interface ModelInfoLite {
  provider: string;
  id: string;
  name: string;
  baseUrl?: string;
  reasoning: boolean;
  input: string[];
  contextWindow?: number;
  hasAuth: boolean;
}

export interface ProviderInfoLite {
  id: string;
  name: string;
  configured: boolean;
  authSource?: string;
  modelCount: number;
}

export type ClientCommand =
  | { type: 'prompt'; message: string; images?: { data: string; mimeType: string }[]; streamingBehavior?: 'steer' | 'followUp' }
  | { type: 'steer'; message: string }
  | { type: 'followUp'; message: string }
  | { type: 'abort' }
  | { type: 'newSession' }
  | { type: 'fork'; entryId: string; position?: 'before' | 'at' }
  | { type: 'setModel'; provider: string; modelId: string }
  | { type: 'setThinkingLevel'; level: string }
  | { type: 'setSessionName'; name: string }
  | { type: 'branch'; entryId: string; summarize?: boolean }
  | { type: 'compact' }
  | { type: 'queue_remove'; queue: 'steering' | 'followUp'; index: number }
  | { type: 'queue_move'; from: 'steering' | 'followUp'; to: 'steering' | 'followUp'; index: number }
  | { type: 'queue_clear' }
  | { type: 'ui_response'; requestId: string; value: string | boolean | undefined };

export interface WidgetState {
  key: string;
  lines: string[];
  placement: 'aboveEditor' | 'belowEditor';
}

export interface UiRequest {
  id: string;
  kind: 'select' | 'confirm' | 'input';
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
}

export type ServerMessage =
  | { type: 'snapshot'; snapshot: SessionSnapshot }
  | { type: 'event'; event: Record<string, unknown> }
  | { type: 'widgets'; widgets: WidgetState[] }
  | { type: 'statuses'; statuses: Record<string, string> }
  | { type: 'toast'; message: string; level: 'info' | 'warning' | 'error' }
  | { type: 'ui_request'; request: UiRequest }
  | { type: 'command_result'; id?: string; ok: boolean; error?: string; data?: Record<string, unknown> };

export interface SessionSnapshot {
  sessionId: string;
  sessionFile?: string;
  name?: string;
  cwd: string;
  isStreaming: boolean;
  thinkingLevel: string;
  model?: { provider: string; id: string; name: string };
  messages: PiiMessage[];
  queue: { steering: string[]; followUp: string[] };
  stats?: SessionStatsLite;
}
