import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import {
  checkedJsonResponse,
  oauthCloseSucceeded,
  oauthPollDelay,
} from '../ui-reliability';

interface FlowEvent {
  type: string;
  message?: string;
  url?: string;
  userCode?: string;
  verificationUri?: string;
  instructions?: string;
}

interface FlowStatus {
  events: FlowEvent[];
  pendingPrompt?: { message: string; placeholder?: string; inputType: string };
  done: boolean;
  error?: string;
}

interface Props {
  provider: string;
  providerName: string;
  onClose: (success: boolean) => void;
}

export default function OAuthDialog({ provider, providerName, onClose }: Props) {
  const [flowId, setFlowId] = useState<string>();
  const [status, setStatus] = useState<FlowStatus>({ events: [], done: false });
  const [answer, setAnswer] = useState('');
  const [starting, setStarting] = useState(true);
  const [answering, setAnswering] = useState(false);
  const [transportError, setTransportError] = useState<string>();
  const [startAttempt, setStartAttempt] = useState(0);
  const [pollAttempt, setPollAttempt] = useState(0);
  const closed = useRef(false);
  const succeeded = useRef(false);
  const flowIdRef = useRef<string | undefined>(undefined);
  const flowSecretRef = useRef<string | undefined>(undefined);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const cancelFlow = useCallback((
    id = flowIdRef.current,
    secret = flowSecretRef.current,
  ) => {
    if (!id || !secret) return;
    void fetch('/api/auth/oauth/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, secret }),
      keepalive: true,
    }).catch(() => undefined);
    flowIdRef.current = undefined;
    flowSecretRef.current = undefined;
  }, []);

  const close = useCallback((success: boolean) => {
    if (closed.current) return;
    closed.current = true;
    if (!success) cancelFlow();
    onCloseRef.current(success);
  }, [cancelFlow]);

  useEffect(() => {
    closed.current = false;
    succeeded.current = false;
    setStarting(true);
    setTransportError(undefined);
    setStatus({ events: [], done: false });
    setFlowId(undefined);
    flowIdRef.current = undefined;
    flowSecretRef.current = undefined;
    const controller = new AbortController();
    void fetch('/api/auth/oauth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider }),
      signal: controller.signal,
    })
      .then((response) => checkedJsonResponse<{ id?: string; secret?: string; error?: string }>(response, 'oauth start'))
      .then((body) => {
        if (controller.signal.aborted || closed.current) {
          if (body.id && body.secret) cancelFlow(body.id, body.secret);
          return;
        }
        if (!body.id || !body.secret)
          throw new Error(body.error ?? 'failed to start');
        flowIdRef.current = body.id;
        flowSecretRef.current = body.secret;
        setFlowId(body.id);
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setTransportError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setStarting(false);
      });
    return () => {
      controller.abort();
      if (!succeeded.current) cancelFlow();
    };
  }, [cancelFlow, provider, startAttempt]);

  useEffect(() => {
    if (!flowId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let failures = 0;
    let successTimer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (stopped || closed.current) return;
      const secret = flowSecretRef.current;
      if (!secret) return;
      try {
        const response = await fetch('/api/auth/oauth/status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: flowId, secret }),
        });
        const next = await checkedJsonResponse<FlowStatus>(response, 'oauth status');
        if (stopped || closed.current) return;
        failures = 0;
        setTransportError(undefined);
        setStatus(next);
        if (next.done) {
          if (!next.error) {
            succeeded.current = true;
            successTimer = setTimeout(() => close(true), 800);
          }
          return;
        }
      } catch (cause) {
        if (stopped || closed.current) return;
        failures += 1;
        setTransportError(cause instanceof Error ? cause.message : String(cause));
      }
      const delay = oauthPollDelay(failures);
      timer = setTimeout(() => void poll(), delay);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(successTimer);
    };
  }, [close, flowId, pollAttempt]);

  const submitAnswer = async () => {
    if (!flowId || !answer.trim() || answering) return;
    setAnswering(true);
    setTransportError(undefined);
    try {
      const response = await fetch('/api/auth/oauth/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: flowId,
          secret: flowSecretRef.current,
          value: answer.trim(),
        }),
      });
      await checkedJsonResponse<{ ok?: boolean; error?: string }>(response, 'oauth answer');
      setAnswer('');
      setPollAttempt((value) => value + 1);
    } catch (cause) {
      setTransportError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAnswering(false);
    }
  };

  const retry = () => {
    setTransportError(undefined);
    if (!flowId || status.done) setStartAttempt((value) => value + 1);
    else setPollAttempt((value) => value + 1);
  };

  const closeFromUi = () => close(oauthCloseSucceeded(succeeded.current, status));

  return (
    <div className="modal-mask" onClick={closeFromUi}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <h3>{t('loginTitle')} · {providerName}</h3>

        {starting && (
          <div className="model-load-state" role="status">
            <span className="working-dot" aria-hidden="true" /> {t('oauthWaiting')}
          </div>
        )}

        {status.events.map((event, index) => {
          if (event.type === 'auth_url') {
            return (
              <div key={index} className="oauth-event">
                <div>{event.instructions ?? t('oauthWaiting')}</div>
                <a href={event.url} target="_blank" rel="noreferrer">{event.url}</a>
              </div>
            );
          }
          if (event.type === 'device_code') {
            return (
              <div key={index} className="oauth-event">
                <div>
                  {t('oauthOpenUrl')}: {' '}
                  <a href={event.verificationUri} target="_blank" rel="noreferrer">
                    {event.verificationUri}
                  </a>
                </div>
                <div className="oauth-code">{event.userCode}</div>
              </div>
            );
          }
          return <div key={index} className="oauth-event">{event.message}</div>;
        })}

        {status.pendingPrompt && (
          <div className="oauth-answer-row">
            <input
              autoFocus
              value={answer}
              disabled={answering}
              placeholder={status.pendingPrompt.placeholder ?? t('oauthEnterCode')}
              onChange={(event) => setAnswer(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && void submitAnswer()}
            />
            <button className="btn btn-sm" disabled={answering || !answer.trim()} onClick={() => void submitAnswer()}>
              {answering ? t('oauthWaiting') : t('submit')}
            </button>
          </div>
        )}

        {transportError && (
          <div className="model-load-error" role="alert">
            <span>{transportError}</span>
            <button className="btn btn-sm" onClick={retry}>{t('retry')}</button>
          </div>
        )}

        {status.done && (
          <div className={`oauth-event ${status.error ? 'is-error' : 'is-success'}`}>
            {status.error ?? t('loginSuccess')}
            {status.error && <button className="btn btn-sm" onClick={retry}>{t('retry')}</button>}
          </div>
        )}

        <div className="oauth-actions">
          <button className="btn btn-sm" onClick={closeFromUi}>{t('close')}</button>
        </div>
      </div>
    </div>
  );
}
