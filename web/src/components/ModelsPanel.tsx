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
  const [addingProvider, setAddingProvider] = useState(false);
  const [newProvider, setNewProvider] = useState({ id: '', name: '', baseUrl: '', api: 'openai-completions', apiKey: '', models: '' });
  const [addError, setAddError] = useState<string>();

  const addProvider = async () => {
    const models = newProvider.models
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [id, name, ctx] = line.split(',').map((x) => x.trim());
        return {
          id,
          name: name || id,
          reasoning: true,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: Number(ctx) || 128000,
          maxTokens: 8192,
        };
      });
    const res = await fetch('/api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: newProvider.id.trim(),
        name: newProvider.name.trim() || undefined,
        baseUrl: newProvider.baseUrl.trim(),
        api: newProvider.api,
        apiKey: newProvider.apiKey.trim() || undefined,
        models,
      }),
    });
    const d = (await res.json()) as { ok?: boolean; error?: string };
    if (res.ok) {
      setAddingProvider(false);
      setAddError(undefined);
      setNewProvider({ id: '', name: '', baseUrl: '', api: 'openai-completions', apiKey: '', models: '' });
      refresh();
    } else {
      setAddError(d.error ?? 'failed');
    }
  };

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
      <div style={{ marginBottom: 12 }}>
        <button className="btn btn-sm" onClick={() => setAddingProvider((v) => !v)}>
          ＋ {t('addProvider')}
        </button>
      </div>
      {addingProvider && (
        <div className="provider-card" style={{ padding: '12px 14px', marginBottom: 12 }}>
          <div className="key-row">
            <input placeholder={t('providerId')} value={newProvider.id} onChange={(e) => setNewProvider({ ...newProvider, id: e.target.value })} />
            <input placeholder={t('providerName')} value={newProvider.name} onChange={(e) => setNewProvider({ ...newProvider, name: e.target.value })} />
          </div>
          <div className="key-row" style={{ marginTop: 8 }}>
            <input placeholder={t('providerBaseUrl')} value={newProvider.baseUrl} onChange={(e) => setNewProvider({ ...newProvider, baseUrl: e.target.value })} />
            <select
              value={newProvider.api}
              onChange={(e) => setNewProvider({ ...newProvider, api: e.target.value })}
              style={{ border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: '6px 10px', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)' }}
            >
              <option value="openai-completions">openai-completions</option>
              <option value="openai-responses">openai-responses</option>
              <option value="anthropic-messages">anthropic-messages</option>
              <option value="google-generative-ai">google-generative-ai</option>
              <option value="mistral-conversations">mistral-conversations</option>
            </select>
          </div>
          <div className="key-row" style={{ marginTop: 8 }}>
            <input type="password" placeholder={t('providerKey')} value={newProvider.apiKey} onChange={(e) => setNewProvider({ ...newProvider, apiKey: e.target.value })} />
          </div>
          <textarea
            placeholder={t('providerModels')}
            value={newProvider.models}
            onChange={(e) => setNewProvider({ ...newProvider, models: e.target.value })}
            rows={3}
            style={{
              width: '100%', marginTop: 8, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
              padding: '7px 10px', fontSize: 12.5, fontFamily: 'var(--ds-font-family-code)',
              background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', outline: 'none', resize: 'vertical',
            }}
          />
          {addError && <div className="msg-error">{addError}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
            <button className="btn btn-sm" onClick={() => setAddingProvider(false)}>{t('cancel')}</button>
            <button className="btn btn-sm btn-primary" style={{ width: 'auto' }} onClick={() => void addProvider()}>{t('add')}</button>
          </div>
        </div>
      )}
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
