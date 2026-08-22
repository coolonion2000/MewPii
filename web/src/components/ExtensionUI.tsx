import { useState } from 'react';
import type { Conversation } from '../api';
import { stripAnsi } from '../api';
import { t } from '../i18n';

/** Extension-provided UI: widget chips (bottom-right), toasts (top-right), dialogs (modal). */
export default function ExtensionUI({ conv }: { conv: Conversation }) {
  const [openWidgets, setOpenWidgets] = useState<Set<string>>(new Set());
  const [inputDraft, setInputDraft] = useState('');

  const toggle = (key: string) =>
    setOpenWidgets((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const req = conv.uiRequest;

  return (
    <>
      {/* toasts */}
      {conv.toasts.length > 0 && (
        <div className="toast-stack">
          {conv.toasts.map((toast) => (
            <div key={toast.id} className={`toast toast-${toast.level}`}>
              {toast.message}
            </div>
          ))}
        </div>
      )}

      {/* extension widgets, pi-web style bottom-right chips */}
      {conv.widgets.length > 0 && (
        <div className="widget-stack">
          {conv.widgets.map((w) => {
            const open = openWidgets.has(w.key);
            return (
              <div key={w.key} className={`widget ${open ? 'open' : ''}`}>
                <button className="widget-chip" onClick={() => toggle(w.key)}>
                  <span className="widget-arrow">{open ? '▼' : '▲'}</span>
                  <span className="mono">{w.key}</span>
                </button>
                {open && (
                  <pre className="widget-body mono">
                    {w.lines.map((l, i) => (
                      <div key={i}>{stripAnsi(l)}</div>
                    ))}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* extension dialogs */}
      {req && (
        <div className="modal-mask" onClick={() => conv.answerUi(undefined)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{req.title}</h3>
            {req.message && <div className="oauth-event">{req.message}</div>}

            {req.kind === 'confirm' && (
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
                <button className="btn btn-sm" onClick={() => conv.answerUi(false)}>{t('cancel')}</button>
                <button className="btn btn-sm btn-primary" style={{ width: 'auto' }} onClick={() => conv.answerUi(true)}>
                  {t('submit')}
                </button>
              </div>
            )}

            {req.kind === 'select' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
                {(req.options ?? []).map((opt) => (
                  <button key={opt} className="menu-item" onClick={() => conv.answerUi(opt)}>
                    {opt}
                  </button>
                ))}
                <button className="btn btn-sm" style={{ alignSelf: 'flex-end' }} onClick={() => conv.answerUi(undefined)}>
                  {t('cancel')}
                </button>
              </div>
            )}

            {req.kind === 'input' && (
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <input
                  autoFocus
                  value={inputDraft}
                  placeholder={req.placeholder}
                  onChange={(e) => setInputDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      conv.answerUi(inputDraft);
                      setInputDraft('');
                    }
                  }}
                  style={{
                    flex: 1, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
                    padding: '7px 10px', fontSize: 13, fontFamily: 'inherit',
                    background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', outline: 'none',
                  }}
                />
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    conv.answerUi(inputDraft);
                    setInputDraft('');
                  }}
                >
                  {t('submit')}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
