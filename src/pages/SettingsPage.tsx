import { useCallback, useEffect, useState } from 'react';
import type { ModelInfo, SessionSummary } from '../../shared/types.js';
import { api } from '../api/client.js';
import { useI18n, type Locale } from '../i18n/I18nProvider.js';
import { ChannelsSection } from './ChannelsSection.js';
import './SettingsPage.css';

const ARCHIVED_STORAGE_KEY = 'pi-panel:archived';

function loadArchivedIds(): string[] {
  try {
    const raw = localStorage.getItem(ARCHIVED_STORAGE_KEY);
    if (raw === null) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

function persistArchivedIds(ids: string[]): void {
  try {
    localStorage.setItem(ARCHIVED_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // storage unavailable — restore still works for this session
  }
}

interface SettingsPageProps {
  onBack: () => void;
}

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

type SectionId = 'language' | 'agent' | 'models' | 'channels' | 'archived';

export function SettingsPage({ onBack }: SettingsPageProps): React.JSX.Element {
  const { t, locale, setLocale } = useI18n();
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  const [providers, setProviders] = useState<Array<{ provider: string; models: ModelInfo[] }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<SectionId>('language');
  const [archivedIds, setArchivedIds] = useState<string[]>(() => loadArchivedIds());
  const [sessions, setSessions] = useState<SessionSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const [settingsRes, modelsRes, sessionsRes] = await Promise.all([
          api.settings(),
          api.models(),
          api.sessions(),
        ]);
        if (!cancelled) {
          setSettings(settingsRes);
          setProviders(modelsRes.providers);
          setSessions(sessionsRes.sessions);
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

  const restoreSession = (id: string): void => {
    const next = archivedIds.filter((archivedId) => archivedId !== id);
    setArchivedIds(next);
    persistArchivedIds(next);
    window.dispatchEvent(new CustomEvent('pihub:archived-changed', { detail: next }));
  };

  // Stay in sync when the sidebar archives a session while this page is open.
  useEffect(() => {
    const syncArchived = (event: Event): void => {
      const detail = (event as CustomEvent<string[]>).detail;
      if (Array.isArray(detail)) {
        setArchivedIds(detail);
      }
    };
    window.addEventListener('pihub:archived-changed', syncArchived);
    return () => {
      window.removeEventListener('pihub:archived-changed', syncArchived);
    };
  }, []);

  const scrollToSection = useCallback((section: SectionId): void => {
    setActiveSection(section);
    const element = document.getElementById(`settings-section-${section}`);
    element?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const treeItems: ReadonlyArray<{ id: SectionId; label: string }> = [
    { id: 'language', label: t('settings.language') },
    { id: 'agent', label: t('settings.agent') },
    { id: 'models', label: t('settings.modelStore') },
    { id: 'channels', label: t('settings.channels') },
    { id: 'archived', label: t('settings.archived') },
  ];

  return (
    <section className="settings-page">
      <div className="settings-head">
        <h1 className="panel-title">{t('settings.title')}</h1>
        <p className="settings-head-hint mono">{t('settings.readonly')}</p>
      </div>

      {error !== null ? <div className="settings-error mono">{error}</div> : null}

      <div className="settings-layout">
        <nav className="settings-tree" aria-label="Settings sections">
          {treeItems.map((item, index) => (
            <button
              key={item.id}
              type="button"
              className="settings-tree-item"
              data-active={activeSection === item.id}
              onClick={() => {
                scrollToSection(item.id);
              }}
            >
              <span className="settings-tree-number mono">0{String(index + 1)}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="settings-content">
          <section id="settings-section-language" className="settings-section">
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

          <section id="settings-section-agent" className="settings-section">
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

          <section id="settings-section-models" className="settings-section">
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

          <section id="settings-section-channels" className="settings-section">
            <ChannelsSection />
          </section>

          <section id="settings-section-archived" className="settings-section">
            <h2 className="settings-section-title mono">{t('settings.archived')}</h2>
            {archivedIds.length === 0 ? (
              <p className="settings-hint">{t('settings.emptyArchived')}</p>
            ) : (
              <div className="settings-list">
                {archivedIds.map((id) => {
                  const session = sessions.find((entry) => entry.id === id);
                  if (session === undefined) {
                    return null;
                  }
                  return (
                    <div key={id} className="setting-row">
                      <span className="setting-label mono">{session.name ?? session.fileName}</span>
                      <span className="setting-value mono">{session.cwd}</span>
                      <button
                        type="button"
                        className="setting-restore"
                        onClick={() => {
                          restoreSession(id);
                        }}
                      >
                        {t('settings.restore')}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>

      <button type="button" className="settings-back-bar" onClick={onBack}>
        <span className="hico hico-arrow-left" aria-hidden="true" />
        <span>{t('settings.back')}</span>
      </button>
    </section>
  );
}
