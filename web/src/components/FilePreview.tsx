import { memo, useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { IconX } from '../icons';
import { t } from '../i18n';
import { withAgent } from '../api';
import FileActions from './FileActions';
import { fileJson, FileApiError, fullFilePath, markdownFilePath } from '../file-workspace';
import {
  canFormatJson,
  canRenderRichMarkdown,
  MAX_NUMBERED_CODE_LINES,
} from '../ui-reliability';

interface Props {
  cwd: string;
  path: string;
  width?: number;
  embedded?: boolean;
  revision?: number | string;
  pending?: boolean;
  diffScope?: string;
  onReference?: () => void;
  onNavigate?: (path: string) => void;
  agent?: string;
  sessionId?: string;
  onClose: () => void;
  /** Forces memoized preview labels to update when the app language changes. */
  language: string;
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
function FilePreview({ cwd, path, width, agent, sessionId, onClose, embedded, revision, pending = false, diffScope, onReference, onNavigate }: Props) {
  const requestGeneration = useRef(0);
  const [content, setContent] = useState<string>();
  const [error, setError] = useState<string>();
  const [downloadAllowed, setDownloadAllowed] = useState(true);
  const [loading, setLoading] = useState(true);
  const [showRaw, setShowRaw] = useState(false);
  const [retry, setRetry] = useState(0);
  const [notice, setNotice] = useState<string>();

  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  const isImage = diffScope === undefined && IMAGE_EXTS.has(ext);
  const isMd = MD_EXTS.has(ext);
  const isJson = JSON_EXTS.has(ext);
  const hasRichView = diffScope === undefined && (isMd || isJson);
  const sessionQuery = sessionId
    ? `&sessionId=${encodeURIComponent(sessionId)}`
    : '';
  const fileUrl = withAgent(
    `/api/file?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}${sessionQuery}`,
    agent,
  );
  const dataUrl = diffScope === undefined ? fileUrl : withAgent(`/api/git/diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}&scope=${diffScope}`, agent);

  useEffect(() => {
    const generation = ++requestGeneration.current;
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    setDownloadAllowed(true);
    setContent(undefined);
    setShowRaw(false);
    setNotice(undefined);
    if (pending) {
      setDownloadAllowed(false);
      return () => controller.abort();
    }
    if (isImage) {
      return () => controller.abort();
    }
    void fileJson<{ content?: string; diff?: string }>(dataUrl, controller.signal)
      .then((d) => {
        if (controller.signal.aborted || generation !== requestGeneration.current) return;
        setContent(d.content ?? d.diff ?? '');
      })
      .catch((cause) => {
        if (!controller.signal.aborted && generation === requestGeneration.current) {
          setDownloadAllowed(cause instanceof FileApiError && [413, 415].includes(cause.status));
          setError(cause instanceof FileApiError && cause.status === 413 ? t('fileTooLarge')
            : cause instanceof FileApiError && cause.status === 415 ? t('fileBinary')
            : cause instanceof FileApiError && cause.status === 404 ? t('fileNotFound')
            : cause instanceof FileApiError && (cause.status === 403 || /(?:path|symlink) escapes workspace/.test(cause.message)) ? t('fileAccessDenied')
            : String(cause));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && generation === requestGeneration.current) setLoading(false);
      });
    return () => controller.abort();
  }, [dataUrl, isImage, revision, retry, pending]);

  const fileName = path.split('/').pop() ?? path;
  const richMarkdown = diffScope === undefined && isMd && content !== undefined && canRenderRichMarkdown(content.length);
  const formattedContent = useMemo(() => {
    if (content === undefined || diffScope !== undefined || !isJson || showRaw || !canFormatJson(content.length))
      return content;
    return formatJson(content, ext);
  }, [content, ext, isJson, showRaw, diffScope]);

  return (
    <div className={`file-preview-pane ${embedded ? 'file-preview-embedded' : ''}`} style={embedded ? undefined : { width, maxWidth: '75vw', minWidth: 280 }}>
      <div className="fpp-header">
        <div className="fpp-file-heading"><strong title={fileName}>{fileName}</strong><span className="fpp-path mono" title={fullFilePath(cwd, path)}>{path}</span></div>
        {hasRichView && (
          <button className={`btn btn-sm ${!showRaw ? 'tab-active' : ''}`} onClick={() => setShowRaw(false)}>{t('previewView')}</button>
        )}
        {hasRichView && (
          <button className={`btn btn-sm ${showRaw ? 'tab-active' : ''}`} onClick={() => setShowRaw(true)}>{t('rawView')}</button>
        )}
        <FileActions name={fileName} download={downloadAllowed ? `${fileUrl}&download=1` : undefined} onReference={onReference}
          onCopy={() => { void navigator.clipboard.writeText(fullFilePath(cwd, path)).then(() => setNotice(t('fileCopied')), e => setNotice(String(e))); }} />
        <button className="btn btn-icon" aria-label={t('close')} onClick={onClose}><IconX size={13} /></button>
      </div>
      <div className="fpp-body">
        {notice && <div className="fpp-large-preview-note" role="status">{notice}</div>}
        {(pending || loading) && <div className="file-loading" role="status">{t(pending ? 'fileToolPending' : 'fileLoading')}</div>}
        {!pending && error && <div className="file-preview-error" role="alert"><p>{error}</p><button className="btn btn-sm" onClick={() => setRetry(v => v + 1)}>{t('retry')}</button> {downloadAllowed && <a className="btn btn-sm" href={`${fileUrl}&download=1`} download>{t('downloadFile')}</a>}</div>}
        {!pending && isImage && (
          <img
            key={`${fileUrl}|${retry}|${revision}`}
            src={`${fileUrl}&v=${revision ?? 0}-${retry}`}
            alt={path}
            onLoad={() => setLoading(false)}
            onError={() => { setLoading(false); setError(t('fileImageError')); }}
            style={{ maxWidth: '100%', borderRadius: 8, padding: '0 12px' }}
          />
        )}
        {content !== undefined && !showRaw && richMarkdown && (
          <MarkdownPreview content={content} cwd={cwd} path={path} agent={agent} sessionId={sessionId} onNavigate={onNavigate} />
        )}
        {content !== undefined && diffScope === undefined && !showRaw && isMd && !richMarkdown && (
          <div className="fpp-large-preview-note" role="status">{t('largePreviewFallback')}</div>
        )}
        {content === '' && diffScope !== undefined && <div className="file-empty">{t('fileNoDiff')}</div>}
        {content !== undefined && (diffScope !== undefined || showRaw || !isMd || !richMarkdown) && (
          <CodeView text={formattedContent ?? content} diff={diffScope !== undefined} />
        )}
      </div>
    </div>
  );
}

export default memo(FilePreview);

const MarkdownPreview = memo(function MarkdownPreview({ content, cwd, path, agent, sessionId, onNavigate }: {
  content: string; cwd: string; path: string; agent?: string; sessionId?: string; onNavigate?: (path: string) => void;
}) {
  const resourceUrl = (target: string) => withAgent(`/api/file?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(target)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ''}`, agent);
  return (
    <div className="md fpp-md">
      <Markdown remarkPlugins={[remarkGfm]} components={{
        img: ({ src, alt }) => {
          const resolved = typeof src === 'string' ? markdownFilePath(path, src) : undefined;
          return <img src={resolved ? resourceUrl(resolved) : src} alt={alt} loading="lazy" />;
        },
        a: ({ href, children }) => {
          const resolved = href ? markdownFilePath(path, href) : undefined;
          return <a href={resolved ? `${resourceUrl(resolved)}&download=1` : href}
            onClick={resolved && onNavigate ? e => { e.preventDefault(); onNavigate(resolved); } : undefined}>{children}</a>;
        },
      }}>{content}</Markdown>
    </div>
  );
});

const CodeView = memo(function CodeView({ text, diff }: { text: string; diff?: boolean }) {
  const lines = useMemo(() => {
    let count = 1;
    for (let index = 0; index < text.length && count <= MAX_NUMBERED_CODE_LINES; index++) {
      if (text.charCodeAt(index) === 10) count += 1;
    }
    return count <= MAX_NUMBERED_CODE_LINES ? text.split('\n') : undefined;
  }, [text]);
  return (
    <pre className="tool-pre fpp-pre">
      {lines ? lines.map((line, i) => (
          <div key={i} className={`fpp-line ${diff && line.startsWith('+') ? 'diff-add' : diff && line.startsWith('-') ? 'diff-del' : ''}`}>
            <span className="fpp-lineno">{i + 1}</span>
            <span>{line || ' '}</span>
          </div>
        )) : <code className="fpp-large-code">{text}</code>}
    </pre>
  );
});
