import { useCallback, useEffect, useState } from 'react';
import { t } from '../i18n';

interface Pkg {
  source: string;
  scope: string;
  filtered?: boolean;
  installedPath?: string;
}

interface ExtItem {
  path: string;
  source?: string;
  scope?: string;
}

export default function ExtensionsPanel({ cwd: initialCwd }: { cwd: string }) {
  const [cwd, setCwd] = useState(initialCwd);
  const [cwdDraft, setCwdDraft] = useState(initialCwd);
  const [packages, setPackages] = useState<Pkg[]>([]);
  const [extensions, setExtensions] = useState<ExtItem[]>([]);
  const [installSource, setInstallSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();

  const load = useCallback(() => {
    fetch(`/api/extensions?cwd=${encodeURIComponent(cwd)}`)
      .then((r) => r.json())
      .then((d: { packages?: Pkg[] }) => setPackages(d.packages ?? []))
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
        {packages.map((pkg) => (
          <div key={pkg.source + pkg.scope} className="provider-card" style={{ padding: '10px 14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="mono" style={{ fontSize: 12.5, flex: 1 }}>{pkg.source}</span>
              <span className="tag">{pkg.scope}</span>
              <button className="btn btn-sm" onClick={() => void removePkg(pkg.source)}>{t('remove')}</button>
            </div>
            {pkg.installedPath && <div className="dim mono" style={{ fontSize: 11, marginTop: 4 }}>{pkg.installedPath}</div>}
          </div>
        ))}
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
