/** Stable sidebar metadata and session actions. @author coolonion */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SessionSummary } from '../types';
import { t } from '../i18n';
import { IconArchive, IconMore, IconPencil, IconTrash } from '../icons';

interface Props {
  session: SessionSummary;
  time: string;
  onRename: () => void;
  onArchive: () => void;
  onDelete: () => void;
}

export default function SessionActions({ session, time, onRename, onArchive, onDelete }: Props) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>();
  const close = (restoreFocus = false) => {
    setPosition(undefined);
    if (restoreFocus) trigger.current?.focus();
  };

  useEffect(() => {
    if (!position) return;
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !trigger.current?.contains(target))
        setPosition(undefined);
    };
    const onLayoutChange = () => setPosition(undefined);
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', onLayoutChange);
    window.addEventListener('scroll', onLayoutChange, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('resize', onLayoutChange);
      window.removeEventListener('scroll', onLayoutChange, true);
    };
  }, [position]);

  const act = (action: () => void) => {
    close(true);
    action();
  };

  return (
    <span className={`session-row-meta ${position ? 'menu-open' : ''}`}>
      <span className="time">{time}</span>
      <button
        ref={trigger}
        type="button"
        className="session-more"
        title={t('sessionActions')}
        aria-label={`${t('sessionActions')}: ${session.name || session.firstMessage}`}
        aria-haspopup="menu"
        aria-expanded={Boolean(position)}
        onClick={() => {
          if (position) return close();
          const rect = trigger.current!.getBoundingClientRect();
          setPosition({
            left: Math.max(8, Math.min(rect.right - 168, window.innerWidth - 176)),
            top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 132)),
          });
        }}
      >
        <IconMore size={16} />
      </button>
      {position && createPortal(
        <div
          ref={menu}
          className="menu session-action-menu"
          role="menu"
          aria-label={t('sessionActions')}
          style={position}
          onBlur={(event) => {
            if (event.relatedTarget !== trigger.current &&
                !event.currentTarget.contains(event.relatedTarget as Node | null)) close();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              close(true);
            }
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
              event.preventDefault();
              const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
              const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
                : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
              buttons[next]?.focus();
            }
          }}
        >
          <button type="button" role="menuitem" className="menu-item" disabled={session.running}
            title={session.running ? t('renameRunning') : undefined} onClick={() => act(onRename)}>
            <IconPencil size={14} />{t('rename')}
          </button>
          <button type="button" role="menuitem" className="menu-item" onClick={() => act(onArchive)}>
            <IconArchive size={14} />{t('archive')}
          </button>
          <button type="button" role="menuitem" className="menu-item session-delete-action" onClick={() => act(onDelete)}>
            <IconTrash size={14} />{t('deleteSession')}
          </button>
        </div>, document.body,
      )}
    </span>
  );
}
