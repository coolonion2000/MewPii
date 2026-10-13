/** Payload-free request timings for every provider. @author coolonion */
import type { AgentSession } from '@earendil-works/pi-coding-agent';

type StreamFn = AgentSession['agent']['streamFunction'];
type TimingFields = Record<string, string | number | boolean | null>;
const writeTiming = (event: string, fields: TimingFields) => console.info(
  `[model] ${event} ${Object.entries(fields).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(' ')}`,
);

export function wrapModelTiming(original: StreamFn, sessionId: () => string,
  write = writeTiming, now = () => performance.now()): StreamFn {
  let sequence = 0;
  return async (model, context, options) => {
    const startedAt = now();
    const identity = {session_id: sessionId(), request_seq: ++sequence, provider: model.provider, model: model.id};
    const elapsed = () => Math.max(0, Math.round((now() - startedAt) * 10) / 10);
    const log = (event: string, fields: TimingFields = {}) => {
      // Diagnostics must never break model consumption (including a closed log sink).
      try { write(event, {...identity, ...fields}); } catch { /* best effort */ }
    };
    log('request_started');
    let firstEventMs: number | null = null;
    let firstContentMs: number | null = null;
    let outcome = 'closed';
    try {
      const stream = await original(model, context, options);
      const iterate = stream[Symbol.asyncIterator].bind(stream);
      stream[Symbol.asyncIterator] = async function* () {
        try {
          for await (const event of {[Symbol.asyncIterator]: iterate}) {
            if (firstEventMs === null) firstEventMs = elapsed();
            // A provider's 'start' is metadata, not the first generated token.
            if (firstContentMs === null &&
                (event.type === 'text_delta' || event.type === 'thinking_delta' || event.type === 'toolcall_delta') &&
                typeof event.delta === 'string' && event.delta.length > 0) {
              firstContentMs = elapsed();
              log('first_content', {first_event_ms: firstEventMs, first_content_ms: firstContentMs, kind: event.type});
            }
            if (event.type === 'done') outcome = 'completed';
            else if (event.type === 'error') outcome = 'error';
            yield event;
          }
        } catch (error) {
          outcome = 'error';
          throw error;
        } finally {
          log('request_completed', {duration_ms: elapsed(), first_event_ms: firstEventMs,
            first_content_ms: firstContentMs, outcome});
        }
      };
      return stream;
    } catch (error) {
      log('request_completed', {duration_ms: elapsed(), first_event_ms: null, first_content_ms: null, outcome: 'setup_error'});
      throw error;
    }
  };
}

const installed = new WeakSet<AgentSession>();
export function installModelTiming(session: AgentSession): void {
  if (installed.has(session)) return;
  installed.add(session);
  session.agent.streamFunction = wrapModelTiming(session.agent.streamFunction, () => session.sessionId);
}
