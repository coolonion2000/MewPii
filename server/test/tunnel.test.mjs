/**
 * Tunnel transport and process-liveness regressions.
 * @author coolonion
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import {
  TUNNEL_CHUNK_BYTES,
  TUNNEL_MAX_HTTP_BYTES,
  TUNNEL_WS_CHANNEL_MAX_BYTES,
  TUNNEL_WS_HIGH_WATER_BYTES,
  TunnelHub,
  attachWebSocketHeartbeat,
  forwardWebSocketFrame,
  runTunnelAgent,
} from "../dist/tunnel.js";

const root = fileURLToPath(new URL("../..", import.meta.url));

class FakeWebSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  sent = [];
  closeCode;
  terminated = false;
  bufferedAmount = 0;
  paused = false;
  send(data, options) { this.sent.push({ data, options }); }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  ping() { this.sent.push({ ping: true }); }
  close(code = 1000, reason = "") {
    if (this.readyState === WebSocket.CLOSED) return;
    this.closeCode = code;
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code, Buffer.from(reason));
  }
  terminate() {
    this.terminated = true;
    this.readyState = WebSocket.CLOSED;
    this.emit("close", 1006, Buffer.alloc(0));
  }
}

class FakeRequest extends EventEmitter {
  constructor(headers = {}) { super(); this.headers = headers; }
  paused = false;
  pause() { this.paused = true; }
  resume() { this.paused = false; }
}

class FakeResponse extends EventEmitter {
  headersSent = false;
  writableEnded = false;
  writableLength = 0;
  status;
  headers = {};
  chunks = [];
  writeHead(status, headers = {}) { this.status = status; this.headers = headers; this.headersSent = true; }
  write(chunk) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    this.chunks.push(data);
    this.writableLength += data.length;
    return true;
  }
  end(chunk) {
    if (chunk !== undefined) this.write(chunk);
    this.writableEnded = true;
  }
}

const frames = (ws, type) => ws.sent
  .filter((entry) => typeof entry.data === "string")
  .map((entry) => JSON.parse(entry.data))
  .filter((message) => !type || message.type === type);

const delay = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

test("heartbeat terminates an unresponsive websocket", async () => {
  const ws = new FakeWebSocket();
  const dispose = attachWebSocketHeartbeat(ws, 10);
  await delay(35);
  assert.equal(ws.terminated, true);
  dispose();
});

test("live websocket flow pauses at high water and closes unsafe overflow", async () => {
  const source = new FakeWebSocket();
  const target = new FakeWebSocket();
  const flow = { pendingBytes: 0 };
  target.bufferedAmount = TUNNEL_WS_HIGH_WATER_BYTES;
  let overflow = false;
  assert.equal(forwardWebSocketFrame(source, target, "safe", undefined, flow, true, () => { overflow = true; }), true);
  assert.equal(source.paused, true);
  assert.equal(overflow, false);
  target.bufferedAmount = 0;
  await delay(25);
  assert.equal(source.paused, false);

  target.bufferedAmount = TUNNEL_WS_HIGH_WATER_BYTES;
  assert.equal(forwardWebSocketFrame(source, target, "unsafe", undefined, flow, false, () => { overflow = true; }), false);
  assert.equal(overflow, true);

  target.bufferedAmount = 0;
  flow.pendingBytes = 0;
  overflow = false;
  for (let index = 0; index < 10_000; index++)
    assert.equal(forwardWebSocketFrame(source, target, "low-pressure", undefined, flow, true, () => { overflow = true; }), true);
  assert.equal(overflow, false, "historical low-pressure traffic triggered 1009");

  target.bufferedAmount = TUNNEL_WS_CHANNEL_MAX_BYTES;
  assert.equal(forwardWebSocketFrame(source, target, "overflow", undefined, flow, true, () => { overflow = true; }), false);
  assert.equal(overflow, true);
});

test("Hub assigns collision-safe names and preserves binary frames", () => {
  const hub = new TunnelHub();
  const first = new FakeWebSocket();
  const second = new FakeWebSocket();
  assert.equal(hub.handleAgentConnection(first, "mac", "instance-a"), "mac");
  assert.equal(hub.handleAgentConnection(second, "mac", "instance-b"), "mac-2");
  assert.deepEqual(hub.agentNames(), ["mac", "mac-2"]);

  const replacement = new FakeWebSocket();
  assert.equal(hub.handleAgentConnection(replacement, "renamed", "instance-a"), "mac");
  assert.equal(first.closeCode, 4009);
  assert.deepEqual(hub.agentNames().sort(), ["mac", "mac-2"]);

  const browser = new FakeWebSocket();
  assert.equal(hub.proxyWs("mac", browser, "/ws?cwd=/tmp"), true);
  const open = frames(replacement, "ws_open").at(-1);
  const binary = Buffer.from([0, 255, 1, 128]);
  browser.emit("message", binary, true);
  const outbound = frames(replacement, "ws_msg").at(-1);
  assert.equal(outbound.channel, open.channel);
  assert.equal(outbound.isBinary, true);
  assert.deepEqual(Buffer.from(outbound.data, "base64"), binary);

  replacement.emit("message", Buffer.from(JSON.stringify({
    type: "ws_msg",
    channel: open.channel,
    isBinary: true,
    data: binary.toString("base64"),
  })));
  const delivered = browser.sent.at(-1);
  assert.deepEqual(delivered.data, binary);
  assert.equal(delivered.options.binary, true);
  hub.dispose();
});

test("HTTP tunnel chunks, cancels and rejects declared oversize requests", () => {
  const hub = new TunnelHub();
  const agent = new FakeWebSocket();
  hub.handleAgentConnection(agent, "agent", "http-agent");

  const request = new FakeRequest({ "content-length": String(TUNNEL_CHUNK_BYTES * 2 + 7) });
  const response = new FakeResponse();
  assert.equal(hub.proxyHttp("agent", "POST", "/echo", { "content-type": "application/octet-stream" }, request, response, 1000), true);
  const payload = Buffer.alloc(TUNNEL_CHUNK_BYTES * 2 + 7, 7);
  request.emit("data", payload);
  request.emit("end");
  const start = frames(agent, "http_start").at(-1);
  const requestChunks = frames(agent, "http_chunk").filter((message) => message.id === start.id);
  assert.equal(requestChunks.length, 3);
  assert.ok(requestChunks.every((message) => Buffer.from(message.data, "base64").length <= TUNNEL_CHUNK_BYTES));

  agent.emit("message", Buffer.from(JSON.stringify({ type: "http_response", id: start.id, status: 201, headers: { "content-type": "text/plain" } })));
  agent.emit("message", Buffer.from(JSON.stringify({ type: "http_chunk", id: start.id, data: Buffer.from("chunked-ok").toString("base64") })));
  agent.emit("message", Buffer.from(JSON.stringify({ type: "http_end", id: start.id })));
  assert.equal(response.status, 201);
  assert.equal(Buffer.concat(response.chunks).toString(), "chunked-ok");
  assert.equal(response.writableEnded, true);

  const oversizedResponseRequest = new FakeRequest();
  const oversizedTunnelResponse = new FakeResponse();
  hub.proxyHttp("agent", "GET", "/large-response", {}, oversizedResponseRequest, oversizedTunnelResponse, 1000);
  oversizedResponseRequest.emit("end");
  const oversizedResponseStart = frames(agent, "http_start").at(-1);
  agent.emit("message", Buffer.from(JSON.stringify({
    type: "http_response",
    id: oversizedResponseStart.id,
    status: 200,
    headers: { "content-length": String(TUNNEL_MAX_HTTP_BYTES + 1) },
  })));
  assert.equal(oversizedTunnelResponse.status, 413);
  assert.equal(frames(agent, "http_cancel").at(-1).id, oversizedResponseStart.id);

  const cancelledRequest = new FakeRequest();
  const cancelledResponse = new FakeResponse();
  hub.proxyHttp("agent", "GET", "/slow", {}, cancelledRequest, cancelledResponse, 1000);
  const cancelStart = frames(agent, "http_start").at(-1);
  cancelledRequest.emit("aborted");
  assert.equal(frames(agent, "http_cancel").at(-1).id, cancelStart.id);

  const oversizedRequest = new FakeRequest({ "content-length": String(TUNNEL_MAX_HTTP_BYTES + 1) });
  const oversizedResponse = new FakeResponse();
  assert.equal(hub.proxyHttp("agent", "POST", "/import", {}, oversizedRequest, oversizedResponse), true);
  assert.equal(oversizedResponse.status, 413);
  hub.dispose();
});

test("Agent buffers CONNECTING websocket input and preserves binary", { timeout: 10_000 }, async () => {
  const localHttp = createServer();
  const localWss = new WebSocketServer({ noServer: true });
  localHttp.on("upgrade", (request, socket, head) => {
    setTimeout(() => localWss.handleUpgrade(request, socket, head, (ws) => localWss.emit("connection", ws)), 75);
  });
  localWss.on("connection", (ws) => ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary })));
  const localPort = await listen(localHttp);

  const hubHttp = createServer();
  const hubWss = new WebSocketServer({ noServer: true });
  hubHttp.on("upgrade", (request, socket, head) => hubWss.handleUpgrade(request, socket, head, (ws) => hubWss.emit("connection", ws)));
  const hubPort = await listen(hubHttp);
  const binary = Buffer.from([4, 0, 255, 9]);
  const received = new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("agent websocket echo timeout")), 5000);
    hubWss.once("connection", (ws) => {
      ws.send(JSON.stringify({ type: "ws_open", channel: "early", path: "/echo" }));
      ws.send(JSON.stringify({ type: "ws_msg", channel: "early", isBinary: true, data: binary.toString("base64") }));
      ws.on("message", (raw) => {
        const message = JSON.parse(String(raw));
        if (message.type !== "ws_msg" || message.channel !== "early") return;
        clearTimeout(timer);
        resolvePromise(message);
      });
    });
  });
  const handle = runTunnelAgent({
    hubUrl: `ws://127.0.0.1:${hubPort}`,
    localPort,
    name: "connect-test",
    instanceId: "connect-instance",
    reconnectDelayMs: 20,
  });
  try {
    const message = await received;
    assert.equal(message.isBinary, true);
    assert.deepEqual(Buffer.from(message.data, "base64"), binary);
  } finally {
    await handle.dispose();
    for (const ws of hubWss.clients) ws.terminate();
    for (const ws of localWss.clients) ws.terminate();
    await Promise.all([
      new Promise((resolvePromise) => hubHttp.close(resolvePromise)),
      new Promise((resolvePromise) => localHttp.close(resolvePromise)),
    ]);
  }
});

test("replaced agent stops reconnecting and SIGTERM exits cleanly", { timeout: 15_000 }, async () => {
  const hubHttp = createServer();
  const hubWss = new WebSocketServer({ noServer: true });
  let connections = 0;
  hubHttp.on("upgrade", (request, socket, head) => hubWss.handleUpgrade(request, socket, head, (ws) => hubWss.emit("connection", ws)));
  hubWss.on("connection", (ws) => {
    connections += 1;
    setTimeout(() => ws.close(4009, "replaced by same instance"), 10);
  });
  const hubPort = await listen(hubHttp);
  const handle = runTunnelAgent({ hubUrl: `ws://127.0.0.1:${hubPort}`, localPort: 1, instanceId: "replaced", reconnectDelayMs: 20 });
  await delay(150);
  assert.equal(connections, 1);
  await handle.dispose();
  await new Promise((resolvePromise) => hubHttp.close(resolvePromise));

  const temp = await mkdtemp(join(tmpdir(), "mewpii-shutdown-"));
  const home = join(temp, "home");
  const workspace = join(temp, "workspace");
  await Promise.all([mkdir(home), mkdir(workspace)]);
  const port = 39_000 + Math.floor(Math.random() * 500);
  const logs = [];
  const child = spawn(process.execPath, ["server/dist/index.js", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: root,
    env: { ...process.env, HOME: home, PII_PASSWORD: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break;
    } catch { /* starting */ }
    await delay(25);
  }
  child.kill("SIGTERM");
  const [code] = await once(child, "exit");
  assert.equal(code, 0, logs.join(""));
  assert.match(logs.join(""), /shutdown.*completed/);
  await rm(temp, { recursive: true, force: true });
});
