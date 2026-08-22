import { useEffect, useState } from 'react';
import { t } from '../i18n';

interface Resources {
  skills: { name: string; description: string; filePath: string; source?: string; scope?: string }[];
  extensions: { path: string; source?: string; scope?: string }[];
  prompts: { name: string; description?: string; filePath: string }[];
}

interface Pkg {
  source: string;
  scope: string;
  filtered?: boolean;
  installedPath?: string;
}

export default function ResourcesPanel({ cwd: initialCwd }: { cwd: string }) {
  const [cwd, setCwd] = useState(initialCwd);
  const [cwdDraft, setCwdDraft] = useState(initialCwd);
  const [data, setData] = useState<Resources | undefined>();
  const [error, setError] = useState<string>();
  const [packages, setPackages] = useState<Pkg[]>([]);
  const [installSource, setInstallSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [pkgNotice, setPkgNotice] = useState<string>();

  const loadPackages = () => {
    fetch(`/api/extensions?cwd=${encodeURIComponent(cwd)}`)
      .then((r) => r.json())
      .then((d: { packages?: Pkg[] }) => setPackages(d.packages ?? []))
      .catch(() => undefined);
  };

  useEffect(loadPackages, [cwd]);

  const install = async () => {
    const source = installSource.trim();
    if (!source || busy) return;
    setBusy(true);
    setPkgNotice(t('installing'));
    try {
      const res = await fetch('/api/extensions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, cwd }),
      });
      const d = (await res.json()) as { ok?: boolean; error?: string };
      setPkgNotice(res.ok ? `${source} ✓` : (d.error ?? 'failed'));
      if (res.ok) {
        setInstallSource('');
        loadPackages();
      }
    } finally {
      setBusy(false);
    }
  };

  const removePkg = async (source: string) => {
    if (!confirm(t('confirmRemove'))) return;
    await fetch(`/api/extensions?cwd=${encodeURIComponent(cwd)}&source=${encodeURIComponent(source)}`, { method: 'DELETE' }).catch(() => undefined);
    loadPackages();
  };

  useEffect(() => {
    fetch(`/api/resources?cwd=${encodeURIComponent(cwd)}`)
      .then(async (r) => {
        const d = await r.json();
        if (r.ok) {
          setData(d);
          setError(undefined);
        } else setError(d.error ?? 'failed');
      })
      .catch((e) => setError(String(e)));
  }, [cwd]);

  return (
    <div className="panel-page">
      <div className="panel-header">
        <h2>{t('resourcesTitle')}</h2>
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
      {error && <div className="msg-error">{error}</div>}
      {data && (
        <>
          <h3 className="section-title">{t('skillsSection')} ({data.skills.length})</h3>
          <div className="provider-list">
            {data.skills.map((s) => (
              <div key={s.filePath} className="provider-card" style={{ padding: '10px 14px' }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <span style={{ fontWeight: 600 }}>{s.name}</span>
                  {s.scope && <span className="tag">{s.scope}</span>}
                </div>
                {s.description && <div className="dim" style={{ marginTop: 4 }}>{s.description}</div>}
                <div className="dim mono" style={{ marginTop: 4, fontSize: 11 }}>{s.filePath}</div>
              </div>
            ))}
            {data.skills.length === 0 && <div className="dim">—</div>}
          </div>

          <h3 className="section-title">{t('installedPackages')} ({packages.length})</h3>
          <div className="key-row" style={{ marginBottom: 10 }}>
            <input
              value={installSource}
              placeholder={t('installPlaceholder')}
              onChange={(e) => setInstallSource(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void install()}
            />
            <button className="btn btn-sm" disabled={busy} onClick={() => void install()}>{t('install')}</button>
          </div>
          {pkgNotice && <div className="panel-notice">{pkgNotice}</div>}
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

          <h3 className="section-title">{t('extensionsSection')} ({data.extensions.length})</h3>
          <div className="provider-list">
            {data.extensions.map((e) => (
              <div key={e.path} className="provider-card" style={{ padding: '10px 14px' }}>
                <span className="mono" style={{ fontSize: 12 }}>{e.path}</span>
                {e.scope && <span className="tag" style={{ marginLeft: 8 }}>{e.scope}</span>}
              </div>
            ))}
            {data.extensions.length === 0 && <div className="dim">—</div>}
          </div>

          <h3 className="section-title">{t('promptsSection')} ({data.prompts.length})</h3>
          <div className="provider-list">
            {data.prompts.map((p) => (
              <div key={p.filePath} className="provider-card" style={{ padding: '10px 14px' }}>
                <span style={{ fontWeight: 600 }}>/{p.name}</span>
                {p.description && <span className="dim" style={{ marginLeft: 10 }}>{p.description}</span>}
              </div>
            ))}
            {data.prompts.length === 0 && <div className="dim">—</div>}
          </div>
        </>
      )}
    </div>
  );
}
