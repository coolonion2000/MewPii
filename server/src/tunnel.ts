/**
 * Bounded, cancellable HTTP/WebSocket multiplexing over an outbound agent socket.
 * @author coolonion
 */
import { randomUUID } from "node:crypto";
import http, { type ClientRequest, type IncomingMessage, type ServerResponse } from "node:http";
import WebSocket, { type RawData } from "ws";

export const TUNNEL_CHUNK_BYTES = 48 * 1024;
export const TUNNEL_MAX_HTTP_BYTES = 512 * 1024 * 1024;
const TUNNEL_MAX_CONCURRENT_HTTP = 16;
const TUNNEL_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const TUNNEL_MAX_PENDING_WS_BYTES = 1024 * 1024;
export const TUNNEL_WS_HIGH_WATER_BYTES = 512 * 1024;
export const TUNNEL_WS_LOW_WATER_BYTES = 128 * 1024;
export const TUNNEL_WS_CHANNEL_MAX_BYTES = 4 * 1024 * 1024;
const REPLACED_CLOSE_CODE = 4009;

export interface TunnelMsg {
  type: string;
  id?: string;
  channel?: string;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  status?: number;
  data?: string;
  totalBytes?: number;
  isBinary?: boolean;
  code?: number;
  reason?: string;
  assignedName?: string;
  instanceId?: string;
}

export interface TunnelAgentHandle {
  readonly instanceId: string;
  dispose(): Promise<void>;
}

function closeCode(code: unknown): number {
  return typeof code === "number" && Number.isInteger(code) && code >= 1000 && code < 5000 && code !== 1005 && code !== 1006
    ? code
    : 1000;
}

function rawBuffer(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.alloc(0);
}

function send(ws: WebSocket, message: TunnelMsg): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(message));
  return true;
}

function splitBuffer(buffer: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < buffer.length; offset += TUNNEL_CHUNK_BYTES)
    chunks.push(buffer.subarray(offset, Math.min(buffer.length, offset + TUNNEL_CHUNK_BYTES)));
  return chunks;
}

/** Server-driven heartbeat; ws clients automatically answer ping frames with pong. */
export interface WebSocketFlowState {
  pendingBytes: number;
  resumeTimer?: NodeJS.Timeout;
  sourcePaused?: boolean;
}

export function clearWebSocketFlow(source: WebSocket, flow: WebSocketFlowState): void {
  clearInterval(flow.resumeTimer);
  flow.resumeTimer = undefined;
  flow.pendingBytes = 0;
  if (flow.sourcePaused) {
    flow.sourcePaused = false;
    try { source.resume(); } catch { /* source already closed */ }
  }
}

/** Forward a live WS frame without allowing one channel to grow unbounded. */
export function forwardWebSocketFrame(
  source: WebSocket,
  target: WebSocket,
  data: string | Buffer,
  options: { binary?: boolean } | undefined,
  flow: WebSocketFlowState,
  canPauseSource: boolean,
  onOverflow: () => void,
): boolean {
  if (target.readyState !== WebSocket.OPEN) return false;
  const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.length;
  const projectedBufferedBytes = target.bufferedAmount + bytes;
  flow.pendingBytes = target.bufferedAmount;
  if (projectedBufferedBytes > TUNNEL_WS_CHANNEL_MAX_BYTES) {
    onOverflow();
    return false;
  }
  if (projectedBufferedBytes >= TUNNEL_WS_HIGH_WATER_BYTES && !canPauseSource) {
    onOverflow();
    return false;
  }
  if (options) target.send(data, options);
  else target.send(data);
  flow.pendingBytes = target.bufferedAmount;
  if (Math.max(target.bufferedAmount, projectedBufferedBytes) < TUNNEL_WS_HIGH_WATER_BYTES) return true;
  if (!canPauseSource || typeof source.pause !== "function" || typeof source.resume !== "function") {
    onOverflow();
    return false;
  }
  if (!flow.sourcePaused) {
    source.pause();
    flow.sourcePaused = true;
  }
  if (!flow.resumeTimer) {
    flow.resumeTimer = setInterval(() => {
      if (source.readyState === WebSocket.CLOSED || target.readyState === WebSocket.CLOSED) {
        clearWebSocketFlow(source, flow);
      } else if (target.bufferedAmount <= TUNNEL_WS_LOW_WATER_BYTES) {
        clearWebSocketFlow(source, flow);
      }
    }, 10);
    flow.resumeTimer.unref();
  }
  return true;
}

