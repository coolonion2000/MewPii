/**
 * Shared protocol types between @pii/server and @pii/web.
 * Keep this file dependency-free.
 */

/** A message as stored in pi's agent state (already JSON-safe). `_entryId` links it to a session-file entry. */
export type PiiMessage = Record<string, unknown> & {
  role: string;
  _entryId?: string;
};

export interface SessionStatsLite {
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
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
  /** Synthesized entry for an in-flight pi-subagents run (no session file yet). */
  virtualRun?: boolean;
  /** State of the synthesized run (running/complete/failed/...). */
  runState?: string;
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

/** Client → Server WebSocket commands. */
export type ClientCommand =
  | {
      type: "prompt";
      message: string;
      images?: { data: string; mimeType: string }[];
      streamingBehavior?: "steer" | "followUp";
    }
  | { type: "steer"; message: string }
  | { type: "followUp"; message: string }
  | { type: "abort" }
  | { type: "newSession" }
  | { type: "fork"; entryId: string; position?: "before" | "at" }
  | { type: "setModel"; provider: string; modelId: string }
  | { type: "setThinkingLevel"; level: string }
  | { type: "setSessionName"; name: string }
  | { type: "branch"; entryId: string; summarize?: boolean }
  | { type: "compact" }
  | {
      type: "queue_remove";
      queue: "steering" | "followUp";
      index: number;
      expectedMessage: string;
      revision: number;
    }
  | {
      type: "queue_move";
      from: "steering" | "followUp";
      to: "steering" | "followUp";
      index: number;
      expectedMessage: string;
      revision: number;
    }
  | { type: "queue_clear" }
  | { type: "history"; before: number; requestId: string }
  | { type: "setToolMode"; mode: "off" | "read-only" | "default" | "full" }
  | { type: "editor_state"; text: string }
  | { type: "ui_response"; requestId: string; value: unknown }
  | { type: "custom_ui_input"; requestId: string; data: string }
  | { type: "custom_ui_resize"; requestId: string; width: number }
  | { type: "custom_ui_cancel"; requestId: string }
  | { type: "slash"; raw: string };

export interface WidgetState {
  key: string;
  lines: string[];
  placement: "aboveEditor" | "belowEditor";
}

export interface UiRequest {
  id: string;
  kind: "select" | "confirm" | "input" | "question" | "questionnaire" | "editor" | "file" | "copy" | "download";
  content?: string;
  filename?: string;
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  /** question/questionnaire tool payloads */
  payload?: {
    question?: string;
    options?: { label: string; description?: string }[];
    questions?: {
      label: string;
      prompt: string;
      options: { label: string; description?: string }[];
      allowOther?: boolean;
    }[];
  };
}

/** Server-rendered frame for an extension ctx.ui.custom() component. */
export interface CustomUiFrame {
  requestId: string;
  revision: number;
  width: number;
  lines: string[];
  overlay: boolean;
}

/** Server → Client WebSocket messages. */
export type ServerMessage =
  | { type: "snapshot"; snapshot: SessionSnapshot }
  | { type: "session_ready"; snapshot: Omit<SessionSnapshot, "messages"> }
  | { type: "event"; event: Record<string, unknown> }
  | { type: "widgets"; widgets: WidgetState[] }
  | { type: "statuses"; statuses: Record<string, string> }
  | { type: "toast"; message: string; level: "info" | "warning" | "error" }
  | { type: "editor_text"; text: string; mode: "replace" | "append" }
  | { type: "ui_request"; request: UiRequest }
  | { type: "ui_close"; requestId: string; reason: "answered" | "timeout" | "rebind" | "dispose" }
  | { type: "custom_ui_frame"; frame: CustomUiFrame }
  | { type: "custom_ui_close"; requestId: string; reason?: string }
  | {
      type: "history";
      requestId: string;
      sessionId: string;
      branchHeadId?: string;
      messages: PiiMessage[];
      before: number;
    }
  | {
      type: "command_result";
      id?: string;
      ok: boolean;
      error?: string;
      data?: Record<string, unknown>;
    };

export interface SlashCommandLite {
  name: string;
  description?: string;
  source: "builtin" | "extension" | "prompt" | "skill";
}

export interface ActiveToolSnapshot {
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown>;
  startedAt?: number;
  liveOutput?: string;
}

export interface ProviderRequestState {
  phase: 'preparing' | 'connecting' | 'waiting_headers' | 'streaming' | 'retrying' | 'failed';
  transport: 'auto' | 'websocket' | 'sse';
  startedAt: number;
  since: number;
  attempt?: number;
  maxAttempts?: number;
  retryAt?: number;
}

export interface CompactionState {
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  reason: string;
  startedAt?: number;
  endedAt?: number;
  tokensBefore?: number;
  estimatedTokensAfter?: number;
  willRetry?: boolean;
  errorMessage?: string;
}

export interface SessionSnapshot {
  sessionId: string;
  sessionFile?: string;
  /** Extension session_start/resource discovery is still running. */
  initializing?: boolean;
  /** Initial tail-only preview has provisional paging metadata. */
  pagingProvisional?: boolean;
  /** Current branch leaf at snapshot time; history replies must match it. */
  branchHeadId?: string;
  name?: string;
  cwd: string;
  isStreaming: boolean;
  /** Current provider request, independent of tool execution; replayed on reconnect. */
  providerRequest?: ProviderRequestState;
  /** Latest compaction lifecycle, replayed even when the viewer missed start/end events. */
  compactionState?: CompactionState | null;
  thinkingLevel: string;
  /** Thinking levels the current model actually supports (pi thinkingLevelMap). */
  availableThinkingLevels?: string[];
  model?: { provider: string; id: string; name: string };
  /** The most recent page of messages (older pages available via history). */
  messages: PiiMessage[];
  /** Total messages on the current branch. */
  totalMessages: number;
  /** Index of the first message in `messages` within the full branch. */
  historyFrom: number;
  queue: { steering: string[]; followUp: string[] };
  queueCapabilities: {
    revision: number;
    reorder: boolean;
    remove: boolean;
    reason?: string;
  };
  stats?: SessionStatsLite;
  /** Names of currently active tools. */
  tools: string[];
  /** Tool executions still running, replayed to viewers that attach late. */
  activeToolCalls?: ActiveToolSnapshot[];
  /** In-flight assistant message used to resume a late or reconnected viewer. */
  streamingMessage?: PiiMessage | null;
  /** Commands currently available to the web composer. */
  slashCommands: SlashCommandLite[];
}
