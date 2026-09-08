/** Shared file actions for navigator rows and preview headers. @author coolonion */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconMore, IconDownload } from '../icons';
import { t } from '../i18n';

export default function FileActions({ name, download, onCopy, onReference }: {
  name: string; download?: string; onCopy: () => void; onReference?: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>();
  const close = () => setPosition(undefined);
  useEffect(() => {
    if (!position) return;
    menu.current?.querySelector<HTMLElement>('button, a')?.focus({ preventScroll: true });
    const outside = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) close();
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [position]);
  return <>
    <button ref={trigger} className="file-more btn btn-icon" type="button" aria-label={`${t('fileActions')}: ${name}`}
      aria-haspopup="menu" aria-expanded={Boolean(position)} onClick={() => {
        if (position) return close();
        const rect = trigger.current!.getBoundingClientRect();
        setPosition({ left: Math.max(8, Math.min(rect.right - 196, window.innerWidth - 204)), top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 126)) });
      }}><IconMore size={16} /></button>
    {position && createPortal(<div className="menu file-action-menu" ref={menu} role="menu" aria-label={t('fileActions')} style={position}
      onBlur={e => { if (e.relatedTarget !== trigger.current && !e.currentTarget.contains(e.relatedTarget as Node)) close(); }}
      onKeyDown={e => {
        if (e.key === 'Escape') { e.preventDefault(); close(); trigger.current?.focus(); }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault(); const entries = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
          const index = entries.indexOf(document.activeElement as HTMLElement);
          entries[(index + (e.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length]?.focus();
        }
      }}>
      <button className="menu-item" role="menuitem" onClick={() => { onCopy(); close(); }}>{t('copyPath')}</button>
      {download && <a className="menu-item" role="menuitem" href={download} download onClick={close}><IconDownload size={14} />{t('downloadFile')}</a>}
      {onReference && <button className="menu-item" role="menuitem" onClick={() => { onReference(); close(); }}>{t('referenceFile')}</button>}
    </div>, document.body)}
  </>;
}