export function attachWebSocketHeartbeat(ws: WebSocket, intervalMs = 25_000): () => void {
  let alive = true;
  let disposed = false;
  const onPong = () => { alive = true; };
  ws.on("pong", onPong);
  const timer = setInterval(() => {
    if (disposed || ws.readyState === WebSocket.CLOSED) return;
    if (!alive) {
      disposed = true;
      clearInterval(timer);
      try { ws.terminate(); } catch { /* already closed */ }
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    alive = false;
    try { ws.ping(); } catch { /* close/error handles cleanup */ }
  }, intervalMs);
  timer.unref();
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearInterval(timer);
    ws.off("pong", onPong);
  };
  ws.once("close", dispose);
  return dispose;
}

interface PendingHttp {
  response: ServerResponse;
  timer: NodeJS.Timeout;
  responseStarted: boolean;
  responseBytes: number;
  completed: boolean;
}

interface AgentConn {
  ws: WebSocket;
  name: string;
  instanceId: string;
  seq: number;
  pendingHttp: Map<string, PendingHttp>;
  channels: Map<string, {
    clientWs: WebSocket;
    disposeHeartbeat: () => void;
    toAgent: WebSocketFlowState;
    toClient: WebSocketFlowState;
  }>;
  disposeHeartbeat: () => void;
}

export class TunnelHub {
  private agents = new Map<string, AgentConn>();
  private instances = new Map<string, AgentConn>();
  private disposed = false;

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

  handleAgentConnection(ws: WebSocket, requestedName: string, instanceId: string = randomUUID()): string {
    if (this.disposed) {
      ws.close(1001, "hub shutting down");
      return requestedName || "agent";
    }
    const previous = this.instances.get(instanceId);
    let finalName = previous?.name ?? (requestedName.trim() || "agent");
    if (previous) {
      this.dropAgent(previous, 502, "agent instance replaced");
      try { previous.ws.close(REPLACED_CLOSE_CODE, "replaced by same instance"); } catch { /* ignore */ }
    } else {
      const base = finalName;
      let suffix = 2;
      while (this.agents.has(finalName)) finalName = `${base}-${suffix++}`;
    }

    const conn: AgentConn = {
      ws,
      name: finalName,
      instanceId,
      seq: 0,
      pendingHttp: new Map(),
      channels: new Map(),
      disposeHeartbeat: () => undefined,
    };
    conn.disposeHeartbeat = attachWebSocketHeartbeat(ws);
    this.agents.set(finalName, conn);
    this.instances.set(instanceId, conn);
    send(ws, { type: "agent_welcome", assignedName: finalName, instanceId });
    console.log(`[tunnel] agent_connected name=${finalName} instanceId=${instanceId} count=${this.agents.size}`);

    ws.on("message", (raw) => this.onAgentMessage(conn, raw));
    ws.once("close", () => {
      if (this.instances.get(instanceId) === conn) this.dropAgent(conn, 502, "agent disconnected");
    });
    ws.on("error", () => undefined);
    return finalName;
  }

  private dropAgent(conn: AgentConn, status: number, reason: string): void {
    if (this.agents.get(conn.name) === conn) this.agents.delete(conn.name);
    if (this.instances.get(conn.instanceId) === conn) this.instances.delete(conn.instanceId);
    conn.disposeHeartbeat();
    for (const [id, pending] of conn.pendingHttp) {
      clearTimeout(pending.timer);
      pending.completed = true;
      if (!pending.response.headersSent) pending.response.writeHead(status, { "content-type": "application/json" });
      pending.response.end(JSON.stringify({ error: reason }));
      conn.pendingHttp.delete(id);
    }
    for (const [channel, entry] of conn.channels) {
      entry.disposeHeartbeat();
      clearWebSocketFlow(entry.clientWs, entry.toAgent);
      clearWebSocketFlow(conn.ws, entry.toClient);
      if (entry.clientWs.readyState === WebSocket.OPEN || entry.clientWs.readyState === WebSocket.CONNECTING)
        entry.clientWs.close(1001, reason);
      conn.channels.delete(channel);
    }
    console.log(`[tunnel] agent_disconnected name=${conn.name} reason=${JSON.stringify(reason)} count=${this.agents.size}`);
  }

