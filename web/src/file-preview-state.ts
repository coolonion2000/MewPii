/** UI readiness only; the server remains the authority for file access. */
import type { ToolActivity } from './api';

type Message = { role: string; content?: unknown; toolCallId?: unknown; isError?: unknown };
export function filePreviewState(cwd: string, path: string | undefined, tools: Map<string, ToolActivity>, messages: readonly Message[], streaming?: Message | null) {
  if (!path) return { pending: false, revision: '' };
  // Preserve .. because it may cross a symlink; never infer authorization here.
  const absolute = (p: string) => (p.startsWith('/') ? p : `${cwd.replace(/\/$/, '')}/${p}`).replace(/\/\.\//g, '/');
  const target = absolute(path);
  const calls = new Map<string, { path: string; running?: boolean; endedAt?: number }>();
  const results = new Map<string, boolean>();
  for (const message of streaming ? [...messages, streaming] : messages) {
    if (message.role === 'toolResult') results.set(String(message.toolCallId), message.isError === true);
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type !== 'toolCall' || !['read', 'write', 'edit'].includes(block.name)) continue;
      let args = block.arguments;
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { continue; } }
      const p = args?.path ?? args?.file_path;
      if (typeof p === 'string') calls.set(block.id, { path: p, running: message === streaming });
    }
  }
  for (const tool of tools.values()) {
    if (!['read', 'write', 'edit'].includes(tool.toolName)) continue;
    const p = tool.args?.path ?? tool.args?.file_path;
    if (typeof p === 'string') calls.set(tool.toolCallId, { path: p, running: tool.running, endedAt: tool.endedAt });
  }
  let pending = false;
  const revision: string[] = [];
  for (const [id, call] of calls) {
    if (absolute(call.path) !== target) continue;
    const waiting = !results.has(id) && call.running !== false;
    pending ||= waiting;
    revision.push(`${id}:${waiting}:${call.endedAt ?? ''}:${results.has(id) ? results.get(id) : ''}`);
  }
  return { pending, revision: revision.join('|') };
}
