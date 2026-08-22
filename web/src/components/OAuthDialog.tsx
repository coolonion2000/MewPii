import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';

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
  const closed = useRef(false);

  useEffect(() => {
    fetch('/api/auth/oauth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider }),
    })
      .then((r) => r.json())
      .then((d: { id?: string; error?: string }) => {
        if (d.id) setFlowId(d.id);
        else setStatus((s) => ({ ...s, done: true, error: d.error ?? 'failed to start' }));
      })
      .catch((e) => setStatus((s) => ({ ...s, done: true, error: String(e) })));
    return () => {
      closed.current = true;
    };
  }, [provider]);

  useEffect(() => {
    if (!flowId) return;
    const timer = setInterval(async () => {
      if (closed.current) return;
      const res = await fetch(`/api/auth/oauth/status?id=${flowId}`).catch(() => undefined);
      if (!res?.ok) return;
      const s = (await res.json()) as FlowStatus;
      setStatus(s);
      if (s.done) {
        clearInterval(timer);
        if (!s.error) setTimeout(() => onClose(true), 1200);
      }
    }, 800);
    return () => clearInterval(timer);
  }, [flowId, onClose]);

  const submitAnswer = async () => {
    if (!flowId || !answer.trim()) return;
    await fetch('/api/auth/oauth/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: flowId, value: answer.trim() }),
    }).catch(() => undefined);
    setAnswer('');
  };

  return (
    <div className="modal-mask" onClick={() => onClose(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{t('loginTitle')} · {providerName}</h3>

        {status.events.map((ev, i) => {
          if (ev.type === 'auth_url') {
            return (
              <div key={i} className="oauth-event">
                <div>{ev.instructions ?? t('oauthWaiting')}</div>
                <a href={ev.url} target="_blank" rel="noreferrer">{ev.url}</a>
              </div>
            );
          }
          if (ev.type === 'device_code') {
            return (
              <div key={i} className="oauth-event">
                <div>{t('oauthOpenUrl')}: <a href={ev.verificationUri} target="_blank" rel="noreferrer">{ev.verificationUri}</a></div>
                <div className="oauth-code">{ev.userCode}</div>
              </div>
            );
          }
          return <div key={i} className="oauth-event">{ev.message}</div>;
        })}

        {status.pendingPrompt && (
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <input
              autoFocus
              value={answer}
              placeholder={status.pendingPrompt.placeholder ?? t('oauthEnterCode')}
              onChange={(e) => setAnswer(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void submitAnswer()}
              style={{
                flex: 1, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
                padding: '7px 10px', fontSize: 13, fontFamily: 'inherit',
                background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', outline: 'none',
              }}
            />
            <button className="btn btn-sm" onClick={() => void submitAnswer()}>{t('submit')}</button>
          </div>
        )}

        {status.done && (
          <div className="oauth-event" style={{ color: status.error ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)' }}>
            {status.error ?? t('loginSuccess')}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
          <button className="btn btn-sm" onClick={() => onClose(false)}>{t('close')}</button>
        </div>
      </div>
    </div>
  );
}
