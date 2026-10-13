import { useState } from 'react';
import type { FileMention } from '../file-mentions';
import { t } from '../i18n';
import { IconX } from '../icons';
export default function FileMentionChips({ items, onRemove, onOpenFile, disabled }: {
  items: FileMention[]; onRemove?: (path: string) => void; onOpenFile?: (path: string) => void; disabled?: boolean;
}) {
  const [expanded, setExpanded] = useState<string>();
  if (!items.length) return null;
  return <div className="file-mention-chips">
    {items.map(item => <span className="file-mention-chip" key={item.path}>
      <button type="button" title={item.path} onClick={() => setExpanded(current => current === item.path ? undefined : item.path)}>
        {item.isDir ? '📁' : '📄'} {item.path.split('/').pop()}
      </button>
      {onRemove && <button type="button" disabled={disabled} aria-label={`${t('removeReference')}: ${item.path}`} onClick={() => onRemove(item.path)}><IconX size={13} /></button>}
    </span>)}
    {expanded && items.some(item => item.path === expanded) && <div className="file-mention-detail">
      <code>{expanded}</code>
      {onOpenFile && !items.find(item => item.path === expanded)?.isDir && <button type="button" onClick={() => onOpenFile(expanded)}>{t('previewReference')}</button>}
    </div>}
  </div>;
}
