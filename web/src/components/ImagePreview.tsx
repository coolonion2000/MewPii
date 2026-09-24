import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconX } from '../icons';
import { t } from '../i18n';
import { clampImageZoom, imageFit } from '../image-preview-utils';

export default function ImagePreview(props: { src: string; onClose: () => void }) {
  return <Preview key={props.src} {...props} />;
}

function Preview({ src, onClose }: { src: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const anchor = useRef<{ x: number; y: number; clientX: number; clientY: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [natural, setNatural] = useState({ width: 320, height: 240 });
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const fit = imageFit(natural.width, natural.height, viewport.width, viewport.height);
  const zoomRef = useRef(zoom);
  const scale = fit * zoom;
  const width = natural.width * scale;
  const height = natural.height * scale;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', resize);
    return () => { window.removeEventListener('resize', resize); previous?.focus(); };
  }, []);
  const changeZoom = useCallback((next: number, clientX?: number, clientY?: number) => {
    const node = scroller.current;
    if (!node || status !== 'ready') return;
    const rect = node.getBoundingClientRect();
    const cx = clientX ?? rect.left + rect.width / 2;
    const cy = clientY ?? rect.top + rect.height / 2;
    const oldScale = fit * zoomRef.current;
    anchor.current = { x: (node.scrollLeft + cx - rect.left) / oldScale, y: (node.scrollTop + cy - rect.top) / oldScale, clientX: cx, clientY: cy };
    zoomRef.current = clampImageZoom(next, fit);
    setZoom(zoomRef.current);
  }, [fit, status]);
  useLayoutEffect(() => {
    const node = scroller.current;
    const point = anchor.current;
    if (node && point) {
      const rect = node.getBoundingClientRect();
      node.scrollLeft = point.x * scale - (point.clientX - rect.left);
      node.scrollTop = point.y * scale - (point.clientY - rect.top);
      anchor.current = null;
    }
  }, [scale]);
  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      changeZoom(zoomRef.current * Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * .005), event.clientX, event.clientY);
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  }, [changeZoom]);
  return createPortal(
    <dialog ref={dialog} className="lightbox" aria-label={t('imagePreview')}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="lightbox-frame">
        <div ref={scroller} className="lightbox-viewport" style={{ width, height }}
          onDoubleClick={() => changeZoom(zoomRef.current === 1 ? 1 / fit : 1)}
          onPointerDown={(event) => {
            if (event.button !== 0 || status !== 'ready') return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
          }}
          onPointerMove={(event) => {
            const points = pointers.current;
            const previous = points.get(event.pointerId);
            if (!previous) return;
            const other = [...points.entries()].find(([id]) => id !== event.pointerId)?.[1];
            points.set(event.pointerId, { x: event.clientX, y: event.clientY });
            if (other) {
              const before = Math.hypot(previous.x - other.x, previous.y - other.y);
              const after = Math.hypot(event.clientX - other.x, event.clientY - other.y);
              if (before > 0) changeZoom(zoomRef.current * after / before, (event.clientX + other.x) / 2, (event.clientY + other.y) / 2);
            } else {
              event.currentTarget.scrollLeft -= event.clientX - previous.x;
              event.currentTarget.scrollTop -= event.clientY - previous.y;
            }
          }}
          onPointerUp={(event) => pointers.current.delete(event.pointerId)}
          onPointerCancel={(event) => pointers.current.delete(event.pointerId)}
          onLostPointerCapture={(event) => pointers.current.delete(event.pointerId)}>
          {status !== 'error' && <img key={attempt} src={src} alt={t('imagePreview')} draggable={false} style={{ width, height }}
            onLoad={(event) => { setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }); setStatus('ready'); }}
            onError={() => setStatus('error')} />}
          {status !== 'ready' && <div className="lightbox-status" role="status">
            {status === 'error' ? <>{t('imageLoadFailed')}<button type="button" onClick={() => { setStatus('loading'); setAttempt(n => n + 1); }}>{t('retry')}</button></> : t('imageLoading')}
          </div>}
        </div>
        <button type="button" className="lightbox-close" aria-label={t('close')} onClick={onClose}><IconX size={18} /></button>
        <div className="lightbox-controls">
          <button type="button" aria-label={t('zoomOut')} disabled={status !== 'ready' || zoom <= .25} onClick={() => changeZoom(zoomRef.current / 1.25)}>−</button>
          <span className="lightbox-scale" aria-live="polite">{Math.round(scale * 100)}%</span>
          <button type="button" aria-label={t('zoomIn')} disabled={status !== 'ready' || zoom >= Math.max(5, 1 / fit)} onClick={() => changeZoom(zoomRef.current * 1.25)}>+</button>
          <button type="button" disabled={status !== 'ready'} onClick={() => changeZoom(1)}>{t('fitImage')}</button>
          <button type="button" disabled={status !== 'ready'} onClick={() => changeZoom(1 / fit)}>{t('originalImage')}</button>
        </div>
      </div>
    </dialog>, document.body,
  );
}
