import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconX } from '../icons';
import { t } from '../i18n';

export default function ImagePreview({ src, onClose }: { src: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [zoom, setZoom] = useState(1);
  const [natural, setNatural] = useState({ width: 320, height: 240 });
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      previous?.focus();
    };
  }, []);
  const fit = Math.min(1, (viewport.width - 40) / natural.width, (viewport.height - 140) / natural.height);
  const width = Math.max(1, natural.width * fit * zoom);
  const height = Math.max(1, natural.height * fit * zoom);
  return createPortal(
    <dialog ref={dialog} className="lightbox" aria-label={t('imagePreview')}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="lightbox-frame">
        <div className="lightbox-viewport" style={{ width, height }}>
          <img src={src} alt={t('imagePreview')} draggable={false} style={{ width, height }}
            onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />
        </div>
        <button type="button" className="lightbox-close" aria-label={t('close')} onClick={onClose}><IconX size={18} /></button>
        <div className="lightbox-controls">
          <button type="button" aria-label={t('zoomOut')} disabled={zoom <= 0.25} onClick={() => setZoom(z => Math.max(0.25, z / 1.25))}>−</button>
          <button type="button" title={t('resetZoom')} aria-label={t('resetZoom')} onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
          <button type="button" aria-label={t('zoomIn')} disabled={zoom >= 5} onClick={() => setZoom(z => Math.min(5, z * 1.25))}>+</button>
        </div>
      </div>
    </dialog>, document.body,
  );
}
