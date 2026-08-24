/**
 * pii tunnel: multiplexes HTTP and WebSocket traffic over a single outbound
 * WebSocket connection. The Mac side (agent) dials out to the NAS side (hub),
 * which lets the NAS serve a pii UI whose pi runtime lives on the Mac.
 */
import http from 'node:http';
import WebSocket, { type RawData } from 'ws';

/** WS close codes 1005/1006 are reserved and must not be sent; map them to 1000. */
function closeCode(code: unknown): number {
  return typeof code === 'number' && Number.isInteger(code) && code >= 1000 && code < 5000 && code !== 1005 && code !== 1006
    ? code
    : 1000;
}

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

// ---------------------------------------------------------------------------
// Hub side (NAS): agents connect here; HTTP/WS traffic is proxied to them.
// ---------------------------------------------------------------------------
export class TunnelHub {
  private agent?: WebSocket;
  private seq = 0;
  private pendingHttp = new Map<string, { resolve: (m: TunnelMsg) => void; timer: NodeJS.Timeout }>();
  private channels = new Map<string, { clientWs: WebSocket }>();

  get connected(): boolean {
    return this.agent !== undefined && this.agent.readyState === this.agent.OPEN;
  }

  handleAgentConnection(ws: WebSocket): void {
    if (this.agent) {
      try {
        this.agent.close(1000, 'replaced by new agent');
      } catch {
        // ignore
      }
      this.dropAgent();
    }
    this.agent = ws;
    console.log('[tunnel] agent connected');
    ws.on('message', (raw) => this.onAgentMessage(raw));
    ws.on('close', () => this.dropAgent());
    ws.on('error', () => undefined);
  }

  private dropAgent(): void {
    this.agent = undefined;
    for (const [, p] of this.pendingHttp) {
      clearTimeout(p.timer);
      p.resolve({ type: 'http_result', status: 502, bodyB64: Buffer.from(JSON.stringify({ error: 'agent disconnected' })).toString('base64') });
    }
    this.pendingHttp.clear();
    for (const [channel, c] of this.channels) {
      c.clientWs.close(1001, 'agent disconnected');
      this.channels.delete(channel);
    }
    console.log('[tunnel] agent disconnected');
  }

  private onAgentMessage(raw: RawData): void {
    let msg: TunnelMsg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === 'http_result' && msg.id) {
      const p = this.pendingHttp.get(msg.id);
      if (p) {
        this.pendingHttp.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(msg);
      }
    } else if (msg.type === 'ws_msg' && msg.channel) {
      this.channels.get(msg.channel)?.clientWs.send(msg.data ?? '');
    } else if (msg.type === 'ws_close' && msg.channel) {
      const c = this.channels.get(msg.channel);
      if (c) {
        this.channels.delete(msg.channel);
        c.clientWs.close(closeCode(msg.code), msg.reason ?? '');
      }
    }
  }

  /** Proxy an HTTP request to the agent; returns null if no agent connected. */
  proxyHttp(method: string, path: string, headers: Record<string, string>, body: Buffer): Promise<TunnelMsg> | null {
    const agent = this.agent;
    if (!agent || agent.readyState !== agent.OPEN) return null;
    const id = `h${++this.seq}`;
    return new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        this.pendingHttp.delete(id);
        resolvePromise({ type: 'http_result', status: 504, bodyB64: Buffer.from(JSON.stringify({ error: 'agent timeout' })).toString('base64') });
      }, 120_000);
      this.pendingHttp.set(id, { resolve: resolvePromise, timer });
      agent.send(JSON.stringify({ type: 'http', id, method, path, headers, bodyB64: body.toString('base64') } satisfies TunnelMsg));
    });
  }

  /** Proxy a browser WebSocket (/ws) to the agent; returns false if no agent. */
  proxyWs(clientWs: WebSocket, path: string): boolean {
    const agent = this.agent;
    if (!agent || agent.readyState !== agent.OPEN) return false;
    const channel = `c${++this.seq}`;
    this.channels.set(channel, { clientWs });
    agent.send(JSON.stringify({ type: 'ws_open', channel, path } satisfies TunnelMsg));
    clientWs.on('message', (raw) => {
      if (agent.readyState === agent.OPEN) {
        agent.send(JSON.stringify({ type: 'ws_msg', channel, data: String(raw) } satisfies TunnelMsg));
      }
    });
    clientWs.on('close', (code, reason) => {
      this.channels.delete(channel);
      if (agent.readyState === agent.OPEN) {
        agent.send(JSON.stringify({ type: 'ws_close', channel, code: closeCode(code), reason: String(reason) } satisfies TunnelMsg));
      }
    });
    return true;
  }
}

// ---------------------------------------------------------------------------
// Agent side (Mac): runs a loopback pii server and pipes tunnel traffic to it.
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

  const connect = (): void => {
    const headers: Record<string, string> = {};
    if (opts.token) headers.Authorization = `Basic ${Buffer.from(`pi:${opts.token}`).toString('base64')}`;
    const ws = new WebSocket(opts.hubUrl, { headers });

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
