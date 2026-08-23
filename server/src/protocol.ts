/**
 * Shared protocol types between @pii/server and @pii/web.
 * Keep this file dependency-free.
 */

/** A message as stored in pi's agent state (already JSON-safe). `_entryId` links it to a session-file entry. */
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
  hasAuth: boolean;
}

export interface ProviderInfoLite {
  id: string;
  name: string;
  authStatus: string;
  modelCount: number;
}

/** Client → Server WebSocket commands. */
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
  | { type: 'setToolMode'; mode: 'off' | 'read-only' | 'default' | 'full' }
  | { type: 'ui_response'; requestId: string; value: unknown };

export interface WidgetState {
  key: string;
  lines: string[];
  placement: 'aboveEditor' | 'belowEditor';
}

export interface UiRequest {
  id: string;
  kind: 'select' | 'confirm' | 'input' | 'question' | 'questionnaire';
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  /** question/questionnaire tool payloads */
  payload?: {
    question?: string;
    options?: { label: string; description?: string }[];
    questions?: { label: string; prompt: string; options: { label: string; description?: string }[]; allowOther?: boolean }[];
  };
}

/** Server → Client WebSocket messages. */
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
  /** Names of currently active tools. */
  tools: string[];
}
