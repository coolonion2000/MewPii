/** Project file navigator and shared preview workspace. @author coolonion */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { getLang, t } from '../i18n';
import { getAgent, withAgent } from '../api';
import { IconChevronRight, IconFolder, IconFile, IconFileCode, IconFileText, IconImage, IconSearch, IconRefresh, IconX } from '../icons';
import FilePreview from './FilePreview';
import FileActions from './FileActions';
import { ancestorDirectories, fileJson, formatFileSize, fullFilePath, loadFileWorkspace, parentDirectory, type FileItem, type GitChange, type GitState } from '../file-workspace';

interface Props { cwd: string; projects?: string[]; onReference?: (path: string) => void; onCwdChange?: (cwd: string) => void }
interface DirectoryState { items?: FileItem[]; error?: string; loading?: boolean }

function FileIcon({ item }: { item: Pick<FileItem, 'isDir' | 'name'> }) {
  if (item.isDir) return <IconFolder className="file-kind folder" size={16} />;
  if (/\.(png|jpe?g|webp|svg|gif|ico|bmp)$/i.test(item.name)) return <IconImage className="file-kind image" size={16} />;
  if (/\.(md|markdown|txt|csv)$/i.test(item.name)) return <IconFileText className="file-kind document" size={16} />;
  if (/\.(tsx?|jsx?|java|py|go|rs|jsonl?|yml|yaml|css|sh|sql|xml|toml)$/i.test(item.name)) return <IconFileCode className="file-kind code" size={16} />;
  return <IconFile className="file-kind" size={16} />;
}

export default function FilesPanel({ cwd: initialCwd, projects = [], onReference, onCwdChange }: Props) {
  const agent = useRef(getAgent()).current;
  const projectKey = `pii-files-project:${agent ?? 'local'}:${initialCwd}`;
  const [cwd, setCwd] = useState(() => { try { return localStorage.getItem(projectKey) || initialCwd; } catch { return initialCwd; } });
  useEffect(() => { onCwdChange?.(cwd); }, [cwd, onCwdChange]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(cwd);
  const [error, setError] = useState<string>();
  const validation = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => validation.current?.abort(), []);
  const changeProject = async (next: string) => {
    validation.current?.abort(); const controller = new AbortController(); validation.current = controller;
    try {
      const result = await fileJson<{ cwd: string }>(withAgent(`/api/files?cwd=${encodeURIComponent(next)}&path=.&hidden=0`, agent), controller.signal);
      if (controller.signal.aborted) return;
      setCwd(result.cwd); setDraft(result.cwd); setEditing(false); setError(undefined);
      try { localStorage.setItem(projectKey, result.cwd); } catch { /* optional preference */ }
    } catch (e) { if (!controller.signal.aborted) setError(String(e)); }
  };
  return <div className="file-workspace">
    <header className="file-workspace-heading">
      <h2>{t('filesTitle')}</h2>
      <select aria-label={t('fileProject')} value={cwd} onChange={e => void changeProject(e.target.value)}>
        {[...new Set([cwd, initialCwd, ...projects])].map(path => <option value={path} key={path}>{path.split('/').pop() || path} — {path}</option>)}
      </select>
      {editing ? <form className="file-path-form" onSubmit={e => { e.preventDefault(); void changeProject(draft.trim()); }}>
        <input autoFocus aria-label={t('filePathEdit')} value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setEditing(false); }} />
        <button className="btn btn-sm" type="submit">{t('save')}</button>
        <button className="btn btn-icon" type="button" aria-label={t('cancel')} onClick={() => setEditing(false)}><IconX size={14} /></button>
      </form> : <button className="file-project-path mono" title={cwd} onClick={() => setEditing(true)} aria-label={t('filePathEdit')}>{cwd}</button>}
    </header>
    {error && <div role="alert" className="msg-error">{error}</div>}
    <FileWorkspace key={`${agent}|${cwd}`} cwd={cwd} agent={agent} onReference={onReference} />
  </div>;
}

