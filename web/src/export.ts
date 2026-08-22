import type { PiiMessage } from './types';

interface Block {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as Block[])
      .map((b) => {
        if (b.type === 'text') return b.text ?? '';
        if (b.type === 'thinking') return `[thinking]\n${b.thinking ?? ''}`;
        if (b.type === 'toolCall') return `[tool ${b.name}] ${JSON.stringify(b.arguments ?? {})}`;
        return '';
      })
      .join('\n');
  }
  return '';
}

/** Client-side standalone HTML export of the visible conversation. */
export function exportHtml(title: string, cwd: string, messages: PiiMessage[]): void {
  const rows = messages
    .filter((m) => m.role !== 'toolResult')
    .map((m) => {
      const text = escapeHtml(textOf(m.content));
      const cls = m.role === 'user' ? 'user' : 'assistant';
      return `<div class="msg ${cls}"><div class="role">${m.role}</div><pre>${text}</pre></div>`;
    })
    .join('\n');

  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title)} — pii export</title>
<style>
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#151517;color:#f9fafb;max-width:800px;margin:0 auto;padding:32px 24px}
h1{font-size:18px} .meta{color:#81858c;font-size:12px;margin-bottom:24px}
.msg{margin:0 0 16px} .role{font-size:11px;text-transform:uppercase;color:#81858c;margin-bottom:4px}
pre{white-space:pre-wrap;word-break:break-word;font-family:inherit;font-size:14px;line-height:1.6;margin:0;background:#1b1b1c;border-radius:8px;padding:10px 14px}
.user pre{background:#283142}
</style></head><body>
<h1>${escapeHtml(title)}</h1>
<div class="meta">${escapeHtml(cwd)} · exported ${new Date().toISOString()}</div>
${rows}
</body></html>`;

  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'session'}.html`;
  a.click();
  URL.revokeObjectURL(url);
}
