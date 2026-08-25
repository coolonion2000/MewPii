import { useCallback, useEffect, useState } from 'react';
import { getAgent } from '../api';
import { IconFolder, IconX } from '../icons';
import { t } from '../i18n';

interface DirItem {
  name: string;
  isDir: boolean;
}

interface Props {
  initialPath: string;
  onPick: (cwd: string) => void;
  onClose: () => void;
}

const HOME = '/';

/** Folder browser for starting a session in any directory. */
export default function DirectoryPicker({ initialPath, onPick, onClose }: Props) {
  const [cwd, setCwd] = useState(initialPath || HOME);
  const [dirs, setDirs] = useState<DirItem[]>([]);
  const [error, setError] = useState<string>();
  const [pathDraft, setPathDraft] = useState(initialPath || HOME);

  const load = useCallback((path: string) => {
    fetch(`/api/files?cwd=${encodeURIComponent('/')}&path=${encodeURIComponent(path)}`)
      .then(async (r) => {
        const d = await r.json();
        if (r.ok && d.items) {
          setDirs(d.items.filter((i: DirItem) => i.isDir && !i.name.startsWith('.')));
          setError(undefined);
          setCwd(path);
          setPathDraft(path);
        } else {
          setError(d.error ?? 'failed');
        }
      })
      .catch((e) => setError(String(e)));
  }, []);

  const agent = getAgent();
  useEffect(() => {
    load(initialPath || HOME);
  }, [agent]); // eslint-disable-line react-hooks/exhaustive-deps

  const crumbs = cwd.split('/').filter(Boolean);

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal dirpicker" onClick={(e) => e.stopPropagation()}>
        <div className="dp-head">
          <IconFolder size={15} />
          <h3>{t('pickFolder')}</h3>
          {agent && <span className="tag">{agent}</span>}
          <span className="spacer" />
          <button className="btn btn-icon" onClick={onClose}><IconX size={13} /></button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            load(pathDraft.trim() || '/');
          }}
          style={{ display: 'flex', gap: 8, marginBottom: 8 }}
        >
          <input
            className="dp-path mono"
            value={pathDraft}
            onChange={(e) => setPathDraft(e.target.value)}
            placeholder="/path/to/project"
          />
        </form>

        <div className="dp-crumbs">
          <button className="btn btn-sm" onClick={() => load('/')}>⌂</button>
          {crumbs.map((c, i) => (
            <span key={i}>
              <span className="dim">/</span>
              <button className="btn btn-sm" onClick={() => load('/' + crumbs.slice(0, i + 1).join('/'))}>{c}</button>
            </span>
          ))}
        </div>

        <div className="dp-list">
          {error && <div className="dim" style={{ padding: 12 }}>{error}</div>}
          {!error && dirs.length === 0 && <div className="dim" style={{ padding: 12 }}>—</div>}
          {dirs.map((d) => (
            <button
              key={d.name}
              className="dp-row"
              onClick={() => load(cwd === '/' ? `/${d.name}` : `${cwd}/${d.name}`)}
              onDoubleClick={() => onPick(cwd === '/' ? `/${d.name}` : `${cwd}/${d.name}`)}
            >
              <IconFolder size={13} className="dp-icon" />
              <span>{d.name}</span>
            </button>
          ))}
        </div>

        <div className="dp-foot">
          <span className="dim mono dp-current">{cwd}</span>
          <button className="btn btn-sm btn-primary" style={{ width: 'auto' }} onClick={() => onPick(cwd)}>
            {t('pickThisFolder')}
          </button>
        </div>
      </div>
    </div>
  );
}
