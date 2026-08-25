import { zipSync, strToU8 } from 'fflate';
import type { PiiMessage } from './types';

interface Block {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

interface ImageBlock {
  type: 'image';
  data: string;
  mimeType: string;
}

const IMG_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
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

/** Collect image blocks from the conversation; returns them with stable file names. */
function collectImages(messages: PiiMessage[]): { name: string; bytes: Uint8Array }[] {
  const images: { name: string; bytes: Uint8Array }[] = [];
  for (const m of messages) {
    const content = m.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as (Block | ImageBlock)[]) {
      if (b.type === 'image') {
        const img = b as ImageBlock;
        const ext = IMG_EXT[img.mimeType] ?? 'png';
        images.push({ name: `images/img-${images.length + 1}.${ext}`, bytes: b64ToBytes(img.data) });
      }
    }
  }
  return images;
}

function bodyOf(content: unknown, images: { name: string; bytes: Uint8Array }[], used: { count: number }): string {
  if (typeof content === 'string') return escapeHtml(content);
  if (Array.isArray(content)) {
    return (content as (Block | ImageBlock)[])
      .map((b) => {
        if (b.type === 'text') return escapeHtml((b as Block).text ?? '');
        if (b.type === 'thinking') return escapeHtml(`[thinking]\n${(b as Block).thinking ?? ''}`);
        if (b.type === 'toolCall') return escapeHtml(`[tool ${(b as Block).name}] ${JSON.stringify((b as Block).arguments ?? {})}`);
        if (b.type === 'image') {
          const img = images[used.count++];
          return img ? `<img src="${img.name}" style="max-width:640px;border-radius:8px;display:block;margin:6px 0" />` : '[image]';
        }
        return '';
      })
      .join('\n');
  }
  return '';
}

function buildHtml(title: string, cwd: string, rows: string): string {
  return `<!doctype html>
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
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function safeName(title: string): string {
  return title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'session';
}

/** Export the visible conversation as a self-contained HTML, or a ZIP when images are present. */
export function exportHtml(title: string, cwd: string, messages: PiiMessage[]): void {
  const images = collectImages(messages);
  if (images.length > 0) {
    const used = { count: 0 };
    const rows = messages
      .filter((m) => m.role !== 'toolResult')
      .map((m) => {
        const cls = m.role === 'user' ? 'user' : 'assistant';
        return `<div class="msg ${cls}"><div class="role">${m.role}</div><pre>${bodyOf(m.content, images, used)}</pre></div>`;
      })
      .join('\n');
    const files: Record<string, Uint8Array> = { 'index.html': strToU8(buildHtml(title, cwd, rows)) };
    for (const img of images) files[img.name] = img.bytes;
    const zipped = zipSync(files, { level: 6 });
    download(new Blob([zipped.buffer as ArrayBuffer], { type: 'application/zip' }), `${safeName(title)}.zip`);
    return;
  }

  const rows = messages
    .filter((m) => m.role !== 'toolResult')
    .map((m) => {
      const cls = m.role === 'user' ? 'user' : 'assistant';
      return `<div class="msg ${cls}"><div class="role">${m.role}</div><pre>${escapeHtml(textOf(m.content))}</pre></div>`;
    })
    .join('\n');
  download(
    new Blob([buildHtml(title, cwd, rows)], { type: 'text/html' }),
    `${safeName(title)}.html`,
  );
}
