import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../i18n';

interface FileItem {
  name: string;
  isDir: boolean;
  size: number;
  modified?: string;
}

interface GitState {
  branch?: string;
  changes?: { status: string; path: string }[];
  diffStat?: string;
  error?: string;
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp']);

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function FilesPanel({ cwd: initialCwd }: { cwd: string }) {
  const [cwd, setCwd] = useState(initialCwd);
  const [cwdDraft, setCwdDraft] = useState(initialCwd);
  const [tab, setTab] = useState<'files' | 'git'>('files');
  const [rel, setRel] = useState('.');
  const [items, setItems] = useState<FileItem[]>([]);
  const [preview, setPreview] = useState<{ path: string; content?: string; image?: boolean } | undefined>();
  const [git, setGit] = useState<GitState | undefined>();
  const [diff, setDiff] = useState<{ path?: string; diff: string } | undefined>();
  const [error, setError] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);

  const loadDir = useCallback((dirCwd: string, path: string) => {
    fetch(`/api/files?cwd=${encodeURIComponent(dirCwd)}&path=${encodeURIComponent(path)}`)
      .then((r) => r.json())
      .then((d: { items?: FileItem[]; error?: string }) => {
        if (d.items) {
          setItems(d.items);
          setError(undefined);
        } else setError(d.error ?? 'failed');
      })
      .catch((e) => setError(String(e)));
  }, []);

  const loadGit = useCallback((dirCwd: string) => {
    fetch(`/api/git?cwd=${encodeURIComponent(dirCwd)}`)
      .then((r) => r.json())
      .then((d: GitState) => setGit(d))
      .catch(() => setGit({ error: 'failed' }));
  }, []);

  useEffect(() => {
    loadDir(cwd, rel);
    loadGit(cwd);
    setPreview(undefined);
    setDiff(undefined);
  }, [cwd, rel, loadDir, loadGit]);

  const openFile = (item: FileItem) => {
    const path = rel === '.' ? item.name : `${rel}/${item.name}`;
    if (item.isDir) {
      setRel(path);
      return;
    }
    const ext = item.name.slice(item.name.lastIndexOf('.')).toLowerCase();
    if (IMAGE_EXTS.has(ext)) {
      setPreview({ path, image: true });
      return;
    }
    fetch(`/api/file?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`)
      .then(async (r) => {
        const d = (await r.json()) as { content?: string; error?: string };
        if (d.content !== undefined) setPreview({ path, content: d.content });
        else setError(d.error ?? 'preview failed');
      })
      .catch((e) => setError(String(e)));
  };

  const viewDiff = (path?: string) => {
    fetch(`/api/git/diff?cwd=${encodeURIComponent(cwd)}${path ? `&path=${encodeURIComponent(path)}` : ''}`)
      .then((r) => r.json())
      .then((d: { diff: string }) => setDiff({ path, diff: d.diff }))
      .catch(() => undefined);
  };

  const upload = (file: File) => {
    const path = rel === '.' ? file.name : `${rel}/${file.name}`;
    fetch(`/api/files/upload?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`, {
      method: 'POST',
      body: file,
    }).then(() => loadDir(cwd, rel)).catch(() => undefined);
  };

  const crumbs = rel === '.' ? [] : rel.split('/');

  return (
    <div className="panel-page">
      <div className="panel-header">
        <h2>{t('filesTitle')}</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setCwd(cwdDraft.trim() || cwd);
            setRel('.');
          }}
          style={{ flex: 1, display: 'flex' }}
        >
          <input className="panel-search mono" value={cwdDraft} onChange={(e) => setCwdDraft(e.target.value)} />
        </form>
        <div className="tabs">
          <button className={`btn btn-sm ${tab === 'files' ? 'tab-active' : ''}`} onClick={() => setTab('files')}>{t('filesTab')}</button>
          <button className={`btn btn-sm ${tab === 'git' ? 'tab-active' : ''}`} onClick={() => setTab('git')}>{t('gitTab')}</button>
        </div>
      </div>

      {error && <div className="msg-error">{error}</div>}

      {tab === 'files' && (
        <div className="files-layout">
          <div className="file-list">
            <div className="breadcrumb">
              <button className="btn btn-sm" onClick={() => setRel('.')}>⌂</button>
              {crumbs.map((c, i) => (
                <span key={i}>
                  <span className="dim"> / </span>
                  <button className="btn btn-sm" onClick={() => setRel(crumbs.slice(0, i + 1).join('/'))}>{c}</button>
                </span>
              ))}
              <span className="spacer" />
              <button className="btn btn-sm" onClick={() => fileInput.current?.click()}>{t('upload')}</button>
              <input
                ref={fileInput}
                type="file"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) upload(f);
                  e.target.value = '';
                }}
              />
            </div>
            {items.map((item) => (
              <div key={item.name} className="file-row" onClick={() => openFile(item)}>
                <span className="file-icon">{item.isDir ? '▸' : '·'}</span>
                <span className="file-name">{item.name}</span>
                <span className="dim">{item.isDir ? '' : fmtSize(item.size)}</span>
              </div>
            ))}
          </div>
          <div className="file-preview">
            {preview ? (
              preview.image ? (
                <img
                  src={`/api/file?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(preview.path)}`}
                  alt={preview.path}
                  style={{ maxWidth: '100%', borderRadius: 8 }}
                />
              ) : (
                <>
                  <div className="preview-title mono">{preview.path}</div>
                  <pre className="tool-pre" style={{ maxHeight: 'none' }}>{preview.content}</pre>
                </>
              )
            ) : (
              <div className="dim" style={{ padding: 20 }}>—</div>
            )}
          </div>
        </div>
      )}

      {tab === 'git' && (
        <div className="git-layout">
          {!git || git.error ? (
            <div className="dim" style={{ padding: 20 }}>{git?.error ?? t('noGit')}</div>
          ) : (
            <>
              <div className="git-head">
                <span className="tag">{t('branch')}: {git.branch}</span>
                <span className="dim">{git.changes?.length ?? 0} {t('changedFiles')}</span>
                {(git.changes?.length ?? 0) > 0 && (
                  <button className="btn btn-sm" onClick={() => viewDiff()}>{t('viewDiff')} (all)</button>
                )}
              </div>
              <div className="file-list">
                {(git.changes ?? []).map((c) => (
                  <div key={c.path} className="file-row" onClick={() => viewDiff(c.path)}>
                    <span className={`git-status s-${c.status[0] ?? ''}`}>{c.status}</span>
                    <span className="file-name mono">{c.path}</span>
                  </div>
                ))}
                {(git.changes ?? []).length === 0 && <div className="dim" style={{ padding: 12 }}>{t('noChanges')}</div>}
              </div>
              {diff && (
                <pre className="tool-pre diff-view">
                  {diff.diff.split('\n').map((line, i) => {
                    const cls = line.startsWith('+') && !line.startsWith('+++') ? 'diff-add'
                      : line.startsWith('-') && !line.startsWith('---') ? 'diff-del' : '';
                    return <div key={i} className={cls}>{line}</div>;
                  })}
                </pre>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
