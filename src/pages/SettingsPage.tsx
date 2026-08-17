import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModelInfo, SessionSummary } from '../../shared/types.js';
import { THEMES, type SettingsSectionId, type Theme } from '../types/app.js';
import { api } from '../api/client.js';
import {
  loadAdapterColors,
  saveAdapterColor,
  type AdapterInfo,
} from '../adapters/adapterColors.js';
import { useI18n, type Locale, type MessageKey } from '../i18n/I18nProvider.js';
import { removeArchived, restoreSession as restoreArchived } from '../sessions/sessionActions.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { LoadingHint } from '../components/LoadingHint.js';
import { SETTINGS_SECTIONS } from '../types/app.js';
import {
  getPrefs,
  PREF_CHANGED_EVENT,
  setPref,
  type CommandKey,
  type SendMode,
} from '../prefs/preferences.js';
import { ChannelsSection } from './ChannelsSection.js';
import { FavoritesSection } from './FavoritesSection.js';
import { LabSection } from './LabSection.js';
import { AboutSection } from './AboutSection.js';
import { PermissionsSection } from './PermissionsSection.js';
import './SettingsPage.css';

const ARCHIVED_STORAGE_KEY = 'pi-panel:archived';
const USER_ID_STORAGE_KEY = 'pi-panel:userId';

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

