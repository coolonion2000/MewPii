import { useEffect, useState } from 'react';
import { t } from '../i18n';

interface Resources {
  skills: { name: string; description: string; filePath: string; source?: string; scope?: string }[];
  extensions: { path: string; source?: string; scope?: string }[];
  prompts: { name: string; description?: string; filePath: string }[];
}

export default function ResourcesPanel({ cwd: initialCwd }: { cwd: string }) {
  const [cwd, setCwd] = useState(initialCwd);
  const [cwdDraft, setCwdDraft] = useState(initialCwd);
  const [data, setData] = useState<Resources | undefined>();
  const [error, setError] = useState<string>();

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
