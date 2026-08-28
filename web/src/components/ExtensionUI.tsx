import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
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
  useEffect(() => {
    // Input text belongs to one concrete extension request only.
    setInputDraft('');
  }, [req?.id]);

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

      {conv.customUi && <CustomTerminalDialog conv={conv} />}

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


function terminalKeyData(event: KeyboardEvent<HTMLTextAreaElement>): string | undefined {
  const { key } = event;
  const special: Record<string, string> = {
    Enter: event.shiftKey ? '\n' : '\r',
    Escape: '\u001b',
    Backspace: '\u007f',
    Delete: '\u001b[3~',
    Tab: '\t',
    ArrowUp: '\u001b[A',
    ArrowDown: '\u001b[B',
    ArrowRight: '\u001b[C',
    ArrowLeft: '\u001b[D',
    Home: '\u001b[H',
    End: '\u001b[F',
    PageUp: '\u001b[5~',
    PageDown: '\u001b[6~',
  };
  if (special[key]) return special[key];
  if (event.ctrlKey && key.length === 1) {
    const code = key.toLowerCase().charCodeAt(0);
    if (code >= 97 && code <= 122) return String.fromCharCode(code - 96);
  }
  if (event.altKey && !event.metaKey && key.length === 1) return `\u001b${key}`;
  return undefined;
}

function TerminalLine({ line }: { line: string }) {
  const clean = stripAnsi(line);
  const parts = clean.split(/(https?:\/\/[^\s]+)/g);
  return (
    <div className="custom-ui-line">
      {parts.map((part, index) => part.startsWith('http://') || part.startsWith('https://')
        ? <a key={`${index}-${part}`} href={part} target="_blank" rel="noreferrer">{part}</a>
        : <span key={index}>{part}</span>)}
    </div>
  );
}

function CustomTerminalDialog({ conv }: { conv: Conversation }) {
  const frame = conv.customUi;
  const captureRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    captureRef.current?.focus();
  }, [frame?.requestId]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !frame) return;
    const report = () => conv.customUiResize(Math.floor((body.clientWidth - 28) / 8));
    report();
    const observer = new ResizeObserver(report);
    observer.observe(body);
    return () => observer.disconnect();
  }, [conv, frame?.requestId]);

  if (!frame) return null;
  return (
    <div className={`modal-mask custom-ui-mask ${frame.overlay ? 'is-overlay' : ''}`} onClick={() => captureRef.current?.focus()}>
      <div className="custom-ui-modal" onClick={(event) => event.stopPropagation()}>
        <div className="custom-ui-head">
          <span className="mono">Extension UI</span>
          <span className="dim">↑↓ / Enter / Esc</span>
          <button className="btn btn-sm btn-icon" aria-label={t('close')} onClick={() => conv.cancelCustomUi()}>×</button>
        </div>
        <div ref={bodyRef} className="custom-ui-terminal" onClick={() => captureRef.current?.focus()}>
          {frame.lines.map((line, index) => <TerminalLine key={`${frame.revision}-${index}`} line={line} />)}
        </div>
        <textarea
          ref={captureRef}
          className="custom-ui-capture"
          value=""
          aria-label="Extension terminal input"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => {
            if (event.currentTarget.value) conv.customUiInput(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            const data = terminalKeyData(event);
            if (!data) return;
            event.preventDefault();
            conv.customUiInput(data);
          }}
        />
      </div>
    </div>
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