interface SettingsPageProps {
  section: SettingsSectionId;
  onSectionChange: (section: SettingsSectionId) => void;
  theme: Theme;
  /** P1-09: pick a theme directly (light / dark / fog). */
  onThemeChange: (theme: Theme) => void;
  sidebarCollapsed: boolean;
  onToggleCollapsed: () => void;
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

/**
 * Settings system prompt (owner spec): preview by default — the stored
 * prompt renders read-only; clicking 编辑 opens the textarea, 保存 persists
 * it to the PiHub home (`<home>/system-prompt.md`) and restarts pi so the
 * next spawn appends it via --append-system-prompt.
 */
function SystemPromptSection({
  onError,
}: {
  onError: (message: string | null) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [prompt, setPrompt] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api
      .systemPrompt()
      .then((result) => {
        if (!cancelled) {
          setPrompt(result.prompt);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          onError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [onError]);

  const save = async (): Promise<void> => {
    setSaving(true);
    setSaved(false);
    try {
      const result = await api.saveSystemPrompt(draft);
      if (!result.success) {
        onError(result.error ?? 'system prompt save failed');
        return;
      }
      setPrompt(draft);
      setEditing(false);
      setSaved(true);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-section">
      <h2 className="settings-section-title mono">{t('settings.nav.systemPrompt')}</h2>
      <p className="settings-hint">{t('settings.systemPrompt.hint')}</p>
      {editing ? (
        <>
          <textarea
            className="system-prompt-edit mono"
            value={draft}
            rows={14}
            aria-label={t('settings.systemPrompt.edit')}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
          />
          <div className="system-prompt-actions">
            <button
              type="button"
              className="btn-primary mono"
              disabled={saving}
              onClick={() => {
                void save();
              }}
            >
              {t('settings.systemPrompt.save')}
            </button>
            <button
              type="button"
              className="btn-secondary mono"
              disabled={saving}
              onClick={() => {
                setEditing(false);
              }}
            >
              {t('settings.systemPrompt.cancel')}
            </button>
          </div>
        </>
      ) : (
        <>
          <pre className="system-prompt-preview mono">
            {prompt === null
              ? t('settings.loading')
              : prompt.length > 0
                ? prompt
                : t('settings.systemPrompt.empty')}
          </pre>
          <p className="settings-hint">{t('settings.systemPrompt.preview')}</p>
          <div className="system-prompt-actions">
            <button
              type="button"
              className="btn-primary mono"
              onClick={() => {
                setDraft(prompt ?? '');
                setEditing(true);
                setSaved(false);
              }}
            >
              {t('settings.systemPrompt.edit')}
            </button>
            {saved ? <span className="system-prompt-saved mono">{t('settings.systemPrompt.saved')}</span> : null}
          </div>
        </>
      )}
    </section>
  );
}

export function SettingsPage({
  section,
  onSectionChange,
  theme,
  onThemeChange,
  sidebarCollapsed,
  onToggleCollapsed,
  onBack,
}: SettingsPageProps): React.JSX.Element {
  const { t, locale, setLocale } = useI18n();
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  const [providers, setProviders] = useState<Array<{ provider: string; models: ModelInfo[] }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [archivedIds, setArchivedIds] = useState<string[]>(() => loadArchivedIds());
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [userId, setUserId] = useState<string>(() => {
    return localStorage.getItem(USER_ID_STORAGE_KEY) ?? 'guest';
  });
  const [editingUser, setEditingUser] = useState(false);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [, forceRender] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<SessionSummary | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // P2-01 D: adapter appearance (metadata + per-adapter accent colors).
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [adapterColors, setAdapterColorsState] = useState<Record<string, string>>(() =>
    loadAdapterColors(),
  );
  const setAdapterColor = useCallback((kind: string, color: string): void => {
    saveAdapterColor(kind, color);
    setAdapterColorsState((prev) => ({ ...prev, [kind]: color }));
  }, []);
  // P2-02: access mode + pairing + remote capabilities.
  const [netMode, setNetMode] = useState<'local' | 'pair' | 'lan'>('local');
  const [caps, setCaps] = useState({
    remoteApprove: false,
    remotePrompt: false,
    remoteShell: false,
  });
  const [pairCode, setPairCode] = useState<string | null>(null);

  const generatePair = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const result = await api.netPair();
      setPairCode(result.code);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const revokePair = useCallback(async (code: string): Promise<void> => {
    setError(null);
    try {
      await api.netRevokePair(code);
      setPairCode(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const setCap = useCallback(
    async (key: 'remoteApprove' | 'remotePrompt' | 'remoteShell', value: boolean): Promise<void> => {
      setError(null);
      try {
        const result = await api.netSetCap(key, value);
        const next = result.caps as {
          remoteApprove: boolean;
          remotePrompt: boolean;
          remoteShell: boolean;
        };
        setCaps(next);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [],
  );
  const prefs = getPrefs();
  const [modes, setModes] = useState<{ steering: string; followUp: string }>(() => {
    try {
      const raw = localStorage.getItem('pi-panel:modes');
      if (raw !== null) {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null) {
          const record = parsed as Record<string, unknown>;
          return {
            steering:
              typeof record['steering'] === 'string' ? record['steering'] : 'one-at-a-time',
            followUp: typeof record['followUp'] === 'string' ? record['followUp'] : 'sequential',
          };
        }
      }
    } catch {
      // fall through
    }
    return { steering: 'one-at-a-time', followUp: 'sequential' };
  });

  const setMode = (key: 'steering' | 'followUp', value: string): void => {
    const next = { ...modes, [key]: value };
    setModes(next);
    try {
      localStorage.setItem('pi-panel:modes', JSON.stringify(next));
    } catch {
      // storage unavailable
    }
    void (key === 'steering' ? api.setSteeringMode(value) : api.setFollowUpMode(value)).catch(
      (err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      },
    );
  };

  // Re-render when preferences change elsewhere (send mode / cmd key).
  useEffect(() => {
    const sync = (): void => {
      forceRender((prev) => prev + 1);
    };
    window.addEventListener(PREF_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener(PREF_CHANGED_EVENT, sync);
    };
  }, []);

  const handleExportHtml = useCallback(async (): Promise<void> => {
    setExportNotice(null);
    setError(null);
    try {
      const response = await api.exportHtml();
      if (!response.success) {
        setError(response.error ?? 'export failed');
        return;
      }
      setExportNotice(t('sessions.export.done'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [t]);

  // P2-01 D: load registered adapters for the appearance section.
  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const result = await api.adapters();
        if (!cancelled) {
          setAdapters(result.adapters);
        }
      } catch {
        // appearance section stays empty when the endpoint is unavailable
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // P2-02: load access-mode state (mode/caps/pairs) once.
  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const result = await api.net();
        if (!cancelled) {
          setNetMode(result.mode);
          setCaps(result.caps);
          const active = result.pairs.find((pair) => pair.expiresAt > Date.now());
          setPairCode(active?.code ?? null);
        }
      } catch {
        // access mode stays local when the endpoint is unavailable
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

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
    restoreArchived(id);
  };

  // Permanently delete an archived session: drops the archived marker and
  // removes the session file (server accepts a bare file name only and
  // guards path traversal itself).
  const deleteArchivedSession = async (target: SessionSummary): Promise<void> => {
    setDeleteError(null);
    try {
      const bareName = target.fileName.split('/').pop() ?? target.fileName;
      const response = await api.deleteSession(bareName);
      if (!response.success) {
        setDeleteError(response.error ?? 'delete failed');
        return;
      }
      // Archived markers are keyed by session id, not file name.
      removeArchived(target.id);
      setDeleteTarget(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    }
  };

  // Stay in sync when the sidebar archives/restores while this page is open.
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

  const saveUserId = (value: string): void => {
    const trimmed = value.trim();
    const next = trimmed.length === 0 ? 'guest' : trimmed;
    setUserId(next);
    localStorage.setItem(USER_ID_STORAGE_KEY, next);
    setEditingUser(false);
  };

  const scrollTop = useCallback((): void => {
    const element = document.getElementById('settings-content');
    if (element !== null) {
      element.scrollTop = 0;
    }
  }, []);

  useEffect(() => {
    scrollTop();
  }, [section, scrollTop]);

  // P1-17 F: settings sub-pages slide in from the direction matching the
  // section order — 1→5 (ascending) enters from above sliding down, 5→1
  // (descending) rises from below.
  const sectionIndex = SETTINGS_SECTIONS.findIndex((entry) => entry.id === section);
  const prevSectionIndexRef = useRef(sectionIndex);
  const [slideDown, setSlideDown] = useState(true);
  useEffect(() => {
    const prev = prevSectionIndexRef.current;
    if (prev !== sectionIndex && prev !== -1 && sectionIndex !== -1) {
      setSlideDown(sectionIndex > prev);
    }
    prevSectionIndexRef.current = sectionIndex;
  }, [sectionIndex]);

  const title =
    section === 'general'
      ? t('settings.nav.general')
      : section === 'personal'
        ? t('settings.nav.personal')
        : section === 'models'
          ? t('settings.nav.models')
          : section === 'sessions'
            ? t('settings.nav.sessions')
            : section === 'permissions'
              ? t('settings.nav.permissions')
              : section === 'favorites'
                ? t('settings.nav.favorites')
                : section === 'systemPrompt'
                  ? t('settings.nav.systemPrompt')
                  : section === 'about'
                    ? t('settings.nav.about')
                    : t('settings.nav.lab');

  return (
    <section className="settings-page" data-shot="settings">
      <div className="settings-head">
        <h1 className="panel-title">{title}</h1>
        <p className="settings-head-hint mono">{t('settings.readonly')}</p>
      </div>

      {error !== null ? <div className="settings-error mono">{error}</div> : null}

      <div
        key={section}
        className={`settings-content scroll-area${slideDown ? ' settings-slide-down' : ' settings-slide-up'}`}
        id="settings-content"
      >
        {section === 'general' ? (
          <>
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
              <h2 className="settings-section-title mono">{t('settings.theme')}</h2>
              <p className="settings-hint">{t('theme.fogHint')}</p>
              <div className="settings-language">
                {THEMES.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="settings-language-btn"
                    data-active={theme === item.id}
                    onClick={() => {
                      if (theme !== item.id) {
                        onThemeChange(item.id);
                      }
                    }}
                  >
                    {t(item.labelKey as MessageKey)}
                  </button>
                ))}
              </div>
            </section>

            <section className="settings-section">
              <h2 className="settings-section-title mono">{t('settings.modes')}</h2>
              <p className="settings-hint">{t('settings.modes.hint')}</p>
              <div className="setting-row">
                <span className="setting-label mono">{t('settings.modes.steering')}</span>
                <select
                  className="channel-input mono"
                  value={modes.steering}
                  onChange={(event) => {
                    setMode('steering', event.target.value);
                  }}
                  aria-label={t('settings.modes.steering')}
                >
                  <option value="one-at-a-time">one-at-a-time</option>
                  <option value="parallel">parallel</option>
                </select>
              </div>
              <div className="setting-row">
                <span className="setting-label mono">{t('settings.modes.followUp')}</span>
                <select
                  className="channel-input mono"
                  value={modes.followUp}
                  onChange={(event) => {
                    setMode('followUp', event.target.value);
                  }}
                  aria-label={t('settings.modes.followUp')}
                >
                  <option value="sequential">sequential</option>
                  <option value="parallel">parallel</option>
                </select>
              </div>
            </section>

            <section className="settings-section">
              <h2 className="settings-section-title mono">{t('settings.agent')}</h2>
              <div className="settings-list">
                {settings === null ? (
                  <p className="settings-hint">
                    <LoadingHint>{t('settings.loading')}</LoadingHint>
                  </p>
                ) : Object.entries(settings).length === 0 ? (
                  <p className="settings-hint">{t('settings.empty')}</p>
                ) : (
                  Object.entries(settings).map(([key, value]) => (
                    <SettingRow key={key} label={key} value={JSON.stringify(value)} />
                  ))
                )}
              </div>
            </section>
          </>
        ) : null}

        {section === 'personal' ? (
          <>
            <section className="settings-section">
              <h2 className="settings-section-title mono">{t('settings.nav.personal')}</h2>
              <div className="setting-row">
                <span className="setting-label mono">{t('settings.personal.userId')}</span>
                {editingUser ? (
                  <input
                    className="sidebar-user-input mono"
                    defaultValue={userId}
                    autoFocus
                    aria-label={t('settings.personal.userId')}
                    onBlur={(event) => {
                      saveUserId(event.target.value);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                        saveUserId((event.target as HTMLInputElement).value);
                      }
                    }}
                  />
                ) : (
                  <div className="setting-row-value">
                    <span className="setting-value mono">{userId}</span>
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={() => {
                        setEditingUser(true);
                      }}
                    >
                      {t('settings.personal.edit')}
                    </button>
                  </div>
                )}
              </div>
              <p className="settings-hint">{t('settings.personal.userIdHint')}</p>
            </section>

            <section className="settings-section">
              <h2 className="settings-section-title mono">{t('settings.personal.adapters')}</h2>
              <div className="setting-row">
                <span className="setting-label mono">{t('settings.personal.adapters')}</span>
                <div className="setting-row-value adapter-color-row">
                  {adapters.map((adapter) => (
                    <label
                      key={adapter.kind}
                      className="adapter-color-item mono"
                      title={t('settings.personal.adapterColor', { label: adapter.label })}
                    >
                      <input
                        type="color"
                        className="adapter-color-input"
                        value={adapterColors[adapter.kind] ?? adapter.defaultColor}
                        aria-label={t('settings.personal.adapterColor', { label: adapter.label })}
                        onChange={(event) => {
                          setAdapterColor(adapter.kind, event.target.value);
                        }}
                      />
                      <span className="adapter-color-label">
                        {adapter.label}
                        {adapter.version !== null ? ` · ${adapter.version}` : ''}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
              <p className="settings-hint">{t('settings.personal.adaptersHint')}</p>
            </section>

            <section className="settings-section">
              <h2 className="settings-section-title mono">{t('settings.personal.sidebar')}</h2>
              <div className="setting-row">
                <span className="setting-label mono">{t('settings.personal.sidebarState')}</span>
                <div className="setting-row-value">
                  <span className="setting-value mono">
                    {sidebarCollapsed
                      ? t('settings.personal.sidebarCollapsed')
                      : t('settings.personal.sidebarExpanded')}
                  </span>
                  <button type="button" className="btn-primary" onClick={onToggleCollapsed}>
                    {sidebarCollapsed ? t('sidebar.expand') : t('sidebar.collapse')}
                  </button>
                </div>
              </div>
              <p className="settings-hint">{t('settings.personal.sidebarHint')}</p>
            </section>

            <section className="settings-section">
              <h2 className="settings-section-title mono">{t('settings.personal.sendMode')}</h2>
              <div className="settings-language">
                {(
                  [
                    { value: 'enter', label: t('settings.personal.sendMode.enter') },
                    { value: 'cmd-enter', label: t('settings.personal.sendMode.cmdEnter') },
                    { value: 'ctrl-enter', label: t('settings.personal.sendMode.ctrlEnter') },
                  ] as ReadonlyArray<{ value: SendMode; label: string }>
                ).map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className="settings-language-btn"
                    data-active={prefs.sendMode === option.value}
                    onClick={() => {
                      setPref('sendMode', option.value);
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </section>

            <section className="settings-section">
              <h2 className="settings-section-title mono">{t('settings.personal.cmdKey')}</h2>
              <div className="settings-language">
                {(
                  [
                    { value: 'meta', label: t('settings.personal.cmdKey.meta') },
                    { value: 'ctrl', label: t('settings.personal.cmdKey.ctrl') },
                  ] as ReadonlyArray<{ value: CommandKey; label: string }>
                ).map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className="settings-language-btn"
                    data-active={prefs.cmdKey === option.value}
                    onClick={() => {
                      setPref('cmdKey', option.value);
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <p className="settings-hint">{t('settings.personal.keysHint')}</p>
            </section>

            {/* P2-02: access mode + pairing + remote capabilities */}
            <section className="settings-section">
              <h2 className="settings-section-title mono">{t('settings.network')}</h2>
              <div className="setting-row">
                <span className="setting-label mono">{t('settings.network.mode')}</span>
                <div className="setting-row-value">
                  <span className="setting-value mono">
                    {netMode === 'local'
                      ? t('settings.network.local')
                      : netMode === 'pair'
                        ? t('settings.network.pair')
                        : t('settings.network.lan')}
                  </span>
                </div>
              </div>
              <div className="setting-row">
                <span className="setting-label mono">{t('settings.network.pairCode')}</span>
                <div className="setting-row-value">
                  {pairCode !== null ? (
                    <>
                      <span className="setting-value mono">{pairCode}</span>
                      <button
                        type="button"
                        className="btn-primary"
                        onClick={() => {
                          void revokePair(pairCode);
                        }}
                      >
                        {t('settings.network.revokePair')}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn-primary"
                      disabled={netMode === 'local'}
                      title={netMode === 'local' ? t('settings.network.pairDisabled') : undefined}
                      onClick={() => {
                        void generatePair();
                      }}
                    >
                      {t('settings.network.generatePair')}
                    </button>
                  )}
                </div>
              </div>
              <p className="settings-hint">{t('settings.network.hint')}</p>
              <div className="network-caps">
                <span className="setting-label mono">{t('settings.network.caps')}</span>
                {(
                  [
                    { key: 'remoteApprove', label: t('settings.network.capApprove') },
                    { key: 'remotePrompt', label: t('settings.network.capPrompt') },
                    { key: 'remoteShell', label: t('settings.network.capShell') },
                  ] as ReadonlyArray<{ key: 'remoteApprove' | 'remotePrompt' | 'remoteShell'; label: string }>
                ).map((cap) => (
                  <label key={cap.key} className="network-cap mono">
                    <input
                      type="checkbox"
                      checked={caps[cap.key]}
                      disabled={netMode === 'local'}
                      onChange={(event) => {
                        void setCap(cap.key, event.target.checked);
                      }}
                    />
                    {cap.label}
                  </label>
                ))}
              </div>
            </section>
          </>
        ) : null}

        {section === 'models' ? (
          <>
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
            <section className="settings-section">
              <ChannelsSection />
            </section>
          </>
        ) : null}

        {section === 'sessions' ? (
          <>
            <section className="settings-section">
              <h2 className="settings-section-title mono">{t('settings.nav.sessions')}</h2>
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
                          className="btn-primary"
                          onClick={() => {
                            restoreSession(id);
                          }}
                        >
                          {t('settings.restore')}
                        </button>
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => {
                            setDeleteTarget(session);
                          }}
                        >
                          {t('sessions.delete')}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="settings-section">
              <h2 className="settings-section-title mono">{t('sessions.export.title')}</h2>
              <p className="settings-hint">{t('sessions.export.hint')}</p>
              <div className="setting-row">
                <span className="setting-label mono">{t('sessions.export.current')}</span>
                <div className="setting-row-value">
                  {exportNotice !== null ? (
                    <span className="setting-value mono">{exportNotice}</span>
                  ) : null}
                  <button type="button" className="btn-primary" onClick={() => { void handleExportHtml(); }}>
                    {t('sessions.export.action')}
                  </button>
                </div>
              </div>
            </section>
          </>
        ) : null}

        {section === 'permissions' ? <PermissionsSection /> : null}
        {section === 'favorites' ? (
          <FavoritesSection
            onRun={(text) => {
              // Switch to the chat view immediately; pi's prompt ack only
              // arrives when the run settles, so do not block on it.
              onBack();
              onSectionChange('general');
              void api.prompt(text).catch((err: unknown) => {
                setError(err instanceof Error ? err.message : String(err));
              });
            }}
          />
        ) : null}
        {section === 'systemPrompt' ? <SystemPromptSection onError={setError} /> : null}
        {section === 'lab' ? <LabSection /> : null}
        {section === 'about' ? <AboutSection /> : null}
      </div>

      {deleteTarget !== null ? (
        <ConfirmDialog
          title={t('sessions.delete')}
          message={t('sessions.deleteConfirm', { name: deleteTarget.name ?? deleteTarget.fileName })}
          onConfirm={() => {
            void deleteArchivedSession(deleteTarget);
          }}
          onCancel={() => {
            setDeleteTarget(null);
          }}
        />
      ) : null}
      {deleteError !== null ? (
        <div className="settings-error mono" role="alert">
          {deleteError}
        </div>
      ) : null}
    </section>
  );
}
