import { useCallback, useEffect, useState } from 'react';
import { t } from '../i18n';
import { IconChevronRight } from '../icons';

interface PkgFile {
  path: string;
  enabled: boolean;
}

interface PkgConfig {
  source: string;
  scope: string;
  installedPath?: string;
  enabled: boolean;
  filters: Record<string, string[]>;
  contents: Record<string, PkgFile[]>;
}

interface ExtItem {
  path: string;
  source?: string;
  scope?: string;
}

const KIND_LABELS: Record<string, string> = {
  skills: 'skills',
  extensions: 'extensions',
  prompts: 'prompts',
  themes: 'themes',
};

export default function ExtensionsPanel({ cwd: initialCwd }: { cwd: string }) {
  const [cwd, setCwd] = useState(initialCwd);
  const [cwdDraft, setCwdDraft] = useState(initialCwd);
  const [packages, setPackages] = useState<PkgConfig[]>([]);
  const [extensions, setExtensions] = useState<ExtItem[]>([]);
  const [installSource, setInstallSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    fetch(`/api/packages/config?cwd=${encodeURIComponent(cwd)}`)
      .then((r) => r.json())
      .then((d: { packages?: PkgConfig[] }) => setPackages(d.packages ?? []))
      .catch(() => undefined);
    fetch(`/api/resources?cwd=${encodeURIComponent(cwd)}`)
      .then((r) => r.json())
      .then((d: { extensions?: ExtItem[] }) => setExtensions(d.extensions ?? []))
      .catch(() => undefined);
  }, [cwd]);

  useEffect(load, [load]);

  const install = async () => {
    const source = installSource.trim();
    if (!source || busy) return;
    setBusy(true);
    setNotice(t('installing'));
    try {
      const res = await fetch('/api/extensions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, cwd }),
      });
      const d = (await res.json()) as { ok?: boolean; error?: string };
      setNotice(res.ok ? `${source} ✓` : (d.error ?? 'failed'));
      if (res.ok) {
        setInstallSource('');
        load();
      }
    } finally {
      setBusy(false);
    }
  };

  const removePkg = async (source: string) => {
    if (!confirm(t('confirmRemove'))) return;
    await fetch(`/api/extensions?cwd=${encodeURIComponent(cwd)}&source=${encodeURIComponent(source)}`, { method: 'DELETE' }).catch(() => undefined);
    load();
  };

  const togglePkg = async (pkg: PkgConfig, enabled: boolean) => {
    await fetch(`/api/packages/config?cwd=${encodeURIComponent(cwd)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: pkg.source, scope: pkg.scope, enabled }),
    }).catch(() => undefined);
    load();
  };

  const toggleFile = async (pkg: PkgConfig, kind: string, file: PkgFile, enabled: boolean) => {
    await fetch(`/api/packages/config?cwd=${encodeURIComponent(cwd)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: pkg.source,
        scope: pkg.scope,
        toggleKind: kind,
        togglePath: file.path,
        toggleEnabled: enabled,
        contents: pkg.contents,
      }),
    }).catch(() => undefined);
    load();
  };

  const fileLabel = (path: string) => path.split('/').pop() ?? path;

  return (
    <div className="panel-page">
      <div className="panel-header">
        <h2>{t('tabExtensions')}</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setCwd(cwdDraft.trim() || cwd);
          }}
          style={{ flex: 1, display: 'flex' }}
        >
          <input className="panel-search mono" value={cwdDraft} onChange={(e) => setCwdDraft(e.target.value)} />
        </form>
      </div>

      <div className="key-row" style={{ marginBottom: 10 }}>
        <input
          value={installSource}
          placeholder={t('installPlaceholder')}
          onChange={(e) => setInstallSource(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void install()}
        />
        <button className="btn btn-sm" disabled={busy} onClick={() => void install()}>{t('install')}</button>
      </div>
      {notice && <div className="panel-notice">{notice}</div>}

      <h3 className="section-title">{t('installedPackages')} ({packages.length})</h3>
      <div className="provider-list">
        {packages.map((pkg) => {
          const key = pkg.source + pkg.scope;
          const open = expanded.has(key);
          const kinds = Object.entries(pkg.contents).filter(([, files]) => files.length > 0);
          const totalFiles = kinds.reduce((n, [, files]) => n + files.length, 0);
          return (
            <div key={key} className="provider-card">
              <div className="pkg-head" onClick={() => totalFiles > 0 && setExpanded((prev) => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; })}>
                {totalFiles > 0 && (
                  <span className={`sub-chevron ${open ? 'open' : ''}`}><IconChevronRight size={10} /></span>
                )}
                <span className="mono" style={{ fontSize: 12.5, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pkg.source}</span>
                <span className="tag">{pkg.scope}</span>
                <button
                  className={`toggle ${pkg.enabled ? 'on' : ''}`}
                  title={t('pkgEnabled')}
                  onClick={(e) => {
                    e.stopPropagation();
                    void togglePkg(pkg, !pkg.enabled);
                  }}
                />
                <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); void removePkg(pkg.source); }}>{t('remove')}</button>
              </div>
              {open && kinds.map(([kind, files]) => (
                <div key={kind} className="pkg-kind">
                  <div className="tool-section-label">{KIND_LABELS[kind] ?? kind}</div>
                  {files.map((f) => (
                    <div key={f.path} className="pkg-file">
                      <button
                        className={`toggle ${f.enabled ? 'on' : ''}`}
                        onClick={() => void toggleFile(pkg, kind, f, !f.enabled)}
                      />
                      <span className="mono" style={{ fontSize: 12 }}>{fileLabel(f.path)}</span>
                      <span className="dim mono" style={{ fontSize: 10.5 }}>{f.path}</span>
                    </div>
                  ))}
                </div>
              ))}
              {open && totalFiles === 0 && <div className="dim" style={{ padding: '4px 14px 10px' }}>—</div>}
            </div>
          );
        })}
        {packages.length === 0 && <div className="dim">—</div>}
      </div>

      <h3 className="section-title">{t('extensionsSection')} ({extensions.length})</h3>
      <div className="provider-list">
        {extensions.map((e) => (
          <div key={e.path} className="provider-card" style={{ padding: '10px 14px' }}>
            <span className="mono" style={{ fontSize: 12 }}>{e.path}</span>
            {e.scope && <span className="tag" style={{ marginLeft: 8 }}>{e.scope}</span>}
          </div>
        ))}
        {extensions.length === 0 && <div className="dim">—</div>}
      </div>
    </div>
  );
}
