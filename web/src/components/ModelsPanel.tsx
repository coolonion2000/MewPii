import { useEffect, useMemo, useState } from 'react';
import { fetchModels, type ModelsResponse } from '../api';
import OAuthDialog from './OAuthDialog';
import { t } from '../i18n';
import { evaluateProviderLogout } from '../model-utils';

export default function ModelsPanel() {
  const [data, setData] = useState<ModelsResponse | undefined>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [filter, setFilter] = useState('');
  const [editingKey, setEditingKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');
  const [notice, setNotice] = useState<string>();
  const [oauthProvider, setOauthProvider] = useState<string>();
  const [addingProvider, setAddingProvider] = useState(false);
  const [newProvider, setNewProvider] = useState({ id: '', name: '', baseUrl: '', api: 'openai-completions', apiKey: '', models: '' });
  const [addError, setAddError] = useState<string>();

  const refresh = () => {
    fetchModels()
      .then((d) => {
        setData(d);
        setError(undefined);
        setSelected((prev) =>
          prev && d.providers.some((p) => p.id === prev)
            ? prev
            : [...d.providers].sort((a, b) => Number(b.configured) - Number(a.configured))[0]?.id,
        );
      })
      .catch((e) => setError(String(e)));
  };
  useEffect(refresh, []); // eslint-disable-line react-hooks/exhaustive-deps

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
      setEditingKey(false);
      setKeyDraft('');
      refresh();
    } else {
      setNotice(body.error ?? 'failed');
    }
  };

  const logout = async (provider: string) => {
    try {
      const response = await fetch('/api/auth/provider/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });
      const body = (await response.json()) as { ok?: boolean; error?: string };
      const outcome = evaluateProviderLogout(
        provider,
        t('logout'),
        response.ok,
        response.status,
        body,
      );
      setNotice(outcome.notice);
      if (!outcome.ok) return;
      refresh();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    }
  };

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

  const providers = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (data?.providers ?? [])
      .filter((p) => !q || p.id.includes(q) || p.name.toLowerCase().includes(q))
      .sort((a, b) => Number(b.configured) - Number(a.configured) || b.modelCount - a.modelCount);
  }, [data, filter]);

  const current = data?.providers.find((p) => p.id === selected);
  const currentModels = (data?.models ?? []).filter((m) => m.provider === selected);

  return (
    <div className="mp">
      {/* master: provider list */}
      <div className="mp-rail">
        <input className="panel-search" placeholder="filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="mp-list">
          {providers.map((p) => (
            <button
              key={p.id}
              className={`mp-row ${selected === p.id ? 'active' : ''}`}
              onClick={() => {
                setSelected(p.id);
                setEditingKey(false);
                setAddingProvider(false);
              }}
            >
              <span className={`mp-dot ${p.configured ? 'ok' : ''}`} />
              <span className="mp-name">{p.name}</span>
              <span className="mp-count">{p.modelCount}</span>
            </button>
          ))}
        </div>
        <button className={`btn btn-sm mp-add ${addingProvider ? 'tab-active' : ''}`} onClick={() => setAddingProvider((v) => !v)}>
          ＋ {t('addProvider')}
        </button>
      </div>

      {/* detail */}
      <div className="mp-detail">
        {error && <div className="msg-error">{error}</div>}
        {notice && <div className="panel-notice">{notice}</div>}

        {addingProvider && (
          <div className="provider-card" style={{ padding: '12px 14px' }}>
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

        {!addingProvider && current && (
          <>
            <div className="mp-head">
              <span className="mp-head-name">{current.name}</span>
              <span className="dim mono">{current.id}</span>
              <span className={`badge ${current.configured ? 'ok' : ''}`}>
                {current.configured ? t('configured') : t('notConfigured')}
              </span>
              {current.authSource && <span className="dim">{t('authSource')}: {current.authSource}</span>}
              <span className="spacer" />
              {(current as { hasOAuth?: boolean }).hasOAuth && (
                <button className="btn btn-sm" onClick={() => setOauthProvider(current.id)}>{t('loginOAuth')}</button>
              )}
              {current.configured && <button className="btn btn-sm" onClick={() => void logout(current.id)}>{t('logout')}</button>}
              <button className="btn btn-sm" onClick={() => { setEditingKey((v) => !v); setKeyDraft(''); }}>{t('setKey')}</button>
            </div>

            {editingKey && (
              <div className="key-row" style={{ marginBottom: 12 }}>
                <input
                  type="password"
                  autoFocus
                  value={keyDraft}
                  placeholder={`${current.name} API key`}
                  onChange={(e) => setKeyDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveKey(current.id);
                    if (e.key === 'Escape') setEditingKey(false);
                  }}
                />
                <button className="btn btn-sm" onClick={() => void saveKey(current.id)}>{t('saveKey')}</button>
                <button className="btn btn-sm" onClick={() => setEditingKey(false)}>{t('cancel')}</button>
              </div>
            )}

            <div className="mp-models">
              {currentModels.map((m) => (
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
              {currentModels.length === 0 && <div className="dim" style={{ padding: 12 }}>—</div>}
            </div>
          </>
        )}

        {!addingProvider && !current && <div className="empty-state" style={{ flex: 1 }}>—</div>}
      </div>

      {oauthProvider && (
        <OAuthDialog
          provider={oauthProvider}
          providerName={data?.providers.find((p) => p.id === oauthProvider)?.name ?? oauthProvider}
          onClose={(success) => {
            setOauthProvider(undefined);
            if (success) refresh();
          }}
        />
      )}
    </div>
  );
}
