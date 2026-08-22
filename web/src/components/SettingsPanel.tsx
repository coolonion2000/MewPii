import { useEffect, useState } from 'react';
import { fetchModels, type ModelsResponse } from '../api';
import { getLang, setLang, t } from '../i18n';

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
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    fetch('/api/settings').then((r) => r.json()).then(setSettings).catch(() => undefined);
    fetchModels().then(setModels).catch(() => undefined);
  }, []);

  const update = async (patch: Record<string, unknown>) => {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      setSettings((prev) => ({ ...prev, ...patch }) as PiSettings);
      setNotice(t('keySaved'));
      setTimeout(() => setNotice(undefined), 2000);
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
            onChange={(e) => {
              const [provider, ...rest] = e.target.value.split('/');
              if (provider && rest.length) void update({ defaultProvider: provider, defaultModel: rest.join('/') });
            }}
          >
            <option value="">{t('unset')}</option>
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
            onClick={() => void update({ compactionEnabled: settings?.compaction?.enabled === false })}
          />
        </div>
      </div>
    </div>
  );
}
