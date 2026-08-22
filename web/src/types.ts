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
  | { type: 'compact' };

export type ServerMessage =
  | { type: 'snapshot'; snapshot: SessionSnapshot }
  | { type: 'event'; event: Record<string, unknown> }
  | { type: 'command_result'; id?: string; ok: boolean; error?: string };

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
