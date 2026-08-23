import { useState } from 'react';
import type { Conversation } from '../api';
import { stripAnsi } from '../api';
import { t } from '../i18n';

/** Inline question/questionnaire panel, docked above the composer (dsh-style). */
export function InlineQuestions({ conv }: { conv: Conversation }) {
  const req = conv.uiRequest;
  if (!req) return null;
  if (req.kind === 'question') return <QuestionDialog req={req} conv={conv} />;
  if (req.kind === 'questionnaire') return <QuestionnaireDialog req={req} conv={conv} />;
  return null;
}

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

      {/* extension dialogs (question/questionnaire render inline above the composer) */}
      {req && req.kind !== 'question' && req.kind !== 'questionnaire' && (
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


interface DialogProps {
  req: import('../types').UiRequest;
  conv: Conversation;
}

function QuestionDialog({ req, conv }: DialogProps) {
  const [custom, setCustom] = useState('');
  const options = req.payload?.options ?? [];
  return (
    <div className="ask-panel">
      <div className="ask-panel-body">
        <h3>{req.payload?.question ?? req.title}</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
          {options.map((opt, i) => (
            <button
              key={opt.label}
              className="menu-item"
              onClick={() => conv.answerUi({ answer: opt.label, wasCustom: false, index: i + 1 })}
            >
              <span>{opt.label}</span>
              {opt.description && <span className="dim">{opt.description}</span>}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <input
            autoFocus
            value={custom}
            placeholder={t('customAnswer')}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && custom.trim()) conv.answerUi({ answer: custom.trim(), wasCustom: true });
            }}
            style={{
              flex: 1, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
              padding: '7px 10px', fontSize: 13, fontFamily: 'inherit',
              background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', outline: 'none',
            }}
          />
          <button className="btn btn-sm" onClick={() => custom.trim() && conv.answerUi({ answer: custom.trim(), wasCustom: true })}>
            {t('submit')}
          </button>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
          <button className="btn btn-sm" onClick={() => conv.answerUi(null)}>{t('cancel')}</button>
        </div>
      </div>
    </div>
  );
}

function QuestionnaireDialog({ req, conv }: DialogProps) {
  const questions = req.payload?.questions ?? [];
  const [answers, setAnswers] = useState<Record<number, { label: string; wasCustom: boolean; index?: number }>>({});
  const [customs, setCustoms] = useState<Record<number, string>>({});
  const done = questions.every((_, i) => answers[i]);
  return (
    <div className="ask-panel">
      <div className="ask-panel-body">
        {questions.map((q, qi) => (
          <div key={qi} style={{ marginBottom: 14 }}>
            <h3 style={{ marginBottom: 6 }}>
              <span className="dim" style={{ marginRight: 8, fontSize: 12 }}>{q.label}</span>
              {q.prompt}
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {q.options.map((opt, oi) => (
                <button
                  key={opt.label}
                  className={`menu-item ${answers[qi]?.label === opt.label ? 'active' : ''}`}
                  onClick={() => setAnswers((prev) => ({ ...prev, [qi]: { label: opt.label, wasCustom: false, index: oi + 1 } }))}
                >
                  <span>{opt.label}</span>
                  {opt.description && <span className="dim">{opt.description}</span>}
                </button>
              ))}
            </div>
            {q.allowOther && (
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <input
                  value={customs[qi] ?? ''}
                  placeholder={t('customAnswer')}
                  onChange={(e) => {
                    const v = e.target.value;
                    setCustoms((prev) => ({ ...prev, [qi]: v }));
                    if (v.trim()) setAnswers((prev) => ({ ...prev, [qi]: { label: v.trim(), wasCustom: true } }));
                    else setAnswers((prev) => { const n = { ...prev }; delete n[qi]; return n; });
                  }}
                  style={{
                    flex: 1, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
                    padding: '6px 10px', fontSize: 12.5, fontFamily: 'inherit',
                    background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', outline: 'none',
                  }}
                />
              </div>
            )}
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-sm" onClick={() => conv.answerUi(null)}>{t('cancel')}</button>
          <button
            className="btn btn-sm btn-primary"
            style={{ width: 'auto', opacity: done ? 1 : 0.4 }}
            onClick={() => {
              if (!done) return;
              conv.answerUi({
                questions,
                answers: questions.map((q, i) => ({
                  id: q.label,
                  value: answers[i].label,
                  label: answers[i].label,
                  wasCustom: answers[i].wasCustom,
                  index: answers[i].index,
                })),
                cancelled: false,
              });
            }}
          >
            {t('submit')}
          </button>
        </div>
      </div>
    </div>
  );
}
