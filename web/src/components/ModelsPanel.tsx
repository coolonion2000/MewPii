import { useEffect, useState } from 'react';
import { fetchModels, type ModelsResponse } from '../api';
import OAuthDialog from './OAuthDialog';
import { t } from '../i18n';

export default function ModelsPanel() {
  const [data, setData] = useState<ModelsResponse | undefined>();
  const [error, setError] = useState<string>();
  const [editingProvider, setEditingProvider] = useState<string>();
  const [keyDraft, setKeyDraft] = useState('');
  const [notice, setNotice] = useState<string>();
  const [filter, setFilter] = useState('');
  const [oauthProvider, setOauthProvider] = useState<string>();

  const refresh = () => {
    fetchModels()
      .then((d) => {
        setData(d);
        setError(undefined);
      })
      .catch((e) => setError(String(e)));
  };
  useEffect(refresh, []);

  const saveKey = async (provider: string) => {
    const key = keyDraft.trim();
    if (!key) return;
    const res = await fetch('/api/auth/key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, key }),
    });
    const body = (await res.json()) as { ok?: boolean; runtimeOnly?: boolean; error?: string };
    if (res.ok && body.ok) {
      setNotice(body.runtimeOnly ? `${provider}: ${t('keySaved')} (runtime only)` : `${provider}: ${t('keySaved')}`);
      setEditingProvider(undefined);
      setKeyDraft('');
      refresh();
    } else {
      setNotice(body.error ?? 'failed');
    }
  };

  const logout = async (provider: string) => {
    await fetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider }),
    }).catch(() => undefined);
    refresh();
  };

  const providers = (data?.providers ?? [])
    .filter((p) => !filter || p.id.includes(filter) || p.name.toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => Number(b.configured) - Number(a.configured) || b.modelCount - a.modelCount);

  return (
    <div className="panel-page">
      <div className="panel-header">
        <h2>{t('modelsTitle')}</h2>
        <input
          className="panel-search"
          placeholder="filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      {error && <div className="msg-error">{error}</div>}
      {notice && <div className="panel-notice">{notice}</div>}
      <div className="provider-list">
        {providers.map((p) => {
          const models = (data?.models ?? []).filter((m) => m.provider === p.id);
          return (
            <div key={p.id} className="provider-card">
              <div className="provider-head">
                <span className={`badge ${p.configured ? 'ok' : ''}`}>
                  {p.configured ? t('configured') : t('notConfigured')}
                </span>
                <span className="provider-name">{p.name}</span>
                <span className="dim">{p.id} · {p.modelCount} models{p.authSource ? ` · ${t('authSource')}: ${p.authSource}` : ''}</span>
                <span className="spacer" />
                {p.configured && (
                  <button className="btn btn-sm" onClick={() => void logout(p.id)}>{t('logout')}</button>
                )}
                {(p as { hasOAuth?: boolean }).hasOAuth && (
                  <button className="btn btn-sm" onClick={() => setOauthProvider(p.id)}>{t('loginOAuth')}</button>
                )}
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    setEditingProvider(editingProvider === p.id ? undefined : p.id);
                    setKeyDraft('');
                  }}
                >
                  {t('setKey')}
                </button>
              </div>
              {editingProvider === p.id && (
                <div className="key-row">
                  <input
                    type="password"
                    autoFocus
                    value={keyDraft}
                    placeholder={`${p.name} API key`}
                    onChange={(e) => setKeyDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void saveKey(p.id);
                      if (e.key === 'Escape') setEditingProvider(undefined);
                    }}
                  />
                  <button className="btn btn-sm" onClick={() => void saveKey(p.id)}>{t('saveKey')}</button>
                  <button className="btn btn-sm" onClick={() => setEditingProvider(undefined)}>{t('cancel')}</button>
                </div>
              )}
              {models.length > 0 && (
                <div className="model-list">
                  {models.slice(0, 30).map((m) => (
                    <div key={m.id} className={`model-row ${m.hasAuth ? '' : 'dimmed'}`}>
                      <span className="model-name">{m.name}</span>
                      <span className="dim mono">{m.id}</span>
                      <span className="tags">
                        {m.reasoning && <span className="tag">{t('reasoning')}</span>}
                        {m.input.includes('image') && <span className="tag">{t('image')}</span>}
                        {m.contextWindow ? <span className="tag">{Math.round(m.contextWindow / 1024)}k</span> : null}
                      </span>
                    </div>
                  ))}
                  {models.length > 30 && <div className="dim" style={{ padding: '4px 10px' }}>… {models.length - 30} more</div>}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {oauthProvider && (
        <OAuthDialog
          provider={oauthProvider}
          providerName={providers.find((p) => p.id === oauthProvider)?.name ?? oauthProvider}
          onClose={(success) => {
            setOauthProvider(undefined);
            if (success) refresh();
          }}
        />
      )}
    </div>
  );
}
