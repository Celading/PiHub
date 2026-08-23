import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type PiAgentSettingsInfo } from '../api/client.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { ChannelsSection } from './ChannelsSection.js';
import './PiAgentSection.css';

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

function objectFromJson(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('settings.json must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function stringSetting(settings: Record<string, unknown>, key: string): string {
  const value = settings[key];
  return typeof value === 'string' ? value : '';
}

export function PiAgentSection(): React.JSX.Element {
  const { t } = useI18n();
  const [info, setInfo] = useState<PiAgentSettingsInfo | null>(null);
  const [settingsText, setSettingsText] = useState('{}');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [thinking, setThinking] = useState('medium');
  const [prompt, setPrompt] = useState('');
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const applyInfo = useCallback((next: PiAgentSettingsInfo): void => {
    setInfo(next);
    setSettingsText(JSON.stringify(next.settings, null, 2));
    setProvider(stringSetting(next.settings, 'defaultProvider'));
    setModel(stringSetting(next.settings, 'defaultModel'));
    setThinking(stringSetting(next.settings, 'defaultThinkingLevel') || 'medium');
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const [settings, systemPrompt] = await Promise.all([
        api.piAgentSettings(),
        api.systemPrompt(),
      ]);
      applyInfo(settings);
      setPrompt(systemPrompt.prompt);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [applyInfo]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveSettings = useCallback(
    async (settings: Record<string, unknown>): Promise<void> => {
      setSaving(true);
      setError(null);
      setNotice(null);
      try {
        const result = await api.savePiAgentSettings(settings);
        const refreshed = await api.piAgentSettings();
        applyInfo(refreshed);
        setNotice(
          result.reload === 'deferred'
            ? t('settings.piAgent.savedDeferred')
            : t('settings.piAgent.saved'),
        );
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setSaving(false);
      }
    },
    [applyInfo, t],
  );

  const saveDefaults = useCallback(async (): Promise<void> => {
    try {
      const next = objectFromJson(settingsText);
      const patch = (key: string, value: string): void => {
        const trimmed = value.trim();
        if (trimmed.length === 0) {
          Reflect.deleteProperty(next, key);
        } else {
          next[key] = trimmed;
        }
      };
      patch('defaultProvider', provider);
      patch('defaultModel', model);
      patch('defaultThinkingLevel', thinking);
      await saveSettings(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [model, provider, saveSettings, settingsText, thinking]);

  const saveAdvanced = useCallback(async (): Promise<void> => {
    try {
      await saveSettings(objectFromJson(settingsText));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [saveSettings, settingsText]);

  const savePrompt = useCallback(async (): Promise<void> => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.saveSystemPrompt(prompt);
      if (!result.success) {
        throw new Error(result.error ?? 'system prompt save failed');
      }
      setNotice(t('settings.piAgent.promptSaved'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }, [prompt, t]);

  const restart = useCallback(async (): Promise<void> => {
    setRestarting(true);
    setError(null);
    setNotice(null);
    try {
      await api.restartPiAgent();
      await refresh();
      setNotice(t('settings.piAgent.restarted'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRestarting(false);
    }
  }, [refresh, t]);

  const runtimeLabel = useMemo(() => {
    if (info === null) return t('settings.loading');
    const version = info.runtime?.version ?? info.managed?.version ?? '—';
    // The bridge can briefly own a child handle while a missing executable is
    // failing/retrying. Capability availability is the hard prerequisite so
    // this page cannot contradict the header with a false "running" state.
    const runtimeAvailable = info.runtime?.available === true;
    const state = runtimeAvailable && info.managed?.running === true
      ? t('settings.agents.running')
      : runtimeAvailable
        ? t('settings.agents.ready')
        : t('settings.agents.missing');
    return `Pi ${version} · Node ${info.nodeVersion} · ${state}`;
  }, [info, t]);

  return (
    <div className="pi-agent-settings">
      {error !== null ? <p className="settings-error mono" role="alert">{error}</p> : null}
      {notice !== null ? <p className="pi-agent-notice mono" role="status">{notice}</p> : null}

      <section className="settings-section pi-agent-hero">
        <div>
          <h2 className="settings-section-title mono">{t('settings.piAgent.runtime')}</h2>
          <p className="pi-agent-runtime mono">{runtimeLabel}</p>
          <p className="settings-hint">{t('settings.piAgent.hint')}</p>
        </div>
        <button
          type="button"
          className="btn-primary mono"
          disabled={restarting || info === null}
          onClick={() => { void restart(); }}
        >
          {restarting ? '…' : t('settings.agents.restart')}
        </button>
      </section>

      <section className="settings-section">
        <h2 className="settings-section-title mono">{t('settings.piAgent.paths')}</h2>
        <div className="settings-list">
          <div className="setting-row">
            <span className="setting-label mono">{t('settings.piAgent.workspace')}</span>
            <span className="setting-value mono">{info?.workspace ?? '—'}</span>
          </div>
          <div className="setting-row">
            <span className="setting-label mono">{t('settings.piAgent.home')}</span>
            <span className="setting-value mono">{info?.agentHome ?? '—'}</span>
          </div>
          <div className="setting-row">
            <span className="setting-label mono">settings.json</span>
            <span className="setting-value mono">{info?.settingsFile ?? '—'}</span>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h2 className="settings-section-title mono">{t('settings.piAgent.defaults')}</h2>
        <div className="pi-agent-fields">
          <label className="channel-field">
            <span className="channel-label mono">{t('settings.piAgent.provider')}</span>
            <input
              className="channel-input mono"
              value={provider}
              onChange={(event) => {
                setProvider(event.target.value);
              }}
            />
          </label>
          <label className="channel-field">
            <span className="channel-label mono">{t('settings.piAgent.model')}</span>
            <input
              className="channel-input mono"
              value={model}
              onChange={(event) => {
                setModel(event.target.value);
              }}
            />
          </label>
          <label className="channel-field">
            <span className="channel-label mono">{t('settings.piAgent.thinking')}</span>
            <select
              className="channel-input mono"
              value={thinking}
              onChange={(event) => {
                setThinking(event.target.value);
              }}
            >
              {THINKING_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
            </select>
          </label>
        </div>
        <button type="button" className="btn-primary mono" disabled={saving || info === null} onClick={() => { void saveDefaults(); }}>
          {saving ? '…' : t('settings.piAgent.saveDefaults')}
        </button>
      </section>

      <section className="settings-section">
        <h2 className="settings-section-title mono">{t('settings.nav.systemPrompt')}</h2>
        <p className="settings-hint">{t('settings.systemPrompt.hint')}</p>
        <textarea
          className="system-prompt-edit mono"
          rows={10}
          value={prompt}
          onChange={(event) => {
            setPrompt(event.target.value);
          }}
        />
        <button type="button" className="btn-primary mono" disabled={saving || info === null} onClick={() => { void savePrompt(); }}>
          {saving ? '…' : t('settings.piAgent.savePrompt')}
        </button>
      </section>

      <section className="settings-section">
        <h2 className="settings-section-title mono">{t('settings.piAgent.advanced')}</h2>
        <p className="settings-hint">{t('settings.piAgent.advancedHint')}</p>
        <textarea
          className="pi-agent-json mono"
          rows={16}
          value={settingsText}
          onChange={(event) => {
            setSettingsText(event.target.value);
          }}
          spellCheck={false}
        />
        <button type="button" className="btn-primary mono" disabled={saving || info === null} onClick={() => { void saveAdvanced(); }}>
          {saving ? '…' : t('settings.piAgent.saveAdvanced')}
        </button>
      </section>

      <section className="settings-section">
        <h2 className="settings-section-title mono">{t('settings.piAgent.channels')}</h2>
        <p className="settings-hint">{t('settings.piAgent.channelsHint')}</p>
        <ChannelsSection />
      </section>

      <section className="settings-section pi-agent-security">
        <h2 className="settings-section-title mono">{t('settings.piAgent.security')}</h2>
        <p className="settings-hint">{t('settings.piAgent.securityHint')}</p>
      </section>
    </div>
  );
}
