/**
 * pii tunnel: multiplexes HTTP and WebSocket traffic over outbound WebSocket
 * connections. Agents (machines running pi) dial out to the hub (NAS), and
 * the hub serves a pii UI whose pi runtime lives on any connected agent.
 */
import http from 'node:http';
import WebSocket, { type RawData } from 'ws';

export interface TunnelMsg {
  type: string;
  id?: string;
  channel?: string;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  bodyB64?: string;
  status?: number;
  data?: string;
  code?: number;
  reason?: string;
}

/** WS close codes 1005/1006 are reserved and must not be sent; map them to 1000. */
function closeCode(code: unknown): number {
  return typeof code === 'number' && Number.isInteger(code) && code >= 1000 && code < 5000 && code !== 1005 && code !== 1006
    ? code
    : 1000;
}

// ---------------------------------------------------------------------------
// Hub side: any number of named agents; HTTP/WS traffic routes to one of them.
// ---------------------------------------------------------------------------
interface AgentConn {
  ws: WebSocket;
  name: string;
  seq: number;
  pendingHttp: Map<string, { resolve: (m: TunnelMsg) => void; timer: NodeJS.Timeout }>;
  channels: Map<string, { clientWs: WebSocket }>;
}

export class TunnelHub {
  private agents = new Map<string, AgentConn>();

  get connected(): boolean {
    return this.agents.size > 0;
  }

  agentNames(): string[] {
    return [...this.agents.keys()];
  }

  private resolve(name?: string): AgentConn | undefined {
    if (name) return this.agents.get(name);
    return this.agents.values().next().value;
  }

  handleAgentConnection(ws: WebSocket, name: string): void {
    // unique name: suffix on collision with a LIVE agent; a reconnect with the
    // same name replaces the stale connection
    let finalName = name || 'agent';
    const existing = this.agents.get(finalName);
    if (existing) {
      try { existing.ws.close(1000, 'replaced by reconnect'); } catch { /* ignore */ }
      this.dropAgent(finalName);
    } else {
      let n = 2;
      const base = finalName;
      while (this.agents.has(finalName)) finalName = `${base}-${n++}`;
    }

    const conn: AgentConn = { ws, name: finalName, seq: 0, pendingHttp: new Map(), channels: new Map() };
    this.agents.set(finalName, conn);
    console.log(`[tunnel] agent connected: ${finalName} (${this.agents.size} total)`);

    // heartbeat: proxies/NATs silently kill idle websockets — detect it
    let alive = true;
    ws.on('pong', () => { alive = true; });
    const heartbeat = setInterval(() => {
      if (!alive) {
        clearInterval(heartbeat);
        try { ws.terminate(); } catch { /* ignore */ }
        if (this.agents.get(finalName)?.ws === ws) this.dropAgent(finalName);
        return;
      }
      alive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }, 25_000);
    ws.on('close', () => clearInterval(heartbeat));

    ws.on('message', (raw) => this.onAgentMessage(conn, raw));
    ws.on('close', () => {
      // identity check: a stale connection's late close must not evict the live one
      if (this.agents.get(finalName)?.ws === ws) {
        this.dropAgent(finalName);
      }
    });
    ws.on('error', () => undefined);
  }

  private dropAgent(name: string): void {
    const conn = this.agents.get(name);
    if (!conn) return;
    this.agents.delete(name);
    for (const [, p] of conn.pendingHttp) {
      clearTimeout(p.timer);
      p.resolve({ type: 'http_result', status: 502, bodyB64: Buffer.from(JSON.stringify({ error: 'agent disconnected' })).toString('base64') });
    }
    for (const [, c] of conn.channels) c.clientWs.close(1001, 'agent disconnected');
    console.log(`[tunnel] agent disconnected: ${name} (${this.agents.size} left)`);
  }

  private onAgentMessage(conn: AgentConn, raw: RawData): void {
    let msg: TunnelMsg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === 'http_result' && msg.id) {
      const p = conn.pendingHttp.get(msg.id);
      if (p) {
        conn.pendingHttp.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(msg);
      }
    } else if (msg.type === 'ws_msg' && msg.channel) {
      conn.channels.get(msg.channel)?.clientWs.send(msg.data ?? '');
    } else if (msg.type === 'ws_close' && msg.channel) {
      const c = conn.channels.get(msg.channel);
      if (c) {
        conn.channels.delete(msg.channel);
        c.clientWs.close(closeCode(msg.code), msg.reason ?? '');
      }
    }
  }

  /** Proxy an HTTP request to an agent; null when no such agent. */
  proxyHttp(name: string | undefined, method: string, path: string, headers: Record<string, string>, body: Buffer): Promise<TunnelMsg> | null {
    const conn = this.resolve(name);
    if (!conn || conn.ws.readyState !== conn.ws.OPEN) return null;
    const id = `h${++conn.seq}`;
    return new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        conn.pendingHttp.delete(id);
        resolvePromise({ type: 'http_result', status: 504, bodyB64: Buffer.from(JSON.stringify({ error: 'agent timeout' })).toString('base64') });
      }, 120_000);
      conn.pendingHttp.set(id, { resolve: resolvePromise, timer });
      conn.ws.send(JSON.stringify({ type: 'http', id, method, path, headers, bodyB64: body.toString('base64') } satisfies TunnelMsg));
    });
  }

  /** Proxy a browser WebSocket to an agent; false when no such agent. */
  proxyWs(name: string | undefined, clientWs: WebSocket, path: string): boolean {
    const conn = this.resolve(name);
    if (!conn || conn.ws.readyState !== conn.ws.OPEN) return false;
    const channel = `c${++conn.seq}`;
    conn.channels.set(channel, { clientWs });
    conn.ws.send(JSON.stringify({ type: 'ws_open', channel, path } satisfies TunnelMsg));
    clientWs.on('message', (raw) => {
      if (conn.ws.readyState === conn.ws.OPEN) {
        conn.ws.send(JSON.stringify({ type: 'ws_msg', channel, data: String(raw) } satisfies TunnelMsg));
      }
    });
    clientWs.on('close', (code, reason) => {
      conn.channels.delete(channel);
      if (conn.ws.readyState === conn.ws.OPEN) {
        conn.ws.send(JSON.stringify({ type: 'ws_close', channel, code: closeCode(code), reason: String(reason) } satisfies TunnelMsg));
      }
    });
    return true;
  }
}

