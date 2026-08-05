import { useEffect, useState } from 'react';
import type { ModelInfo } from '../../shared/types.js';
import { api } from '../api/client.js';
import { useI18n, type Locale } from '../i18n/I18nProvider.js';
import './SettingsPage.css';

function SettingRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="setting-row">
      <span className="setting-label mono">{label}</span>
      <span className="setting-value mono">{value}</span>
    </div>
  );
}

function ModelCard({ model }: { model: ModelInfo }): React.JSX.Element {
  const cost = model.cost;
  const price =
    cost === undefined
      ? ''
      : `$${cost.input.toFixed(4)}/in · $${cost.output.toFixed(4)}/out`;
  return (
    <div className="model-card">
      <div className="model-card-head">
        <span className="model-card-name">{model.name}</span>
        <span className="model-card-id mono">{model.id}</span>
      </div>
      <div className="model-card-meta mono">
        <span>{model.provider}</span>
        <span>{model.api}</span>
        {model.contextWindow !== undefined ? (
          <span>ctx {String(model.contextWindow)}</span>
        ) : null}
        {model.maxTokens !== undefined ? <span>max {String(model.maxTokens)}</span> : null}
      </div>
      {price.length > 0 ? <div className="model-card-price mono">{price}</div> : null}
    </div>
  );
}

const LOCALE_OPTIONS: ReadonlyArray<{ value: Locale; label: string }> = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
];

export function SettingsPage(): React.JSX.Element {
  const { t, locale, setLocale } = useI18n();
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  const [providers, setProviders] = useState<Array<{ provider: string; models: ModelInfo[] }>>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const [settingsRes, modelsRes] = await Promise.all([api.settings(), api.models()]);
        if (!cancelled) {
          setSettings(settingsRes);
          setProviders(modelsRes.providers);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="settings-page">
      <div className="settings-head">
        <h1 className="panel-title">{t('settings.title')}</h1>
        <p className="settings-head-hint mono">{t('settings.readonly')}</p>
      </div>

      {error !== null ? <div className="settings-error mono">{error}</div> : null}

      <section className="settings-section">
        <h2 className="settings-section-title mono">{t('settings.language')}</h2>
        <div className="settings-language">
          {LOCALE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className="settings-language-btn"
              data-active={locale === option.value}
              onClick={() => {
                setLocale(option.value);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      </section>

      <section className="settings-section">
        <h2 className="settings-section-title mono">{t('settings.agent')}</h2>
        <div className="settings-list">
          {settings === null ? (
            <p className="settings-hint">{t('settings.loading')}</p>
          ) : Object.entries(settings).length === 0 ? (
            <p className="settings-hint">{t('settings.empty')}</p>
          ) : (
            Object.entries(settings).map(([key, value]) => (
              <SettingRow key={key} label={key} value={JSON.stringify(value)} />
            ))
          )}
        </div>
      </section>

      <section className="settings-section">
        <h2 className="settings-section-title mono">{t('settings.modelStore')}</h2>
        {providers.length === 0 ? (
          <p className="settings-hint">{t('settings.emptyModels')}</p>
        ) : (
          providers.map((entry) => (
            <div key={entry.provider} className="settings-provider">
              <div className="settings-provider-label mono">{entry.provider}</div>
              <div className="settings-provider-models">
                {entry.models.map((model) => (
                  <ModelCard key={model.id} model={model} />
                ))}
              </div>
            </div>
          ))
        )}
      </section>
    </section>
  );
}