  private cancelHttp(conn: AgentConn, id: string, status: number, reason: string): void {
    const pending = conn.pendingHttp.get(id);
    if (!pending) return;
    conn.pendingHttp.delete(id);
    clearTimeout(pending.timer);
    pending.completed = true;
    send(conn.ws, { type: "http_cancel", id, reason });
    if (!pending.response.headersSent) pending.response.writeHead(status, { "content-type": "application/json" });
    pending.response.end(JSON.stringify({ error: reason }));
  }

  private onAgentMessage(conn: AgentConn, raw: RawData): void {
    let msg: TunnelMsg;
    try { msg = JSON.parse(rawBuffer(raw).toString("utf8")) as TunnelMsg; } catch { return; }
    if (msg.type === "http_response" && msg.id) {
      const pending = conn.pendingHttp.get(msg.id);
      if (!pending || pending.completed) return;
      const declaredLength = Number(msg.headers?.["content-length"] ?? 0);
      if (Number.isFinite(declaredLength) && declaredLength > TUNNEL_MAX_HTTP_BYTES) {
        this.cancelHttp(conn, msg.id, 413, "tunnel response too large");
        return;
      }
      pending.responseStarted = true;
      pending.response.writeHead(msg.status ?? 502, msg.headers ?? {});
      return;
    }
    if (msg.type === "http_chunk" && msg.id) {
      const pending = conn.pendingHttp.get(msg.id);
      if (!pending || pending.completed) return;
      const chunk = Buffer.from(msg.data ?? "", "base64");
      pending.responseBytes += chunk.length;
      if (pending.responseBytes > TUNNEL_MAX_HTTP_BYTES || pending.response.writableLength > TUNNEL_MAX_BUFFERED_BYTES) {
        this.cancelHttp(conn, msg.id, 413, "tunnel response too large or backpressured");
        return;
      }
      if (!pending.responseStarted) {
        pending.responseStarted = true;
        pending.response.writeHead(200);
      }
      pending.response.write(chunk);
      return;
    }
    if ((msg.type === "http_end" || msg.type === "http_error") && msg.id) {
      const pending = conn.pendingHttp.get(msg.id);
      if (!pending || pending.completed) return;
      conn.pendingHttp.delete(msg.id);
      clearTimeout(pending.timer);
      pending.completed = true;
      if (!pending.response.headersSent)
        pending.response.writeHead(msg.type === "http_error" ? (msg.status ?? 502) : (msg.status ?? 200), msg.headers ?? {});
      if (msg.type === "http_error" && msg.data) pending.response.write(Buffer.from(msg.data, "base64"));
      pending.response.end();
      return;
    }
    if (msg.type === "ws_msg" && msg.channel) {
      const entry = conn.channels.get(msg.channel);
      if (!entry || entry.clientWs.readyState !== WebSocket.OPEN) return;
      const data = msg.isBinary ? Buffer.from(msg.data ?? "", "base64") : (msg.data ?? "");
      forwardWebSocketFrame(conn.ws, entry.clientWs, data, { binary: msg.isBinary === true }, entry.toClient, false, () => {
        conn.channels.delete(msg.channel!);
        clearWebSocketFlow(entry.clientWs, entry.toAgent);
        clearWebSocketFlow(conn.ws, entry.toClient);
        entry.clientWs.close(1009, "tunnel websocket backpressure");
        send(conn.ws, { type: "ws_close", channel: msg.channel, code: 1009, reason: "tunnel websocket backpressure" });
      });
      return;
    }
    if (msg.type === "ws_close" && msg.channel) {
      const entry = conn.channels.get(msg.channel);
      if (!entry) return;
      conn.channels.delete(msg.channel);
      entry.disposeHeartbeat();
      clearWebSocketFlow(entry.clientWs, entry.toAgent);
      clearWebSocketFlow(conn.ws, entry.toClient);
      if (entry.clientWs.readyState === WebSocket.OPEN || entry.clientWs.readyState === WebSocket.CONNECTING)
        entry.clientWs.close(closeCode(msg.code), msg.reason ?? "");
    }
  }

