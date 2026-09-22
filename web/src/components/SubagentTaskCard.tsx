/** Compact task entry backed by the shared live projection. @author coolonion */
import { useState } from 'react';
import { IconBot, IconChevronRight } from '../icons';
import { t } from '../i18n';
import SubagentStatus from './SubagentStatus';
import { useSubagents } from '../subagent-store';
import type { ToolCallBlock } from './ToolCard';

export default function SubagentTaskCard({ call, output }: { call: ToolCallBlock; output: string }) {
  const store = useSubagents();
  const [expanded, setExpanded] = useState(false);
  const args = call.arguments;
  const run = store.runs.find(run => (call.id && run.presentation.toolCallId === call.id) ||
    (typeof args?.id === 'string' && (run.id === args.id || run.presentation.steps.some(step => step.runId === args.id))));
  const title = typeof args?.task === 'string' ? args.task : run?.presentation.title || t('subagentTask');
  const latest = run?.presentation.steps.find(step => step.currentTool)?.currentTool;
  return <div className="subagent-task-card">
    <button className="subagent-task-button" onClick={() => run ? store.open(run.id) : setExpanded(value => !value)} aria-expanded={run ? store.selected === run.id : expanded}>
      <span className="subagent-task-icon"><IconBot size={16} /></span>
      <span className="subagent-task-copy"><span className="subagent-task-eyebrow">{t('subagentTask')}{typeof args?.agent === 'string' ? ` · ${args.agent}` : ''}</span><strong>{title}</strong>
        <span className="dim">{latest ? `${t('subagentRecordedTool')}: ${latest}` : t(run ? 'subagentViewDetails' : 'subagentRecordedCall')}</span></span>
      <SubagentStatus presentation={run?.presentation} unavailable={store.error} /><IconChevronRight size={12} />
    </button>
    {!run && expanded && <pre className="subagent-raw-output">{output || JSON.stringify(args, null, 2)}</pre>}
  </div>;
}