// ---------------------------------------------------------------------------
// Agent side: runs a loopback pii server and pipes tunnel traffic to it.
// ---------------------------------------------------------------------------
export function runTunnelAgent(opts: {
  hubUrl: string;
  token?: string;
  localPort: number;
  name?: string;
}): void {
  const localBase = `http://127.0.0.1:${opts.localPort}`;
  const localWs = `ws://127.0.0.1:${opts.localPort}`;
  const channels = new Map<string, WebSocket>();
  const hubUrl = opts.name
    ? opts.hubUrl + (opts.hubUrl.includes('?') ? '&' : '?') + `name=${encodeURIComponent(opts.name)}`
    : opts.hubUrl;

  const connect = (): void => {
    const headers: Record<string, string> = {};
    if (opts.token) headers.Authorization = `Basic ${Buffer.from(`pi:${opts.token}`).toString('base64')}`;
    const ws = new WebSocket(hubUrl, { headers });

    let hubAlive = true;
    ws.on('pong', () => { hubAlive = true; });
    const heartbeat = setInterval(() => {
      if (!hubAlive) {
        clearInterval(heartbeat);
        try { ws.terminate(); } catch { /* ignore */ }
        return;
      }
      hubAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }, 25_000);
    ws.on('close', () => clearInterval(heartbeat));

    ws.on('open', () => console.log(`[agent] connected to hub ${opts.hubUrl}${opts.name ? ` as "${opts.name}"` : ''}`));

    ws.on('message', (raw) => {
      let msg: TunnelMsg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === 'http' && msg.id) {
        void forwardHttp(msg);
      } else if (msg.type === 'ws_open' && msg.channel) {
        openChannel(msg.channel, msg.path ?? '/ws');
      } else if (msg.type === 'ws_msg' && msg.channel) {
        channels.get(msg.channel)?.send(msg.data ?? '');
      } else if (msg.type === 'ws_close' && msg.channel) {
        const c = channels.get(msg.channel);
        if (c) {
          channels.delete(msg.channel);
          c.close(closeCode(msg.code), msg.reason ?? '');
        }
      }
    });

    const forwardHttp = async (msg: TunnelMsg): Promise<void> => {
      const reply = (status: number, body: Buffer, headers: Record<string, string> = {}): void => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'http_result', id: msg.id, status, headers, bodyB64: body.toString('base64') } satisfies TunnelMsg));
        }
      };
      try {
        const result = await new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>((resolvePromise, reject) => {
          const req = http.request(
            `${localBase}${msg.path}`,
            { method: msg.method, headers: { ...msg.headers, host: `127.0.0.1:${opts.localPort}` } },
            (res) => {
              const chunks: Buffer[] = [];
              res.on('data', (c: Buffer) => chunks.push(c));
              res.on('end', () => {
                const headers: Record<string, string> = {};
                const ct = res.headers['content-type'];
                if (typeof ct === 'string') headers['content-type'] = ct;
                resolvePromise({ status: res.statusCode ?? 500, headers, body: Buffer.concat(chunks) });
              });
            },
          );
          req.on('error', reject);
          req.write(Buffer.from(msg.bodyB64 ?? '', 'base64'));
          req.end();
        });
        reply(result.status, result.body, result.headers);
      } catch (err) {
        reply(502, Buffer.from(JSON.stringify({ error: String(err) })));
      }
    };

    const openChannel = (channel: string, path: string): void => {
      const local = new WebSocket(`${localWs}${path}`);
      channels.set(channel, local);
      local.on('message', (data) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'ws_msg', channel, data: String(data) } satisfies TunnelMsg));
        }
      });
      local.on('close', (code, reason) => {
        channels.delete(channel);
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'ws_close', channel, code: closeCode(code), reason: String(reason) } satisfies TunnelMsg));
        }
      });
      local.on('error', () => {
        channels.delete(channel);
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'ws_close', channel, code: 1011 } satisfies TunnelMsg));
        }
      });
    };

    ws.on('close', () => {
      for (const [, c] of channels) c.close(1001);
      channels.clear();
      console.log('[agent] hub connection lost, retrying in 3s…');
      setTimeout(connect, 3000);
    });
    ws.on('error', () => undefined);
  };

  connect();
}
