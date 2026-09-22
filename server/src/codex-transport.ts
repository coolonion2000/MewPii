/** Scoped recovery for the hosted Pi Codex transport; no credential or dependency edits. @author coolonion */
import { findPackageJSON } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { ProviderRequestState } from './protocol.js';

type StreamFn = AgentSession['agent']['streamFunction'];
type Hooks = {
  stats(id: string): { websocketFallbackActive?: boolean } | undefined;
  reset(id: string): void;
  close(id: string): void;
};
const aiPackage = findPackageJSON('@earendil-works/pi-ai', import.meta.resolve('@earendil-works/pi-coding-agent'));
if (!aiPackage) throw new Error('Cannot resolve hosted Pi transport');
const provider = await import(new URL('./dist/api/openai-codex-responses.js', pathToFileURL(aiPackage)).href);
const defaultHooks: Hooks = {
  stats: provider.getOpenAICodexWebSocketDebugStats,
  reset: provider.resetOpenAICodexWebSocketDebugStats,
  close: provider.closeOpenAICodexWebSocketSessions,
};

export const CODEX_HEADERS_TIMEOUT_MS = 60_000;
export const CODEX_REPROBE_MS = 60_000;

// Abort only until headers arrive; cancelling this timer must not abort the response body.
export async function fetchWithHeaderDeadline(fetcher: typeof fetch, input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1], timeoutMs: number): Promise<Response> {
  const deadline = new AbortController();
  const signal = init?.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal;
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  try {
    return await fetcher(input, { ...init, signal });
  } catch (error) {
    if (deadline.signal.aborted && !init?.signal?.aborted)
      throw new Error(`Codex SSE response headers timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function wrapCodexStream(original: StreamFn,
  notify: (state: ProviderRequestState | undefined) => void,
  hooks: Hooks = defaultHooks,
  policy = { headersMs: CODEX_HEADERS_TIMEOUT_MS, reprobeMs: CODEX_REPROBE_MS, now: Date.now },
): StreamFn {
  const fallbackSince = new Map<string, number>();
  return async (model, context, options) => {
    if (model.provider !== 'openai-codex') return original(model, context, options);
    const startedAt = policy.now();
    const id = options?.sessionId;
    let transport: ProviderRequestState['transport'] = options?.transport === 'websocket-cached'
      ? 'websocket' : options?.transport ?? 'auto';
    const publish = (phase: ProviderRequestState['phase']) => notify({ phase, transport, startedAt, since: policy.now() });
    // Reprobe only between requests and only this session. Healthy sockets keep their continuation cache.
    if (id && transport !== 'sse' && hooks.stats(id)?.websocketFallbackActive) {
      const since = fallbackSince.get(id) ?? startedAt;
      fallbackSince.set(id, since);
      if (startedAt - since >= policy.reprobeMs) {
        hooks.close(id);
        hooks.reset(id);
        fallbackSince.delete(id);
        console.info(`[mewpii] codex_transport_reprobe session_id=${id} reason=fallback_cooldown`);
      }
    }
    publish('preparing');
    const fetcher = options?.fetch ?? globalThis.fetch;
    try {
      const stream = await original(model, context, {
        ...options,
        // Retry is owned by AgentSession, not nested provider loops.
        maxRetries: 0,
        websocketConnectTimeoutMs: Math.min(options?.websocketConnectTimeoutMs || 15_000, 10_000),
        onPayload: async (payload, requestModel) => {
          const result = await options?.onPayload?.(payload, requestModel);
          publish('connecting');
          return result;
        },
        fetch: async (input, init) => {
          transport = 'sse';
          if (id && options?.transport !== 'sse' && !fallbackSince.has(id)) fallbackSince.set(id, policy.now());
          publish('waiting_headers');
          console.info(`[mewpii] codex_request_wait session_id=${id ?? 'none'} transport=sse elapsed_ms=${policy.now() - startedAt}`);
          const response = await fetchWithHeaderDeadline(fetcher, input, init,
            Math.min(options?.timeoutMs || policy.headersMs, policy.headersMs));
          return response;
        },
        onResponse: async (response, requestModel) => {
          await options?.onResponse?.(response, requestModel);
          // HTTP error responses are not model activity.
          if (response.status >= 200 && response.status < 300) publish('streaming');
        },
      });
      const iterate = stream[Symbol.asyncIterator].bind(stream);
      stream[Symbol.asyncIterator] = async function* () {
        let received = false;
        try {
          for await (const event of { [Symbol.asyncIterator]: iterate }) {
            if (event.type !== 'error' && !received) {
              received = true;
              if (transport === 'auto') transport = 'websocket';
              publish('streaming');
              console.info(`[mewpii] codex_response_started session_id=${id ?? 'none'} transport=${transport} elapsed_ms=${policy.now() - startedAt}`);
            }
            if (event.type === 'error') {
              publish('failed');
              console.info(`[mewpii] codex_request_ended session_id=${id ?? 'none'} transport=${transport} outcome=${event.error.stopReason} elapsed_ms=${policy.now() - startedAt}`);
            }
            yield event;
          }
        } finally {
          if (id && hooks.stats(id)?.websocketFallbackActive && !fallbackSince.has(id)) fallbackSince.set(id, policy.now());
          notify(undefined);
        }
      };
      return stream;
    } catch (error) {
      notify(undefined);
      throw error;
    }
  };
}

const installed = new WeakSet<AgentSession>();
export function installCodexTransport(session: AgentSession, notify: (state: ProviderRequestState | undefined) => void) {
  if (installed.has(session)) return;
  installed.add(session);
  const settings = session.settingsManager;
  const original = session.agent.streamFunction;
  const wrapped = wrapCodexStream(original, notify);
  session.agent.streamFunction = (model, context, options) => model.provider !== 'openai-codex'
    ? original(model, context, options)
    : wrapped(model, context, { ...options,
      websocketConnectTimeoutMs: options?.websocketConnectTimeoutMs ?? settings.getWebSocketConnectTimeoutMs() });
  const retrySettings = settings.getRetrySettings.bind(settings);
  // Two attempts, at most 60s waiting for HTTP headers each; never persist or change other providers.
  settings.getRetrySettings = () => {
    const retry = retrySettings();
    return session.model?.provider === 'openai-codex' ? { ...retry, maxRetries: Math.min(retry.maxRetries, 1) } : retry;
  };
}