  /** Stream one HTTP request/response through bounded tunnel frames. */
  proxyHttp(
    name: string | undefined,
    method: string,
    path: string,
    headers: Record<string, string>,
    request: IncomingMessage,
    response: ServerResponse,
    timeoutMs = 120_000,
  ): boolean {
    const conn = this.resolve(name);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN || this.disposed) return false;
    const contentLength = Number(request.headers["content-length"] ?? 0);
    if (Number.isFinite(contentLength) && contentLength > TUNNEL_MAX_HTTP_BYTES) {
      response.writeHead(413, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "tunnel request too large" }));
      return true;
    }
    if (conn.pendingHttp.size >= TUNNEL_MAX_CONCURRENT_HTTP) {
      response.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
      response.end(JSON.stringify({ error: "too many concurrent tunnel requests" }));
      return true;
    }

    const id = `h${++conn.seq}`;
    const pending: PendingHttp = {
      response,
      timer: setTimeout(() => this.cancelHttp(conn, id, 504, "agent timeout"), timeoutMs),
      responseStarted: false,
      responseBytes: 0,
      completed: false,
    };
    pending.timer.unref();
    conn.pendingHttp.set(id, pending);
    send(conn.ws, { type: "http_start", id, method, path, headers, totalBytes: contentLength || undefined });

    let requestBytes = 0;
    const cancel = (reason: string) => {
      if (!conn.pendingHttp.has(id)) return;
      this.cancelHttp(conn, id, 499, reason);
    };
    request.on("data", (raw: Buffer) => {
      if (!conn.pendingHttp.has(id)) return;
      const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      requestBytes += buffer.length;
      if (requestBytes > TUNNEL_MAX_HTTP_BYTES) {
        request.pause();
        this.cancelHttp(conn, id, 413, "tunnel request too large");
        return;
      }
      for (const chunk of splitBuffer(buffer)) {
        if (!send(conn.ws, { type: "http_chunk", id, data: chunk.toString("base64") })) {
          cancel("agent disconnected");
          return;
        }
      }
      if (conn.ws.bufferedAmount > TUNNEL_MAX_BUFFERED_BYTES) {
        request.pause();
        const resume = setInterval(() => {
          if (!conn.pendingHttp.has(id)) {
            clearInterval(resume);
            return;
          }
          if (conn.ws.bufferedAmount <= TUNNEL_MAX_BUFFERED_BYTES / 2) {
            clearInterval(resume);
            request.resume();
          }
        }, 10);
        resume.unref();
      }
    });
    request.once("end", () => {
      if (conn.pendingHttp.has(id)) send(conn.ws, { type: "http_end", id });
    });
    request.once("aborted", () => cancel("browser request aborted"));
    response.once("close", () => {
      if (!pending.completed && !response.writableEnded) cancel("browser response closed");
    });
    return true;
  }

  proxyWs(name: string | undefined, clientWs: WebSocket, path: string): boolean {
    const conn = this.resolve(name);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN || this.disposed) return false;
    const channel = `c${++conn.seq}`;
    const disposeHeartbeat = attachWebSocketHeartbeat(clientWs);
    conn.channels.set(channel, {
      clientWs,
      disposeHeartbeat,
      toAgent: { pendingBytes: 0 },
      toClient: { pendingBytes: 0 },
    });
    const entry = conn.channels.get(channel)!;
    const overflow = () => {
      if (conn.channels.get(channel) !== entry) return;
      conn.channels.delete(channel);
      disposeHeartbeat();
      clearWebSocketFlow(clientWs, entry.toAgent);
      clearWebSocketFlow(conn.ws, entry.toClient);
      if (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING)
        clientWs.close(1009, "tunnel websocket backpressure");
      send(conn.ws, { type: "ws_close", channel, code: 1009, reason: "tunnel websocket backpressure" });
    };
    send(conn.ws, { type: "ws_open", channel, path });
    clientWs.on("message", (raw, isBinary) => {
      if (conn.ws.readyState !== WebSocket.OPEN) return;
      const buffer = rawBuffer(raw);
      const message = JSON.stringify({
        type: "ws_msg",
        channel,
        isBinary,
        data: isBinary ? buffer.toString("base64") : buffer.toString("utf8"),
      } satisfies TunnelMsg);
      forwardWebSocketFrame(clientWs, conn.ws, message, undefined, entry.toAgent, true, overflow);
    });
    clientWs.once("close", (code, reason) => {
      const active = conn.channels.get(channel) === entry;
      conn.channels.delete(channel);
      disposeHeartbeat();
      clearWebSocketFlow(clientWs, entry.toAgent);
      clearWebSocketFlow(conn.ws, entry.toClient);
      if (active) send(conn.ws, { type: "ws_close", channel, code: closeCode(code), reason: String(reason) });
    });
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const conn of [...this.agents.values()]) {
      this.dropAgent(conn, 503, "hub shutting down");
      if (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING)
        conn.ws.close(1001, "hub shutting down");
    }
  }
}

