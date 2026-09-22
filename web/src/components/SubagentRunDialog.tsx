/** Read-only task inspector sharing the file-preview slot. @author coolonion */
import { useEffect, useRef, useState } from 'react';
import { IconX, IconBot } from '../icons';
import { t } from '../i18n';
import { useSubagents } from '../subagent-store';
import { subagentStateKey, subagentStatusView } from '../subagent-run-state';
import SubagentStatus from './SubagentStatus';

export default function SubagentRunDialog({ width }: { width: number }) {
  const { detail, selected, runs, close, selectStep, setUsage, error } = useSubagents();
  const [tab, setTab] = useState<'activity' | 'output'>('activity');
  const pane = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    pane.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  const projection = detail?.presentation ?? runs.find(run => run.id === selected)?.presentation;
  const state = error ? 'unknown' : projection?.effectiveState ?? 'unknown';
  const view = subagentStatusView(projection, error);
  const step = detail?.steps?.[detail.previewStep ?? 0];
  const messages = detail?.preview?.messages ?? [];
  const output = messages.filter(message => message.outputText);
  return <aside ref={pane} tabIndex={-1} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }} className="file-preview-pane subagent-detail-pane" style={{ width, maxWidth: '75vw' }} aria-label={t('subagentTask')}>
    <header className="subagent-detail-header"><IconBot size={16} /><span>{t('subagentTask')}</span><button className="btn btn-icon" onClick={close} aria-label={t('close')}><IconX size={16} /></button></header>
    <div className="subagent-detail-heading"><h3>{detail?.task || projection?.title || detail?.agent || t('subagentTask')}</h3>
      <div className="dim">{step?.agent || detail?.agent}{step?.model ? ` · ${step.model}` : ''}</div>
      <div className="subagent-detail-status"><SubagentStatus presentation={projection} unavailable={error} />
        {projection?.updatedAt && <time className="dim" title={new Date(projection.updatedAt).toLocaleString()}>{t('subagentLatestActivity')} {new Date(projection.updatedAt).toLocaleTimeString()}</time>}</div>
      {state === 'unknown' && <p className="dim">{t('subagentStateUnconfirmed')}</p>}
      {error && <p role="alert">{t('subagentLoadFailed')}</p>}
      {view.label === 'subagentOutcomeUnmet' && <p className="dim">{t('subagentOutcomeUnmetReason')}</p>}
    </div>
    {detail?.steps && detail.steps.length > 1 && <label className="subagent-step-select">{t('subagentStep')}
      <select value={detail.previewStep ?? 0} onChange={event => selectStep(Number(event.target.value))}>{detail.steps.map((item, i) => <option key={i} value={i}>{i + 1}. {item.key} · {t(!error && projection?.steps[i]?.outcome === 'reported-unmet' ? 'subagentOutcomeUnmet' : subagentStateKey(error ? 'unknown' : projection?.steps[i]?.effectiveState))}</option>)}</select>
    </label>}
    <div className="subagent-tabs" role="tablist" aria-label={t('subagentViewDetails')}>
      {(['activity', 'output'] as const).map(value => <button key={value} id={`subagent-tab-${value}`} role="tab" aria-selected={tab === value} aria-controls="subagent-tabpanel" onClick={() => setTab(value)}>{t(value === 'activity' ? 'subagentActivity' : 'output')}</button>)}
    </div>
    <div className="subagent-detail-scroll" role="tabpanel" id="subagent-tabpanel" aria-labelledby={`subagent-tab-${tab}`} tabIndex={0}>
      {!detail ? <p className="dim">{t(error ? 'subagentLoadFailed' : 'subagentLoading')}</p> : <>
        {view.reason && <section className="subagent-workflow-alert" role="status">
          {view.childrenCompleted && <strong>{t('subagentRecordedChildrenComplete', { completed: String(projection?.childSummary?.completed ?? 0), total: String(projection?.childSummary?.total ?? 0) })}</strong>}
          <p>{t(view.reason)}</p>
        </section>}
        {projection?.workflow?.error && <details className="subagent-error-record">
          <summary>{t('subagentWorkflowErrorRecord')}</summary>
          {projection.workflow.updatedAt && <time className="dim">{new Date(projection.workflow.updatedAt).toLocaleString()}</time>}
          <pre>{projection.workflow.error}</pre>
        </details>}
        {detail.preview?.truncated && <p className="dim">{t('subagentPreviewTruncated')}</p>}
        {tab === 'activity' ? [...messages].reverse().map((message) => <details className="subagent-activity" key={`${message.timestamp}:${message.role}:${message.text.slice(0, 80)}`}>
          <summary><span className="subagent-activity-dot" /><span><strong>{message.summary || (message.role === 'assistant' ? t('subagentAssistant') : message.role === 'toolResult' ? t('subagentToolResult') : message.role)}</strong><span className="subagent-activity-excerpt">{message.outputText || (message.summary && message.role === 'assistant' ? t('subagentRecordedCall') : message.text.slice(0, 200))}</span></span>{message.timestamp && <time>{new Date(message.timestamp).toLocaleTimeString()}</time>}</summary>
          <pre>{message.text}</pre>
        </details>) : output.map((message, i) => <div className="subagent-output" key={`${i}:${message.timestamp}`}><pre>{message.outputText}</pre></div>)}
        {!(tab === 'activity' ? messages : output).length && <p className="dim">{t(detail.preview?.unavailable ? 'subagentOutputUnavailable' : 'subagentNoLog')}</p>}
        {!messages.length && detail.log && <details className="subagent-runtime"><summary>{t('subagentRecordedCall')}</summary><pre>{detail.log}</pre></details>}
        <details className="subagent-runtime" onToggle={event => setUsage(event.currentTarget.open)}><summary>{t('subagentRuntime')}</summary><dl>
          <dt>{t('subagentHistoricalState')}</dt><dd>{t(subagentStateKey(detail.state))}{detail.lastUpdate ? ` · ${new Date(detail.lastUpdate).toLocaleString()}` : ''}</dd>
          <dt>Run ID</dt><dd>{detail.runId}</dd><dt>{t('subagentWorkspace')}</dt><dd>{detail.cwd}</dd>
          {step && <><dt>{t('subagentChild')}</dt><dd>{step.runId}<br />{step.sessionFile}</dd><dt>Tokens / Cost</dt><dd>{step.tokens?.toLocaleString() ?? '—'} / {step.cost === undefined ? '—' : `$${step.cost.toFixed(4)}`}</dd></>}
        </dl>{step?.error && <pre>{step.error}</pre>}<p className="dim">{t('subagentReadOnly')}</p></details>
      </>}
    </div>
  </aside>;
}
