/** Offline transport regressions; never send credentials or model requests. @author coolonion */
import test from 'node:test';
import assert from 'node:assert/strict';
import { findPackageJSON } from 'node:module';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { wrapCodexStream, fetchWithHeaderDeadline, installCodexTransport } from '../src/codex-transport.ts';

const base = pathToFileURL(findPackageJSON('@earendil-works/pi-ai', import.meta.resolve('@earendil-works/pi-coding-agent')));
const { createAssistantMessageEventStream } = await import(new URL('./dist/utils/event-stream.js', base));
const { stream: realStream, getOpenAICodexWebSocketDebugStats: stats,
  resetOpenAICodexWebSocketDebugStats: reset, closeOpenAICodexWebSocketSessions: close } = await import(new URL('./dist/api/openai-codex-responses.js', base));
const model = { id: 'gpt-6-astra', provider: 'openai-codex', api: 'openai-codex-responses',
  baseUrl: 'https://example.invalid', contextWindow: 100000, maxTokens: 1000, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const context = { messages: [{ role: 'user', content: 'isolated test', timestamp: 1 }] };
const token = 'e30.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic' } })).toString('base64') + '.fake';
async function drain(stream) { const events = []; for await (const event of await stream) events.push(event); return events; }

test('real installed provider: fallback cools down then reopens WS, without changing another session', async () => {
  const before = globalThis.WebSocket;
  let wsAttempts = 0, httpAttempts = 0, now = 100;
  globalThis.WebSocket = class extends EventTarget {
    constructor() { super(); wsAttempts++; queueMicrotask(() => this.dispatchEvent(new Event('error'))); }
    close() {}
  };
  const states = [];
  const wrapped = wrapCodexStream(realStream, s => states.push(s), { stats, reset, close },
    { headersMs: 100, reprobeMs: 60, now: () => now });
  const options = { apiKey: token, sessionId: 'offline-recovery', transport: 'auto',
    fetch: async () => { httpAttempts++; return new Response('{"error":{"message":"synthetic unavailable"}}', { status: 503 }); } };
  try {
    await drain(wrapped(model, context, { ...options, sessionId: 'offline-other' }));
    await drain(wrapped(model, context, options));
    assert.equal(wsAttempts, 2);
    now += 30;
    await drain(wrapped(model, context, options));
    assert.equal(wsAttempts, 2, 'no immediate reconnect loop');
    now += 31;
    await drain(wrapped(model, context, options));
    assert.equal(wsAttempts, 3, 'reprobes after cooldown');
    assert.equal(httpAttempts, 4);
    assert.equal(stats('offline-other').websocketFailures, 1);
    assert.equal(stats('offline-other').websocketFallbackActive, true);
    assert.ok(states.some(s => s?.phase === 'waiting_headers'));
    assert.equal(states.at(-1), undefined);
  } finally {
    globalThis.WebSocket = before;
    for (const id of ['offline-other', 'offline-recovery']) { close(id); reset(id); }
  }
});

test('deadline aborts header wait promptly; caller abort retains its reason', async () => {
  const pending = (_input, init) => new Promise((_, reject) => {
    if (init.signal.aborted) reject(init.signal.reason);
    else init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  });
  await assert.rejects(fetchWithHeaderDeadline(pending, 'https://example.invalid', {}, 15), /headers timed out after 15ms/);
  const controller = new AbortController();
  const result = fetchWithHeaderDeadline(pending, 'https://example.invalid', { signal: controller.signal }, 100);
  controller.abort(new Error('user stopped'));
  await assert.rejects(result, /user stopped/);
});

test('header deadline is removed once headers arrive; a long response body remains readable', async () => {
  let signal;
  const response = await fetchWithHeaderDeadline(async (_input, init) => {
    signal = init.signal;
    return new Response(new ReadableStream({ async start(c) { await delay(40); c.enqueue(new TextEncoder().encode('still streaming')); c.close(); } }));
  }, 'https://example.invalid', {}, 10);
  assert.equal(await response.text(), 'still streaming');
  assert.equal(signal.aborted, false);
});

test('healthy socket is not cleared; hooks and stream result are preserved', async () => {
  const states = [], calls = [];
  const output = { role: 'assistant', stopReason: 'stop' };
  const original = async (_model, _context, opts) => {
    calls.push(opts);
    assert.deepEqual(await opts.onPayload({ a: 1 }, model), { b: 2 });
    await opts.onResponse({ status: 200, headers: {} }, model);
    const s = createAssistantMessageEventStream();
    s.push({ type: 'start', partial: output });
    s.push({ type: 'done', reason: 'stop', message: output });
    s.end();
    return s;
  };
  let headerHooks = 0;
  const wrapped = wrapCodexStream(original, s => states.push(s), {
    stats: () => ({ websocketFallbackActive: false }), reset: () => assert.fail('healthy reset'), close: () => assert.fail('healthy close'),
  });
  const s = await wrapped(model, context, { sessionId: 'healthy', onPayload: () => ({ b: 2 }), onResponse: () => { headerHooks++; } });
  assert.equal((await drain(s)).length, 2);
  assert.equal(await s.result(), output);
  assert.equal(headerHooks, 1);
  assert.equal(calls[0].maxRetries, 0);
  assert.ok(states.some(s => s?.transport === 'websocket'));
  assert.equal(states.at(-1), undefined);
});

test('non-Codex stream is passed through untouched', async () => {
  const opts = { transport: 'sse', maxRetries: 4 };
  const original = (_m, _c, o) => { assert.equal(o, opts); return 'untouched'; };
  assert.equal(await wrapCodexStream(original, () => assert.fail('non-Codex status'))({ provider: 'other' }, context, opts), 'untouched');
});

test('explicit SSE does not probe sockets, and preparation errors clear status', async () => {
  const states = [];
  const wrapped = wrapCodexStream(async () => { throw new Error('local preparation failed'); }, s => states.push(s), {
    stats: () => assert.fail('SSE must not inspect WS cache'), reset: () => assert.fail('SSE reset'), close: () => assert.fail('SSE close'),
  });
  await assert.rejects(wrapped(model, context, { sessionId: 'explicit-sse', transport: 'sse' }), /preparation failed/);
  assert.equal(states[0].phase, 'preparing');
  assert.equal(states.at(-1), undefined);
});

test('outer retry limit is session-local, non-persisted and preserves disabled retries', () => {
  const settings = { getRetrySettings: () => ({ enabled: false, maxRetries: 3, baseDelayMs: 2000 }) };
  const session = { agent: { streamFunction() {} }, settingsManager: settings, model };
  installCodexTransport(session, () => {});
  assert.deepEqual(settings.getRetrySettings(), { enabled: false, maxRetries: 1, baseDelayMs: 2000 });
  session.model = { provider: 'other' };
  assert.equal(settings.getRetrySettings().maxRetries, 3);
  const installed = session.agent.streamFunction;
  installCodexTransport(session, () => {});
  assert.equal(session.agent.streamFunction, installed);
});
