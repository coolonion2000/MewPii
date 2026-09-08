/** Real PTY protocol and process lifecycle regressions. @author coolonion */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { TerminalService, terminalSize } from '../dist/terminal.js';

async function harness() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pii-terminal-')));
  const service = new TerminalService();
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  server.on('connection', (ws, req) => void service.connect(ws, new URL(req.url, 'http://localhost'), async () => [root]));
  const clients = [];
  return { root, service,
    connect(path = root) {
      const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws/terminal?cwd=${encodeURIComponent(path)}`);
      clients.push(ws);
      const messages = []; const waiters = new Set(); let output = '';
      ws.on('message', raw => {
        const message = JSON.parse(String(raw)); messages.push(message);
        if (message.type === 'output') { output += message.data; ws.send(JSON.stringify({ type: 'ack', length: message.data.length })); }
        for (const waiter of waiters) if (waiter.check(messages, output)) { clearTimeout(waiter.timer); waiters.delete(waiter); waiter.resolve(); }
      });
      return { ws, messages, get output() { return output; }, send(message) { ws.send(JSON.stringify(message)); },
        wait(check) {
          if (check(messages, output)) return Promise.resolve();
          return new Promise((resolve, reject) => {
            const waiter = { check, resolve, timer: setTimeout(() => { waiters.delete(waiter); reject(new Error(`terminal timeout: ${JSON.stringify(messages.slice(-5))}`)); }, 10000) };
            waiters.add(waiter);
          });
        },
      };
    },
    async close() {
      service.dispose(); clients.forEach(ws => ws.terminate());
      await new Promise(resolve => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function waitGone(pid) {
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`terminal process ${pid} survived closure`);
}

test('terminal dimensions are bounded and reject non-integral values', () => {
  assert.equal(terminalSize(10000, 80, 500), 500);
  assert.equal(terminalSize(-1, 24, 200), 2);
  assert.equal(terminalSize('100', 80, 500), 80);
  assert.equal(terminalSize(1.5, 24, 200), 24);
});

test('PTY runs in the project, resizes, handles Ctrl+C, streams large output and closes foreground processes', { timeout: 20000 }, async () => {
  const h = await harness();
  try {
    const c = h.connect();
    await c.wait(ms => ms.some(m => m.type === 'ready'));
    const pid = c.messages.find(m => m.type === 'ready').pid;
    c.send({ type: 'input', data: "stty -echo; printf '\\nPWD_RESULT='; pwd\r" });
    await c.wait((_, out) => out.includes(`PWD_RESULT=${h.root}`));
    c.send({ type: 'resize', cols: 113, rows: 31 });
    c.send({ type: 'input', data: "printf '\\nSIZE_RESULT='; stty size\r" });
    await c.wait((_, out) => out.includes('SIZE_RESULT=31 113'));
    c.send({ type: 'input', data: "sleep 30\r" });
    c.send({ type: 'input', data: '\u0003' });
    c.send({ type: 'input', data: "printf '\\nINTERRUPT_OK\\n'\r" });
    await c.wait((_, out) => out.includes('\nINTERRUPT_OK\r\n'));
    c.send({ type: 'input', data: "awk 'BEGIN { for (i=0; i<20000; i++) print \"TERMINAL_FLOW_OUTPUT\" }'; printf '\\nFLOW_DONE\\n'\r" });
    await c.wait((_, out) => out.includes('\nFLOW_DONE\r\n'));
    assert.ok(c.output.length > 256 * 1024);
    c.send({ type: 'input', data: "sleep 30 & child=$!; printf '\\nCHILD_PID=%s\\n' $child; wait $child\r" });
    await c.wait((_, out) => /CHILD_PID=\d+/.test(out));
    const child = Number(c.output.match(/CHILD_PID=(\d+)/)[1]);
    const closed = once(c.ws, 'close'); c.send({ type: 'close' }); await closed;
    await waitGone(pid); await waitGone(child);
    assert.equal(h.service.size, 0);
  } finally { await h.close(); }
});

test('terminal rejects invalid workspace, ends on disconnect, and reports normal shell exit', { timeout: 20000 }, async () => {
  const h = await harness();
  try {
    const invalid = h.connect('relative/path');
    await invalid.wait(ms => ms.some(m => m.type === 'error'));
    assert.match(invalid.messages.find(m => m.type === 'error').error, /absolute path/);
    const disconnected = h.connect();
    await disconnected.wait(ms => ms.some(m => m.type === 'ready'));
    const pid = disconnected.messages.find(m => m.type === 'ready').pid;
    disconnected.ws.terminate(); await waitGone(pid);
    const normal = h.connect();
    await normal.wait(ms => ms.some(m => m.type === 'ready'));
    normal.send({ type: 'input', data: 'exit 7\r' });
    await normal.wait(ms => ms.some(m => m.type === 'exit'));
    assert.equal(normal.messages.find(m => m.type === 'exit').exitCode, 7);
  } finally { await h.close(); }
});

test('closing a shell that ignores hangup still terminates it', { timeout: 15000 }, async () => {
  const h = await harness();
  try {
    const c = h.connect();
    await c.wait(ms => ms.some(m => m.type === 'ready'));
    const pid = c.messages.find(m => m.type === 'ready').pid;
    c.send({ type: 'input', data: "stty -echo; trap '' HUP; printf '\\nTRAP_READY\\n'\r" });
    await c.wait((_, out) => out.includes('\nTRAP_READY\r\n'));
    c.send({ type: 'close' }); await waitGone(pid);
  } finally { await h.close(); }
});
