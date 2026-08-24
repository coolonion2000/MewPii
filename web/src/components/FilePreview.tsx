import { useEffect, useState } from 'react';
import { IconX } from '../icons';
import { t } from '../i18n';

interface Props {
  cwd: string;
  path: string;
  onClose: () => void;
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp']);

/** Right-side file preview drawer (pi-web style). */
export default function FilePreview({ cwd, path, onClose }: Props) {
  const [content, setContent] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  const isImage = IMAGE_EXTS.has(ext);

  useEffect(() => {
    setLoading(true);
    setError(undefined);
    setContent(undefined);
    if (isImage) {
      setLoading(false);
      return;
    }
    fetch(`/api/file?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`)
      .then(async (r) => {
        const d = (await r.json()) as { content?: string; error?: string };
        if (d.content !== undefined) setContent(d.content);
        else setError(d.error ?? 'preview failed');
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [cwd, path, isImage]);

  return (
    <div className="file-preview-pane">
      <div className="fpp-header">
        <span className="fpp-path mono" title={path}>{path}</span>
        <button className="btn btn-icon" onClick={onClose}><IconX size={13} /></button>
      </div>
      <div className="fpp-body">
        {loading && <div className="dim" style={{ padding: 16 }}>…</div>}
        {error && <div className="msg-error">{error}</div>}
        {isImage && (
          <img
            src={`/api/file?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`}
            alt={path}
            style={{ maxWidth: '100%', borderRadius: 8 }}
          />
        )}
        {content !== undefined && (
          <pre className="tool-pre fpp-pre">
            {content.split('\n').map((line, i) => (
              <div key={i} className="fpp-line">
                <span className="fpp-lineno">{i + 1}</span>
                <span>{line || ' '}</span>
              </div>
            ))}
          </pre>
        )}
      </div>
    </div>
  );
}
