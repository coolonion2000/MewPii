import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { IconX } from '../icons';
import { t } from '../i18n';
import { withAgent } from '../api';

interface Props {
  cwd: string;
  path: string;
  width: number;
  agent?: string;
  sessionId?: string;
  onClose: () => void;
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp']);
const MD_EXTS = new Set(['.md', '.markdown']);
const JSON_EXTS = new Set(['.json', '.jsonl', '.ipynb']);

function formatJson(raw: string, ext: string): string {
  try {
    if (ext === '.jsonl') {
      return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.stringify(JSON.parse(line), null, 2);
          } catch {
            return line;
          }
        })
        .join('\n');
    }
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** Right-side file preview drawer (pi-web style): markdown rendering, JSON formatting, raw toggle. */
export default function FilePreview({ cwd, path, width, agent, sessionId, onClose }: Props) {
  const requestGeneration = useRef(0);
  const [content, setContent] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [showRaw, setShowRaw] = useState(false);

  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  const isImage = IMAGE_EXTS.has(ext);
  const isMd = MD_EXTS.has(ext);
  const isJson = JSON_EXTS.has(ext);
  const hasRichView = isMd || isJson;
  const sessionQuery = sessionId
    ? `&sessionId=${encodeURIComponent(sessionId)}`
    : '';
  const fileUrl = withAgent(
    `/api/file?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}${sessionQuery}`,
    agent,
  );

  useEffect(() => {
    const generation = ++requestGeneration.current;
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    setContent(undefined);
    setShowRaw(false);
    if (isImage) {
      setLoading(false);
      return () => controller.abort();
    }
    void fetch(fileUrl, { signal: controller.signal })
      .then(async (r) => {
        const d = (await r.json()) as { content?: string; error?: string };
        if (controller.signal.aborted || generation !== requestGeneration.current) return;
        if (d.content !== undefined) setContent(d.content);
        else setError(d.error ?? 'preview failed');
      })
      .catch((cause) => {
        if (!controller.signal.aborted && generation === requestGeneration.current) setError(String(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted && generation === requestGeneration.current) setLoading(false);
      });
    return () => controller.abort();
  }, [fileUrl, isImage]);

  const fileName = path.split('/').pop() ?? path;

  return (
    <div className="file-preview-pane" style={{ width, maxWidth: '75vw', minWidth: 280 }}>
      <div className="fpp-header">
        <span className="fpp-path mono" title={path}>{fileName}</span>
        {hasRichView && (
          <button className={`btn btn-sm ${!showRaw ? 'tab-active' : ''}`} onClick={() => setShowRaw(false)}>{t('previewView')}</button>
        )}
        {hasRichView && (
          <button className={`btn btn-sm ${showRaw ? 'tab-active' : ''}`} onClick={() => setShowRaw(true)}>{t('rawView')}</button>
        )}
        <button className="btn btn-icon" onClick={onClose}><IconX size={13} /></button>
      </div>
      <div className="fpp-body">
        {loading && <div className="dim" style={{ padding: 16 }}>…</div>}
        {error && <div className="msg-error">{error}</div>}
        {isImage && (
          <img
            src={fileUrl}
            alt={path}
            style={{ maxWidth: '100%', borderRadius: 8, padding: '0 12px' }}
          />
        )}
        {content !== undefined && !showRaw && isMd && (
          <div className="md fpp-md">
            <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
          </div>
        )}
        {content !== undefined && (showRaw || !isMd) && (
          <CodeView text={isJson && !showRaw ? formatJson(content, ext) : content} />
        )}
      </div>
    </div>
  );
}


function CodeView({ text }: { text: string }) {
  return (
    <pre className="tool-pre fpp-pre">
      {text.split('\n').map((line, i) => (
        <div key={i} className="fpp-line">
          <span className="fpp-lineno">{i + 1}</span>
          <span>{line || ' '}</span>
        </div>
      ))}
    </pre>
  );
}
