/** Interactive PTYs owned by authenticated WebSocket connections. @author coolonion */
import { basename } from 'node:path';
import { userInfo } from 'node:os';
import type { IPty } from 'node-pty';
import type { WebSocket } from 'ws';
import { resolveWorkspacePath } from './security.js';

const HIGH_WATER = 256 * 1024;
const MAX_TERMINALS = 8;
export function terminalSize(value: unknown, fallback: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? Math.max(2, Math.min(max, value)) : fallback;
}

export class TerminalService {
  private active = new Map<WebSocket, (force?: boolean) => void>();
  private disposed = false;
  get size() { return this.active.size; }

  async connect(ws: WebSocket, url: URL, roots: () => Promise<string[]>): Promise<void> {
    if (this.disposed || this.active.size >= MAX_TERMINALS) { ws.close(4008, 'terminal limit reached'); return; }
    let pty: IPty | undefined;
    let closed = false;
    let exited = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let pending = 0;
    let paused = false;
    const send = (message: unknown) => {
      if (ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount > 1024 * 1024) { ws.close(4008, 'terminal output overflow'); cleanup(); return; }
      ws.send(JSON.stringify(message));
    };
    const cleanup = (force = false) => {
      if (closed) return;
      closed = true;
      this.active.delete(ws);
      if (pty) {
        try { pty.resume(); pty.kill(force ? 'SIGKILL' : undefined); } catch { /* process already exited */ }
        if (!force) {
          killTimer = setTimeout(() => { if (!exited) { try { pty?.kill('SIGKILL'); } catch { /* already exited */ } } }, 750);
          killTimer.unref();
        }
        console.info(`[terminal] closed pid=${pty.pid}`);
      }
    };
    this.active.set(ws, cleanup);
    ws.once('close', () => cleanup());
    ws.once('error', () => cleanup());
    ws.on('message', (raw, binary) => {
      if (closed) return;
      const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (binary || bytes.length > 64 * 1024) { ws.close(4000, 'invalid terminal message'); cleanup(); return; }
      try {
        const message = JSON.parse(bytes.toString());
        if (!message || typeof message !== 'object') throw new Error('invalid message');
        if (message.type === 'close') { cleanup(); ws.close(1000, 'terminal closed'); }
        else if (message.type === 'input' && typeof message.data === 'string') pty?.write(message.data);
        else if (message.type === 'resize') pty?.resize(terminalSize(message.cols, 80, 500), terminalSize(message.rows, 24, 200));
        else if (message.type === 'ack' && Number.isInteger(message.length) && message.length > 0) {
          pending = Math.max(0, pending - Math.min(message.length, pending));
          if (paused && pending < HIGH_WATER / 2) { paused = false; pty?.resume(); }
        } else throw new Error('invalid message');
      } catch { ws.close(4000, 'invalid terminal message'); cleanup(); }
    });
    try {
      const cwd = url.searchParams.get('cwd');
      if (!cwd) throw new Error('missing cwd');
      const { base } = await resolveWorkspacePath(cwd, '.', { extraRoots: await roots() });
      const { spawn } = await import('node-pty');
      if (closed || ws.readyState !== ws.OPEN) return;
      const shell = process.platform === 'win32' ? (process.env.COMSPEC || 'cmd.exe') : (userInfo().shell || process.env.SHELL || '/bin/sh');
      const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
      // Service authentication configuration is not part of the shell environment.
      delete env.PII_PASSWORD; delete env.PII_TOKEN;
      env.TERM = 'xterm-256color'; env.COLORTERM = 'truecolor';
      pty = spawn(shell, process.platform === 'win32' ? [] : ['-l'], {
        cwd: base, env, name: 'xterm-256color',
        cols: terminalSize(Number(url.searchParams.get('cols') ?? 80), 80, 500),
        rows: terminalSize(Number(url.searchParams.get('rows') ?? 24), 24, 200),
      });
      pty.onData(data => {
        if (closed) return;
        pending += data.length;
        send({ type: 'output', data });
        if (!closed && !paused && pending >= HIGH_WATER) { paused = true; pty?.pause(); }
      });
      pty.onExit(({ exitCode, signal }) => {
        exited = true; clearTimeout(killTimer);
        if (closed) return;
        send({ type: 'exit', exitCode, signal });
        closed = true; this.active.delete(ws);
        console.info(`[terminal] exited pid=${pty?.pid} exitCode=${exitCode} signal=${signal ?? 0}`);
        ws.close(1000, 'shell exited');
      });
      send({ type: 'ready', cwd: base, shell: basename(shell), pid: pty.pid });
      console.info(`[terminal] opened pid=${pty.pid} cwd=${JSON.stringify(base)} shell=${JSON.stringify(shell)}`);
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      console.info(`[terminal] open_failed error=${JSON.stringify(error)}`);
      send({ type: 'error', error }); cleanup(); ws.close(4000, 'terminal unavailable');
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const [ws, cleanup] of this.active) { cleanup(true); ws.close(1001, 'server shutting down'); }
  }
}
