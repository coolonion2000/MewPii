import { useCallback, useEffect, useState } from 'react';
import { t } from '../i18n';

interface SkillItem {
  name: string;
  description: string;
  filePath: string;
  source?: string;
  scope?: string;
}

interface PromptItem {
  name: string;
  description?: string;
  filePath: string;
}

export default function SkillsPanel({ cwd: initialCwd }: { cwd: string }) {
  const [cwd, setCwd] = useState(initialCwd);
  const [cwdDraft, setCwdDraft] = useState(initialCwd);
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [prompts, setPrompts] = useState<PromptItem[]>([]);
  const [error, setError] = useState<string>();
  const [addingSkill, setAddingSkill] = useState(false);
  const [skillDraft, setSkillDraft] = useState({ name: '', description: '', content: '' });

  const load = useCallback(() => {
    fetch(`/api/resources?cwd=${encodeURIComponent(cwd)}`)
      .then(async (r) => {
        const d = await r.json();
        if (r.ok) {
          setSkills(d.skills ?? []);
          setPrompts(d.prompts ?? []);
          setError(undefined);
        } else setError(d.error ?? 'failed');
      })
      .catch((e) => setError(String(e)));
  }, [cwd]);

  useEffect(load, [load]);

  const addSkill = async () => {
    if (!skillDraft.name.trim()) return;
    const res = await fetch('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(skillDraft),
    });
    if (res.ok) {
      setAddingSkill(false);
      setSkillDraft({ name: '', description: '', content: '' });
      load();
    }
  };

  const deleteSkill = async (filePath: string) => {
    if (!confirm(t('confirmDeleteSkill'))) return;
    await fetch(`/api/skills?path=${encodeURIComponent(filePath)}`, { method: 'DELETE' }).catch(() => undefined);
    load();
  };

  return (
    <div className="panel-page">
      <div className="panel-header">
        <h2>{t('tabSkills')}</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setCwd(cwdDraft.trim() || cwd);
          }}
          style={{ flex: 1, display: 'flex' }}
        >
          <input className="panel-search mono" value={cwdDraft} onChange={(e) => setCwdDraft(e.target.value)} />
        </form>
        <button className="btn btn-sm" onClick={() => setAddingSkill((v) => !v)}>＋ {t('addSkill')}</button>
      </div>
      {error && <div className="msg-error">{error}</div>}

      {addingSkill && (
        <div className="provider-card" style={{ padding: '12px 14px', marginBottom: 10 }}>
          <div className="key-row">
            <input placeholder={t('skillName')} value={skillDraft.name} onChange={(e) => setSkillDraft({ ...skillDraft, name: e.target.value })} />
            <input placeholder={t('skillDesc')} value={skillDraft.description} onChange={(e) => setSkillDraft({ ...skillDraft, description: e.target.value })} />
          </div>
          <textarea
            placeholder={t('skillContent')}
            value={skillDraft.content}
            onChange={(e) => setSkillDraft({ ...skillDraft, content: e.target.value })}
            rows={4}
            style={{
              width: '100%', marginTop: 8, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
              padding: '7px 10px', fontSize: 12.5, fontFamily: 'inherit',
              background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', outline: 'none', resize: 'vertical',
            }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
            <button className="btn btn-sm" onClick={() => setAddingSkill(false)}>{t('cancel')}</button>
            <button className="btn btn-sm btn-primary" style={{ width: 'auto' }} onClick={() => void addSkill()}>{t('add')}</button>
          </div>
        </div>
      )}

      <h3 className="section-title">{t('skillsSection')} ({skills.length})</h3>
      <div className="provider-list">
        {skills.map((s) => (
          <div key={s.filePath} className="provider-card" style={{ padding: '10px 14px' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <span style={{ fontWeight: 600, flex: 1 }}>{s.name}</span>
              {s.scope && <span className="tag">{s.scope}</span>}
              {s.scope === 'user' && (
                <button className="btn btn-sm" onClick={() => void deleteSkill(s.filePath)}>{t('remove')}</button>
              )}
            </div>
            {s.description && <div className="dim" style={{ marginTop: 4 }}>{s.description}</div>}
            <div className="dim mono" style={{ marginTop: 4, fontSize: 11 }}>{s.filePath}</div>
          </div>
        ))}
        {skills.length === 0 && <div className="dim">—</div>}
      </div>

      <h3 className="section-title">{t('promptsSection')} ({prompts.length})</h3>
      <div className="provider-list">
        {prompts.map((p) => (
          <div key={p.filePath} className="provider-card" style={{ padding: '10px 14px' }}>
            <span style={{ fontWeight: 600 }}>/{p.name}</span>
            {p.description && <span className="dim" style={{ marginLeft: 10 }}>{p.description}</span>}
          </div>
        ))}
        {prompts.length === 0 && <div className="dim">—</div>}
      </div>
    </div>
  );
}