interface LocalChannel {
  ws: WebSocket;
  pending: { data: string; isBinary: boolean; bytes: number }[];
  pendingBytes: number;
  toHub: WebSocketFlowState;
  toLocal: WebSocketFlowState;
}

interface LocalHttp {
  request: ClientRequest;
  queued: Buffer[];
  queuedBytes: number;
  ended: boolean;
  completed: boolean;
  requestBytes: number;
}

export function runTunnelAgent(opts: {
  hubUrl: string;
  token?: string;
  localPort: number;
  name?: string;
  instanceId?: string;
  reconnectDelayMs?: number;
}): TunnelAgentHandle {
  const localBase = `http://127.0.0.1:${opts.localPort}`;
  const localWs = `ws://127.0.0.1:${opts.localPort}`;
  const channels = new Map<string, LocalChannel>();
  const requests = new Map<string, LocalHttp>();
  const instanceId = opts.instanceId ?? process.env.PII_AGENT_INSTANCE_ID ?? randomUUID();
  const params = new URLSearchParams({
    name: opts.name ?? "agent",
    instanceId,
  });
  const hubUrl = opts.hubUrl + (opts.hubUrl.includes("?") ? "&" : "?") + params.toString();
  let currentWs: WebSocket | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let disposed = false;

  const connect = (): void => {
    if (disposed) return;
    const headers: Record<string, string> = {};
    if (opts.token) headers.Authorization = `Basic ${Buffer.from(`pi:${opts.token}`).toString("base64")}`;
    const ws = new WebSocket(hubUrl, { headers });
    currentWs = ws;
    const disposeHeartbeat = attachWebSocketHeartbeat(ws);

    const sendAgent = (message: TunnelMsg): boolean => send(ws, message);
    const failRequest = (id: string, status: number, reason: string): void => {
      const state = requests.get(id);
      if (!state || state.completed) return;
      state.completed = true;
      requests.delete(id);
      state.request.destroy(new Error(reason));
      sendAgent({ type: "http_error", id, status, data: Buffer.from(JSON.stringify({ error: reason })).toString("base64") });
    };
    const flushRequest = (id: string): void => {
      const state = requests.get(id);
      if (!state || state.completed) return;
      while (state.queued.length > 0) {
        const chunk = state.queued.shift()!;
        state.queuedBytes -= chunk.length;
        if (!state.request.write(chunk)) return;
      }
      if (state.ended) state.request.end();
    };

    const startHttp = (msg: TunnelMsg): void => {
      const id = msg.id!;
      if ((msg.totalBytes ?? 0) > TUNNEL_MAX_HTTP_BYTES || requests.size >= TUNNEL_MAX_CONCURRENT_HTTP) {
        sendAgent({ type: "http_error", id, status: (msg.totalBytes ?? 0) > TUNNEL_MAX_HTTP_BYTES ? 413 : 429 });
        return;
      }
      const request = http.request(
        `${localBase}${msg.path ?? "/"}`,
        { method: msg.method, headers: { ...msg.headers, host: `127.0.0.1:${opts.localPort}` } },
      );
      const state: LocalHttp = { request, queued: [], queuedBytes: 0, ended: false, completed: false, requestBytes: 0 };
      requests.set(id, state);
      request.on("response", (response) => {
        const responseHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(response.headers)) {
          if (typeof value === "string") responseHeaders[key] = value;
          else if (Array.isArray(value)) responseHeaders[key] = value.join(", ");
        }
        const declaredLength = Number(responseHeaders["content-length"] ?? 0);
        if (Number.isFinite(declaredLength) && declaredLength > TUNNEL_MAX_HTTP_BYTES) {
          state.completed = true;
          requests.delete(id);
          response.destroy();
          sendAgent({ type: "http_error", id, status: 413 });
          return;
        }
        sendAgent({ type: "http_response", id, status: response.statusCode ?? 500, headers: responseHeaders });
        let responseBytes = 0;
        response.on("data", (raw: Buffer) => {
          const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
          responseBytes += buffer.length;
          if (responseBytes > TUNNEL_MAX_HTTP_BYTES) {
            response.destroy();
            failRequest(id, 413, "local response too large");
            return;
          }
          for (const chunk of splitBuffer(buffer)) sendAgent({ type: "http_chunk", id, data: chunk.toString("base64") });
          if (ws.bufferedAmount > TUNNEL_MAX_BUFFERED_BYTES) {
            response.pause();
            const resume = setInterval(() => {
              if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount <= TUNNEL_MAX_BUFFERED_BYTES / 2) {
                clearInterval(resume);
                if (ws.readyState === WebSocket.OPEN) response.resume();
              }
            }, 10);
            resume.unref();
          }
        });
        response.once("end", () => {
          const current = requests.get(id);
          if (!current || current.completed) return;
          current.completed = true;
          requests.delete(id);
          sendAgent({ type: "http_end", id });
        });
        response.once("error", (cause) => failRequest(id, 502, cause.message));
      });
      request.on("drain", () => flushRequest(id));
      request.once("error", (cause) => failRequest(id, 502, cause.message));
    };

    const openChannel = (channel: string, path: string): void => {
      const local = new WebSocket(`${localWs}${path}`);
      const state: LocalChannel = {
        ws: local,
        pending: [],
        pendingBytes: 0,
        toHub: { pendingBytes: 0 },
        toLocal: { pendingBytes: 0 },
      };
      channels.set(channel, state);
      const overflow = () => {
        if (channels.get(channel) !== state) return;
        channels.delete(channel);
        clearWebSocketFlow(local, state.toHub);
        clearWebSocketFlow(ws, state.toLocal);
        if (local.readyState === WebSocket.OPEN || local.readyState === WebSocket.CONNECTING)
          local.close(1009, "tunnel websocket backpressure");
        sendAgent({ type: "ws_close", channel, code: 1009, reason: "tunnel websocket backpressure" });
      };
      local.once("open", () => {
        for (const frame of state.pending.splice(0)) {
          if (local.readyState !== WebSocket.OPEN) break;
          const data = frame.isBinary ? Buffer.from(frame.data, "base64") : frame.data;
          if (!forwardWebSocketFrame(ws, local, data, { binary: frame.isBinary }, state.toLocal, false, overflow)) break;
        }
        state.pendingBytes = 0;
      });
      local.on("message", (raw, isBinary) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const buffer = rawBuffer(raw);
        const message = JSON.stringify({
          type: "ws_msg",
          channel,
          isBinary,
          data: isBinary ? buffer.toString("base64") : buffer.toString("utf8"),
        } satisfies TunnelMsg);
        forwardWebSocketFrame(local, ws, message, undefined, state.toHub, true, overflow);
      });
      local.once("close", (code, reason) => {
        const active = channels.get(channel) === state;
        channels.delete(channel);
        clearWebSocketFlow(local, state.toHub);
        clearWebSocketFlow(ws, state.toLocal);
        if (active) sendAgent({ type: "ws_close", channel, code: closeCode(code), reason: String(reason) });
      });
      local.once("error", () => {
        if (channels.get(channel) === state) overflow();
      });
    };

    ws.on("open", () => console.log(`[agent] connected hub=${opts.hubUrl} instanceId=${instanceId}`));
    ws.on("message", (raw) => {
      let msg: TunnelMsg;
      try { msg = JSON.parse(rawBuffer(raw).toString("utf8")) as TunnelMsg; } catch { return; }
      if (msg.type === "agent_welcome") {
        console.log(`[agent] registered name=${msg.assignedName ?? opts.name ?? "agent"} instanceId=${instanceId}`);
      } else if (msg.type === "http_start" && msg.id) {
        startHttp(msg);
      } else if (msg.type === "http_chunk" && msg.id) {
        const state = requests.get(msg.id);
        if (!state || state.completed) return;
        const chunk = Buffer.from(msg.data ?? "", "base64");
        state.requestBytes += chunk.length;
        if (state.requestBytes > TUNNEL_MAX_HTTP_BYTES) {
          failRequest(msg.id, 413, "tunnel request too large");
          return;
        }
        state.queued.push(chunk);
        state.queuedBytes += chunk.length;
        if (state.queuedBytes > TUNNEL_MAX_BUFFERED_BYTES) {
          failRequest(msg.id, 413, "local request backpressured");
          return;
        }
        flushRequest(msg.id);
      } else if (msg.type === "http_end" && msg.id) {
        const state = requests.get(msg.id);
        if (state) {
          state.ended = true;
          flushRequest(msg.id);
        }
      } else if (msg.type === "http_cancel" && msg.id) {
        const state = requests.get(msg.id);
        if (state) {
          state.completed = true;
          requests.delete(msg.id);
          state.request.destroy(new Error(msg.reason ?? "cancelled by hub"));
        }
      } else if (msg.type === "ws_open" && msg.channel) {
        openChannel(msg.channel, msg.path ?? "/ws");
      } else if (msg.type === "ws_msg" && msg.channel) {
        const state = channels.get(msg.channel);
        if (!state || state.ws.readyState === WebSocket.CLOSING || state.ws.readyState === WebSocket.CLOSED) return;
        if (state.ws.readyState === WebSocket.OPEN) {
          const data = msg.isBinary ? Buffer.from(msg.data ?? "", "base64") : (msg.data ?? "");
          forwardWebSocketFrame(ws, state.ws, data, { binary: msg.isBinary === true }, state.toLocal, false, () => {
            channels.delete(msg.channel!);
            clearWebSocketFlow(state.ws, state.toHub);
            clearWebSocketFlow(ws, state.toLocal);
            state.ws.close(1009, "tunnel websocket backpressure");
            sendAgent({ type: "ws_close", channel: msg.channel, code: 1009, reason: "tunnel websocket backpressure" });
          });
        } else {
          const bytes = msg.isBinary ? Buffer.byteLength(msg.data ?? "", "base64") : Buffer.byteLength(msg.data ?? "", "utf8");
          state.pendingBytes += bytes;
          if (state.pendingBytes > TUNNEL_MAX_PENDING_WS_BYTES) {
            state.ws.close(1009, "pending websocket input too large");
            channels.delete(msg.channel);
            sendAgent({ type: "ws_close", channel: msg.channel, code: 1009, reason: "pending websocket input too large" });
            return;
          }
          state.pending.push({ data: msg.data ?? "", isBinary: msg.isBinary === true, bytes });
        }
      } else if (msg.type === "ws_close" && msg.channel) {
        const state = channels.get(msg.channel);
        if (state) {
          channels.delete(msg.channel);
          clearWebSocketFlow(state.ws, state.toHub);
          clearWebSocketFlow(ws, state.toLocal);
          if (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)
            state.ws.close(closeCode(msg.code), msg.reason ?? "");
        }
      }
    });

    ws.once("close", (code) => {
      disposeHeartbeat();
      for (const state of channels.values()) {
        clearWebSocketFlow(state.ws, state.toHub);
        clearWebSocketFlow(ws, state.toLocal);
        if (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING) state.ws.close(1001);
      }
      channels.clear();
      for (const [id, state] of requests) {
        state.completed = true;
        state.request.destroy(new Error("hub disconnected"));
        requests.delete(id);
      }
      if (currentWs === ws) currentWs = undefined;
      if (disposed || code === REPLACED_CLOSE_CODE) {
        if (code === REPLACED_CLOSE_CODE) {
          disposed = true;
          console.error(`[agent] instance_replaced instanceId=${instanceId}; reconnect disabled`);
        }
        return;
      }
      reconnectTimer = setTimeout(connect, opts.reconnectDelayMs ?? 3000);
      reconnectTimer.unref();
    });
    ws.on("error", () => undefined);
  };

  connect();
  return {
    instanceId,
    async dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(reconnectTimer);
      const ws = currentWs;
      currentWs = undefined;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) ws.close(1001, "agent shutting down");
      for (const state of channels.values()) {
        clearWebSocketFlow(state.ws, state.toHub);
        if (ws) clearWebSocketFlow(ws, state.toLocal);
        if (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING) state.ws.close(1001);
      }
      channels.clear();
      for (const state of requests.values()) state.request.destroy(new Error("agent shutting down"));
      requests.clear();
    },
  };
}
