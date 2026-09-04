import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchModels, type ModelsResponse } from '../api';
import { getLang, setLang, t } from '../i18n';
import { MODEL_CATALOG_CHANGED_EVENT } from '../ui-reliability';

interface PiSettings {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
  steeringMode?: string;
  followUpMode?: string;
  compaction?: { enabled?: boolean };
  hideThinkingBlock?: boolean;
}

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

interface Props {
  dark: boolean;
  onToggleTheme: () => void;
}

export default function SettingsPanel({ dark, onToggleTheme }: Props) {
  const [settings, setSettings] = useState<PiSettings | undefined>();
  const [models, setModels] = useState<ModelsResponse | undefined>();
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [settingsError, setSettingsError] = useState<string>();
  const [modelsError, setModelsError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const generation = useRef({ settings: 0, models: 0 });
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const focusRefreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const loadSettings = useCallback(async () => {
    const request = ++generation.current.settings;
    setSettingsLoading(true);
    setSettingsError(undefined);
    try {
      const response = await fetch('/api/settings');
      if (!response.ok) throw new Error(`settings: ${response.status}`);
      const next = await response.json() as PiSettings;
      if (request === generation.current.settings) setSettings(next);
    } catch (cause) {
      if (request === generation.current.settings)
        setSettingsError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === generation.current.settings) setSettingsLoading(false);
    }
  }, []);

  const loadModels = useCallback(async (force = false) => {
    const request = ++generation.current.models;
    setModelsLoading(true);
    setModelsError(undefined);
    try {
      const next = await fetchModels(force);
      if (request === generation.current.models) setModels(next);
    } catch (cause) {
      if (request === generation.current.models)
        setModelsError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === generation.current.models) setModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
    void loadModels();
    const onCatalogChanged = () => void loadModels();
    const onFocus = () => {
      clearTimeout(focusRefreshTimer.current);
      focusRefreshTimer.current = setTimeout(() => void loadModels(true), 80);
    };
    const onVisible = () => {
      if (!document.hidden) onFocus();
    };
    window.addEventListener(MODEL_CATALOG_CHANGED_EVENT, onCatalogChanged);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      generation.current.settings += 1;
      generation.current.models += 1;
      clearTimeout(noticeTimer.current);
      clearTimeout(focusRefreshTimer.current);
      window.removeEventListener(MODEL_CATALOG_CHANGED_EVENT, onCatalogChanged);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [loadModels, loadSettings]);

  const update = async (patch: Record<string, unknown>) => {
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        setSettings((previous) => {
          const next = { ...previous, ...patch } as PiSettings;
          if (typeof patch.compactionEnabled === 'boolean') {
            next.compaction = {
              ...previous?.compaction,
              enabled: patch.compactionEnabled,
            };
          }
          return next;
        });
        setNotice(t('keySaved'));
        setSettingsError(undefined);
        clearTimeout(noticeTimer.current);
        noticeTimer.current = setTimeout(() => setNotice(undefined), 2000);
      } else {
        let detail = `${res.status}`;
        try {
          const body = await res.json() as { error?: string };
          detail = body.error ?? detail;
        } catch {
          // Keep the HTTP status when the response is not JSON.
        }
        setSettingsError(detail);
      }
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const configuredModels = models?.models.filter((m) => m.hasAuth) ?? [];
  const currentDefault = settings?.defaultProvider && settings?.defaultModel
    ? `${settings.defaultProvider}/${settings.defaultModel}`
    : '';

  return (
    <div className="panel-page" style={{ maxWidth: 720 }}>
      <div className="panel-header"><h2>{t('settingsTitle')}</h2></div>
      {notice && <div className="panel-notice">{notice}</div>}
      {settingsError && (
        <div className="model-load-error" role="alert">
          <span>{settingsError}</span>
          <button className="btn btn-sm" onClick={() => void loadSettings()}>{t('retry')}</button>
        </div>
      )}
      {modelsError && (
        <div className="model-load-error" role="alert">
          <span>{t('modelLoadFailed')}: {modelsError}</span>
          <button className="btn btn-sm" onClick={() => void loadModels(true)}>{t('retry')}</button>
        </div>
      )}

      <div className="settings-section">
        <h3 className="section-title">{t('appSettings')}</h3>
        <div className="settings-row">
          <span className="label">{t('theme')}</span>
          <select value={dark ? 'dark' : 'light'} onChange={() => onToggleTheme()}>
            <option value="dark">{t('themeDark')}</option>
            <option value="light">{t('themeLight')}</option>
          </select>
        </div>
        <div className="settings-row">
          <span className="label">{t('language')}</span>
          <select value={getLang()} onChange={(e) => setLang(e.target.value as 'zh' | 'en')}>
            <option value="zh">中文</option>
            <option value="en">English</option>
          </select>
        </div>
      </div>

      <div className="settings-section">
        <h3 className="section-title">{t('piSettings')}</h3>
        <div className="settings-row">
          <span className="label">{t('defaultModel')}</span>
          <select
            value={currentDefault}
            disabled={settingsLoading || modelsLoading}
            onChange={(e) => {
              const [provider, ...rest] = e.target.value.split('/');
              if (provider && rest.length) void update({ defaultProvider: provider, defaultModel: rest.join('/') });
            }}
          >
            <option value="">{modelsLoading ? t('loadingModels') : t('unset')}</option>
            {currentDefault && !configuredModels.some((m) => `${m.provider}/${m.id}` === currentDefault) && (
              <option value={currentDefault}>{currentDefault}</option>
            )}
            {configuredModels.map((m) => (
              <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                {m.name} ({m.provider})
              </option>
            ))}
          </select>
        </div>
        <div className="settings-row">
          <span className="label">{t('defaultThinking')}</span>
          <select
            value={settings?.defaultThinkingLevel ?? ''}
            disabled={settingsLoading}
            onChange={(e) => void update({ defaultThinkingLevel: e.target.value })}
          >
            <option value="">{t('unset')}</option>
            {THINKING_LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
        <div className="settings-row">
          <span className="label">{t('steeringMode')}</span>
          <select
            value={settings?.steeringMode ?? ''}
            disabled={settingsLoading}
            onChange={(e) => void update({ steeringMode: e.target.value })}
          >
            <option value="">{t('unset')}</option>
            <option value="all">{t('modeAll')}</option>
            <option value="one-at-a-time">{t('modeOne')}</option>
          </select>
        </div>
        <div className="settings-row">
          <span className="label">{t('followUpMode')}</span>
          <select
            value={settings?.followUpMode ?? ''}
            disabled={settingsLoading}
            onChange={(e) => void update({ followUpMode: e.target.value })}
          >
            <option value="">{t('unset')}</option>
            <option value="all">{t('modeAll')}</option>
            <option value="one-at-a-time">{t('modeOne')}</option>
          </select>
        </div>
        <div className="settings-row">
          <span className="label">{t('compactionEnabled')}</span>
          <button
            className={`toggle ${settings?.compaction?.enabled !== false ? 'on' : ''}`}
            disabled={settingsLoading}
            onClick={() => void update({ compactionEnabled: settings?.compaction?.enabled === false })}
          />
        </div>
      </div>
    </div>
  );
}
