/** Shared badge prevents cards, list and inspector from disagreeing. @author coolonion */
import { t } from '../i18n';
import type { Presentation } from '../subagent-store';
import { subagentStatusView } from '../subagent-run-state';

export default function SubagentStatus({ presentation, unavailable = false }: { presentation?: Presentation; unavailable?: boolean }) {
  const view = subagentStatusView(presentation, unavailable);
  return <span className="subagent-status-group" title={view.reason ? t(view.reason) : undefined}>
    <span className={`subagent-status state-${view.state}`}>{t(view.label)}</span>
    {view.warning && <span className="subagent-flow-warning">{t(view.warning)}</span>}
  </span>;
}
