/** Read-only, bounded previews of existing subagent artifacts. @author coolonion */
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';

const PREVIEW_BYTES = 256 * 1024;
const PREVIEW_MESSAGES = 40;
const usageCache = new Map<string, { stamp: string; value: Promise<{ tokens: number; cost: number }> }>();

export async function readTextTail(path: string, maxBytes = PREVIEW_BYTES): Promise<{ text: string; truncated: boolean }> {
  const file = await open(path, 'r');
  try {
    const size = (await file.stat()).size;
    const buffer = Buffer.alloc(Math.min(size, maxBytes));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const truncated = size > buffer.length;
    // Drop the first partial line; never parse a truncated JSON record.
    return { text: truncated ? (text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '') : text, truncated };
  } finally { await file.close(); }
}

export async function readSessionUsage(path?: string): Promise<{ tokens: number; cost: number }> {
  if (!path) return { tokens: 0, cost: 0 };
  try {
    const info = await stat(path);
    const stamp = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    const cached = usageCache.get(path);
    if (cached?.stamp === stamp) return cached.value;
    const value = (async () => {
      let tokens = 0, cost = 0;
      const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
      for await (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const usage = entry.type === 'message' ? entry.message?.usage : undefined;
          if (Number.isFinite(usage?.totalTokens)) tokens += usage.totalTokens;
          if (Number.isFinite(usage?.cost?.total)) cost += usage.cost.total;
        } catch { /* Ignore a partially written last record. */ }
      }
      return { tokens, cost };
    })().catch(() => ({ tokens: 0, cost: 0 }));
    usageCache.delete(path);
    usageCache.set(path, { stamp, value });
    while (usageCache.size > 32) usageCache.delete(usageCache.keys().next().value!);
    return value;
  } catch { return { tokens: 0, cost: 0 }; }
}

export interface SubagentPreviewMessage {
  role: string;
  text: string;
  timestamp?: number;
  summary?: string;
  outputText?: string;
}

type Preview = {
  messages: SubagentPreviewMessage[]; truncated: boolean; updatedAt?: number; unavailable?: boolean;
};
const previewCache = new Map<string, { stamp: string; value: Promise<Preview> }>();
export async function readSessionPreview(path?: string): Promise<Preview> {
  if (!path) return { messages: [], truncated: false, unavailable: true };
  try {
    const info = await stat(path);
    const stamp = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    const cached = previewCache.get(path);
    if (cached?.stamp === stamp) return cached.value;
    const value = loadSessionPreview(path);
    previewCache.delete(path);
    previewCache.set(path, { stamp, value });
    while (previewCache.size > 64) previewCache.delete(previewCache.keys().next().value!);
    return value;
  } catch { return { messages: [], truncated: false, unavailable: true }; }
}
async function loadSessionPreview(path?: string): Promise<Preview> {
  if (!path) return { messages: [], truncated: false, unavailable: true };
  try {
    const tail = await readTextTail(path);
    const messages: SubagentPreviewMessage[] = [];
    let updatedAt: number | undefined;
    let truncated = tail.truncated;
    for (const line of tail.text.split('\n')) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'message' || !entry.message) continue;
        const message = entry.message;
        const timestamp = typeof entry.timestamp === 'number' ? entry.timestamp : Date.parse(entry.timestamp);
        if (Number.isFinite(timestamp)) updatedAt = Math.max(updatedAt ?? 0, timestamp);
        const text = typeof message.content === 'string' ? message.content :
          Array.isArray(message.content) ? message.content.flatMap((block: Record<string, unknown> | null) => {
            if (block?.type === 'text' && typeof block.text === 'string') return [block.text];
            if (block?.type === 'thinking' && typeof block.thinking === 'string') return [block.thinking];
            if (block?.type === 'toolCall') return [`[${String(block.name ?? 'tool')}] ${JSON.stringify(block.arguments ?? {})}`];
            return [];
          }).join('\n') : '';
        if (!text) continue;
        if (text.length > 8000) truncated = true;
        const blocks = Array.isArray(message.content) ? message.content : [];
        const calls = blocks.filter((block: any) => block?.type === 'toolCall');
        const summary = calls.map((call: any) => {
          const args = call.arguments ?? {};
          return `${String(call.name ?? 'tool')} ${String(args.path ?? args.file_path ?? args.command ?? '').slice(0, 160)}`.trim();
        }).join(' · ') || (message.toolName ? String(message.toolName) : undefined);
        const outputText = message.role === 'assistant' ? (typeof message.content === 'string' ? message.content :
          blocks.filter((block: any) => block?.type === 'text').map((block: any) => block.text).join('\n')).slice(-8000) : undefined;
        messages.push({ role: String(message.role ?? 'unknown'), text: text.slice(-8000), summary, outputText, ...(Number.isFinite(timestamp) ? { timestamp } : {}) });
      } catch { /* One incomplete entry must not hide earlier output. */ }
    }
    return { messages: messages.slice(-PREVIEW_MESSAGES), truncated: truncated || messages.length > PREVIEW_MESSAGES, updatedAt };
  } catch { return { messages: [], truncated: false, unavailable: true }; }
}