function FileWorkspace({ cwd, agent, onReference }: { cwd: string; agent?: string; onReference?: (path: string) => void }) {
  const storageKey = `pii-files-v1:${agent ?? 'local'}:${cwd}`;
  const [state, setState] = useState(() => loadFileWorkspace(storageKey));
  const stateRef = useRef(state); stateRef.current = state;
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({});
  const requests = useRef(new Map<string, AbortController>());
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<{ items: FileItem[]; truncated?: boolean }>();
  const [searchError, setSearchError] = useState<string>();
  const [mode, setMode] = useState<'files' | 'git'>('files');
  const [git, setGit] = useState<GitState>();
  const [gitError, setGitError] = useState<string>();
  const [gitSelection, setGitSelection] = useState<{ path: string; scope: string }>();
  const [notice, setNotice] = useState<string>();
  const [mobilePreview, setMobilePreview] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const xhr = useRef<XMLHttpRequest | undefined>(undefined);
  const [uploading, setUploading] = useState<{ name: string; percent: number }>();
  const [conflict, setConflict] = useState<{ file: File; directory: string; name: string }>();
  const [saveName, setSaveName] = useState('');
  const [conflictError, setConflictError] = useState<string>();
  const layout = useRef<HTMLDivElement>(null);
  const dragCleanup = useRef<(() => void) | undefined>(undefined);
  const url = useCallback((route: string, path?: string) => withAgent(`/api/${route}?cwd=${encodeURIComponent(cwd)}${path !== undefined ? `&path=${encodeURIComponent(path)}` : ''}`, agent), [cwd, agent]);

  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch { /* optional preference */ } }, [storageKey, state]);
  useEffect(() => () => { xhr.current?.abort(); dragCleanup.current?.(); }, []);
  const loadDirectory = useCallback(async (path: string) => {
    requests.current.get(path)?.abort(); const controller = new AbortController(); requests.current.set(path, controller);
    setDirectories(old => ({ ...old, [path]: { loading: true } }));
    try {
      const result = await fileJson<{ items: FileItem[] }>(`${url('files', path)}&hidden=${stateRef.current.hidden ? 1 : 0}`, controller.signal);
      if (!controller.signal.aborted) setDirectories(old => ({ ...old, [path]: { items: result.items } }));
    } catch (e) { if (!controller.signal.aborted) setDirectories(old => ({ ...old, [path]: { error: String(e) } })); }
  }, [url]);
  useEffect(() => {
    for (const c of requests.current.values()) c.abort(); requests.current.clear(); setDirectories({});
    for (const path of new Set(['.', ...stateRef.current.open])) void loadDirectory(path);
    return () => { for (const c of requests.current.values()) c.abort(); requests.current.clear(); };
  }, [loadDirectory, revision, state.hidden]);

  useEffect(() => {
    setSearch(undefined); setSearchError(undefined);
    if (!query.trim()) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void fileJson<{ items: FileItem[]; truncated?: boolean }>(`${url('files')}&q=${encodeURIComponent(query.trim())}&hidden=${state.hidden ? 1 : 0}`, controller.signal)
        .then(result => { if (!controller.signal.aborted) setSearch(result); })
        .catch(e => { if (!controller.signal.aborted) setSearchError(String(e)); });
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, state.hidden, revision, url]);
  useEffect(() => {
    if (mode !== 'git') return;
    const controller = new AbortController(); setGit(undefined); setGitError(undefined);
    void fileJson<GitState>(url('git'), controller.signal).then(result => { if (!controller.signal.aborted) setGit(result); })
      .catch(e => { if (!controller.signal.aborted) setGitError(String(e)); });
    return () => controller.abort();
  }, [mode, revision, url]);

  const reveal = (path: string, isDir = false) => {
    const needed = isDir ? [...ancestorDirectories(path), path] : ancestorDirectories(path);
    setState(old => ({ ...old, selected: isDir ? undefined : path, directory: isDir ? path : parentDirectory(path), open: [...new Set([...old.open, ...needed])] }));
    for (const dir of needed) if (!directories[dir]?.items) void loadDirectory(dir);
    if (!isDir) setMobilePreview(true);
  };
  const toggleFolder = (path: string) => {
    const opening = !state.open.includes(path);
    setState(old => ({ ...old, open: opening ? [...old.open, path] : old.open.filter(p => p !== path) }));
    if (opening && !directories[path]?.items) void loadDirectory(path);
  };
  const copy = async (path: string) => {
    try { await navigator.clipboard.writeText(fullFilePath(cwd, path)); setNotice(t('fileCopied')); }
    catch (e) { setNotice(String(e)); }
  };
  const reference = (path: string) => onReference?.(fullFilePath(cwd, path));
  const upload = async (file: File, directory: string, name = file.name, replace = false) => {
    if (file.size > 64 * 1024 * 1024) { setNotice(t('fileUploadLimit')); return; }
    if (!name.trim() || /[/\\\x00-\x1f]/.test(name) || name === '.' || name === '..') { setConflictError(t('fileNameInvalid')); return; }
    const path = directory === '.' ? name : `${directory}/${name}`;
    setConflict(undefined); setConflictError(undefined); setNotice(undefined); setUploading({ name, percent: 0 });
    const request = new XMLHttpRequest(); xhr.current = request;
    request.open('POST', `${url('files/upload', path)}${replace ? '&replace=1' : ''}`);
    request.upload.onprogress = event => { if (event.lengthComputable) setUploading({ name, percent: Math.round(event.loaded / event.total * 100) }); };
    request.onload = () => {
      if (xhr.current !== request) return;
      setUploading(undefined);
      let data: { error?: string } = {}; try { data = JSON.parse(request.responseText); } catch { /* report HTTP below */ }
      if (request.status === 409) { setConflict({ file, directory, name }); setSaveName(name); setConflictError(t('fileConflict')); }
      else if (request.status >= 200 && request.status < 300) {
        setNotice(`${t('fileUploadDone')}: ${name}`); setRevision(v => v + 1); reveal(path);
      } else setNotice(`${t('fileUploadFailed')}: ${data.error ?? `HTTP ${request.status}`}`);
    };
    request.onerror = () => { if (xhr.current === request) { setUploading(undefined); setNotice(t('fileUploadFailed')); } };
    request.onabort = () => { setUploading(undefined); setNotice(t('fileCanceled')); };
    request.send(file);
  };
  const resize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault(); dragCleanup.current?.();
    const element = event.currentTarget; const start = event.clientX; const width = state.width;
    element.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => setState(old => ({ ...old, width: Math.max(200, Math.min(480, (layout.current?.clientWidth ?? 800) - 300, width + e.clientX - start)) }));
    const end = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end); window.removeEventListener('blur', end); dragCleanup.current = undefined; };
    dragCleanup.current = end; window.addEventListener('pointermove', move); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end); window.addEventListener('blur', end);
  };
  const renderItem = (item: FileItem, depth: number, searchResult = false): React.ReactNode => <div key={item.path}>
    <div className={`workspace-file-row ${state.selected === item.path || (item.isDir && state.directory === item.path) ? 'selected' : ''}`} style={{ paddingLeft: 8 + depth * 14 }}>
      {item.isDir && !searchResult ? <button className={`file-disclosure ${state.open.includes(item.path) ? 'open' : ''}`} aria-label={`${t(state.open.includes(item.path) ? 'fileCollapse' : 'fileExpand')}: ${item.path}`} aria-expanded={state.open.includes(item.path)} onClick={() => toggleFolder(item.path)}><IconChevronRight size={13} /></button> : <span className="file-disclosure-spacer" />}
      <button className="file-select" title={`${item.path}${item.modified ? ` · ${new Date(item.modified).toLocaleString()}` : ''}`} aria-current={state.selected === item.path ? 'true' : undefined}
        onClick={() => { if (searchResult && item.isDir) setQuery(''); reveal(item.path, item.isDir); }}><FileIcon item={item} /><span>{searchResult ? item.path : item.name}</span></button>
      <span className="file-meta">{!item.isDir && <span className="file-size">{formatFileSize(item.size)}</span>}
        <FileActions name={item.path} download={item.isDir ? undefined : `${url('file', item.path)}&download=1`} onCopy={() => void copy(item.path)} onReference={!item.isDir && onReference ? () => reference(item.path) : undefined} />
      </span>
    </div>
    {item.isDir && !searchResult && state.open.includes(item.path) && <div className="workspace-file-children">{renderDirectory(item.path, depth + 1)}</div>}
  </div>;
  const renderDirectory = (path: string, depth: number): React.ReactNode => {
    const dir = directories[path];
    if (!dir || dir.loading) return <div className="file-loading" role="status" style={{ paddingLeft: 24 + depth * 14 }}>{t('fileLoading')}</div>;
    if (dir.error) return <div role="alert" className="file-inline-error">{dir.error}<button className="btn btn-sm" onClick={() => void loadDirectory(path)}>{t('retry')}</button></div>;
    if (!dir.items?.length) return <div className="file-empty" style={{ paddingLeft: 24 + depth * 14 }}>{t('fileEmpty')}</div>;
    return dir.items.map(item => renderItem(item, depth));
  };
  const changedRow = (change: GitChange, scope: string, status: string) => <button key={change.path} className={`workspace-change-row ${gitSelection?.path === change.path && gitSelection.scope === scope ? 'selected' : ''}`}
    title={change.originalPath ? `${change.originalPath} → ${change.path}` : change.path}
    onClick={() => { setGitSelection({ path: change.path, scope }); setMobilePreview(true); }}>
    <span className={`git-status s-${status}`}>{status}</span><span>{change.path}</span>
  </button>;
  const crumbs = state.directory === '.' ? [] : state.directory.split('/');
  const previewPath = mode === 'git' ? gitSelection?.path : state.selected;
  return <>
    <div className="file-workspace-toolbar">
      <nav className="file-breadcrumbs" aria-label={t('fileUploadTo')}>
        <button onClick={() => { setQuery(''); reveal('.', true); }} title={cwd}><IconFolder size={14} />{cwd.split('/').pop()}</button>
        {crumbs.map((part, index) => <span key={index}>/<button onClick={() => { setQuery(''); reveal(crumbs.slice(0, index + 1).join('/'), true); }}>{part}</button></span>)}
      </nav>
      <button className="btn btn-icon" title={t('fileRefresh')} aria-label={t('fileRefresh')} onClick={() => setRevision(v => v + 1)}><IconRefresh size={15} /></button>
      <button className="btn btn-sm" disabled={Boolean(uploading)} title={`${t('fileUploadTo')}: ${fullFilePath(cwd, state.directory)}`} onClick={() => fileInput.current?.click()}>{t('upload')}</button>
      <input ref={fileInput} type="file" hidden onChange={e => { const file = e.target.files?.[0]; if (file) void upload(file, state.directory); e.target.value = ''; }} />
    </div>
    {notice && <div className="file-notice" role="status">{notice}<button className="btn btn-icon" aria-label={t('close')} onClick={() => setNotice(undefined)}><IconX size={12} /></button></div>}
    {uploading && <div className="file-upload-progress" role="status"><span>{t('fileUploading')}: {uploading.name} · {uploading.percent}%</span><progress max={100} value={uploading.percent} /><button className="btn btn-sm" onClick={() => xhr.current?.abort()}>{t('cancel')}</button></div>}
    <div ref={layout} className={`file-workspace-layout ${mobilePreview && previewPath ? 'show-file-preview' : ''}`}>
      <aside className="file-navigator" style={{ width: state.width }}>
        <div className="file-navigator-tabs"><button className={mode === 'files' ? 'active' : ''} onClick={() => { setMode('files'); setMobilePreview(false); }}>{t('filesTab')}</button><button className={mode === 'git' ? 'active' : ''} onClick={() => { setMode('git'); setMobilePreview(false); }}>{t('fileChanges')}</button></div>
        {mode === 'files' ? <>
          <label className="file-search"><IconSearch size={14} /><input placeholder={t('fileSearch')} aria-label={t('fileSearch')} value={query} onChange={e => setQuery(e.target.value)} />{query && <button aria-label={t('cancel')} onClick={() => setQuery('')}><IconX size={12} /></button>}</label>
          <label className="file-hidden"><input type="checkbox" checked={state.hidden} onChange={e => setState(old => ({ ...old, hidden: e.target.checked }))} />{t('fileHidden')}</label>
          <div className="file-tree" aria-label={t('filesTitle')}>
            {query.trim() ? searchError ? <div role="alert" className="file-inline-error">{searchError}<button className="btn btn-sm" onClick={() => setRevision(v => v + 1)}>{t('retry')}</button></div>
              : !search ? <div role="status" className="file-loading">{t('fileLoading')}</div>
              : <>{search.items.length ? search.items.map(item => renderItem(item, 0, true)) : <div className="file-empty">{t('noMatch')}</div>}{search.truncated && <div className="file-empty">{t('fileSearchLimit')}</div>}</>
              : renderDirectory('.', 0)}
          </div>
        </> : <div className="file-tree">
          {gitError ? <div className="file-inline-error" role="alert">{gitError}<button className="btn btn-sm" onClick={() => setRevision(v => v + 1)}>{t('retry')}</button></div> : !git ? <div className="file-loading" role="status">{t('fileLoading')}</div> : <>
            <div className="file-git-branch">{t('branch')}: {git.branch} · {git.changes.length}</div>
            {(['staged', 'unstaged', 'untracked'] as const).map(scope => {
              const changes = git.changes.filter(c => scope === 'untracked' ? c.status === '??' : c.status !== '??' && (scope === 'staged' ? c.staged : c.unstaged).trim());
              return changes.length ? <section key={scope}><h3 className="file-change-heading">{t(scope === 'staged' ? 'fileStaged' : scope === 'unstaged' ? 'fileUnstaged' : 'fileUntracked')} <span>{changes.length}</span></h3>{changes.map(c => changedRow(c, scope, scope === 'untracked' ? '?' : scope === 'staged' ? c.staged : c.unstaged))}</section> : null;
            })}
            {!git.changes.length && <div className="file-empty">{t('noChanges')}</div>}
          </>}
        </div>}
      </aside>
      <div className="file-splitter" role="separator" aria-label={t('fileResize')} aria-orientation="vertical" aria-valuenow={state.width} aria-valuemin={200} aria-valuemax={480} tabIndex={0} onPointerDown={resize}
        onKeyDown={e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); setState(old => ({ ...old, width: Math.max(200, Math.min(480, old.width + (e.key === 'ArrowRight' ? 16 : -16))) })); } }} />
      <main className="file-content">
        <button className="file-mobile-back btn btn-sm" onClick={() => setMobilePreview(false)}>{t('fileBack')}</button>
        {previewPath ? <>
          {mode === 'git' && <div className="file-diff-scopes">{['all', 'staged', 'unstaged'].map(scope => <button key={scope} className={`btn btn-sm ${gitSelection?.scope === scope ? 'tab-active' : ''}`} onClick={() => setGitSelection({ path: previewPath, scope })}>{t(scope === 'all' ? 'fileAll' : scope === 'staged' ? 'fileStaged' : 'fileUnstaged')}</button>)}</div>}
          <FilePreview key={`${previewPath}|${mode}|${gitSelection?.scope}`} cwd={cwd} path={previewPath} agent={agent} embedded language={getLang()} revision={revision}
            onNavigate={path => { setMode('files'); reveal(path); }}
            diffScope={mode === 'git' ? gitSelection?.scope : undefined} onReference={onReference ? () => reference(previewPath) : undefined}
            onClose={() => { if (mode === 'git') setGitSelection(undefined); else setState(old => ({ ...old, selected: undefined })); setMobilePreview(false); }} />
        </> : <div className="file-preview-placeholder"><IconFileText size={36} /><h3>{t('fileChoose')}</h3><p>{t('fileChooseHint')}</p></div>}
      </main>
    </div>
    {conflict && createPortal(<div className="modal-mask" onKeyDown={e => { if (e.key === 'Escape') setConflict(undefined); }}><div className="modal file-upload-conflict" role="dialog" aria-modal="true" aria-label={t('fileConflict')}>
      <h3>{t('fileConflict')}</h3><p>{t('fileConflictHint')}</p><div className="mono file-conflict-path">{fullFilePath(cwd, conflict.directory)}</div>
      <input autoFocus aria-label={t('fileSaveAs')} value={saveName} onChange={e => { setSaveName(e.target.value); setConflictError(undefined); }} />
      {conflictError && <p className="msg-error" role="alert">{conflictError}</p>}
      <div className="file-conflict-actions"><button className="btn" onClick={() => setConflict(undefined)}>{t('cancel')}</button><button className="btn" onClick={() => void upload(conflict.file, conflict.directory, saveName)}>{t('fileSaveAs')}</button><button className="btn btn-primary" onClick={() => void upload(conflict.file, conflict.directory, conflict.name, true)}>{t('fileReplace')}</button></div>
    </div></div>, document.body)}
  </>;
}
