import { useEffect, useState } from 'react';
import { api, type CatalogModel } from '../api/client.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { LoadingHint } from '../components/LoadingHint.js';
import type { ModelInfo } from '../../shared/types.js';
import './ChannelsSection.css';

interface ModelForm {
  id: string;
  name: string;
  reasoning: boolean;
  /**
   * True once the user, a template, or the official catalog explicitly set
   * reasoning — the store auto-fill (P1-15 C) then leaves it alone. False
   * only for models that were never reasoned about (manual adds / entries
   * saved without a reasoning key).
   */
  reasoningTouched: boolean;
  contextWindow: string;
  maxTokens: string;
  inputTypes: string;
  /** thinkingLevelMap as JSON text (details accordion). */
  thinkingLevelMap: string;
  /** compat as JSON text (details accordion). */
  compat: string;
  detailsOpen: boolean;
}

interface ProviderForm {
  key: string;
  /** Short channel alias shown as the first-level picker name (P1-14). */
  alias: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  api: string;
  models: ModelForm[];
  detailsOpen: boolean;
}

function emptyModel(): ModelForm {
  return {
    id: '',
    name: '',
    reasoning: false,
    reasoningTouched: false,
    contextWindow: '',
    maxTokens: '',
    inputTypes: 'text',
    thinkingLevelMap: '',
    compat: '',
    detailsOpen: false,
  };
}

function emptyProvider(): ProviderForm {
  return {
    key: '',
    alias: '',
    name: '',
    baseUrl: '',
    apiKey: '',
    api: 'openai-completions',
    models: [],
    detailsOpen: false,
  };
}

/** JSON text → plain object, or null when invalid. */
function parseJsonObject(text: string): Record<string, unknown> | null {
  if (text.trim().length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** JSON text → thinking level map (all values string | null), or null. */
function parseJsonStringMap(text: string): Record<string, string | null> | null {
  const parsed = parseJsonObject(text);
  if (parsed === null) {
    return null;
  }
  for (const value of Object.values(parsed)) {
    if (typeof value !== 'string' && value !== null) {
      return null;
    }
  }
  return parsed as Record<string, string | null>;
}

/**
 * One-click mainstream provider templates (P1-12 E). `api` values follow the
 * pi provider contract (openai-completions covers OpenAI-compatible hosts
 * incl. Volcengine Ark; anthropic / gemini for their native APIs). Model ids
 * are current public examples — users adjust to their accounts. P1-15: model
 * entries carry reasoning/thinkingLevelMap/contextWindow/maxTokens defaults
 * so applied templates produce working thinking levels immediately.
 */
interface ChannelTemplate {
  key: string;
  name: string;
  baseUrl: string;
  api: string;
  models: Array<{
    id: string;
    name: string;
    reasoning: boolean;
    thinkingLevelMap?: Record<string, string | null>;
    contextWindow?: number;
    maxTokens?: number;
    compat?: Record<string, unknown>;
  }>;
}

const CHANNEL_TEMPLATES: ChannelTemplate[] = [
  {
    key: 'volcengine-ark',
    name: '火山方舟 Volcengine Ark',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    api: 'openai-completions',
    models: [
      { id: 'doubao-seed-1-6-250615', name: 'Doubao Seed 1.6', reasoning: false },
      { id: 'doubao-1-5-pro-32k-250115', name: 'Doubao 1.5 Pro 32K', reasoning: false },
      {
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        reasoning: true,
        contextWindow: 1000000,
        maxTokens: 384000,
        // Same family as the official DeepSeek entry (store deepseek-v4-flash).
        thinkingLevelMap: { minimal: null, low: null, medium: null, high: 'high', max: 'max' },
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          requiresReasoningContentOnAssistantMessages: true,
          thinkingFormat: 'deepseek',
        },
      },
    ],
  },
  {
    key: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    api: 'openai-completions',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat', reasoning: false },
      {
        id: 'deepseek-reasoner',
        name: 'DeepSeek Reasoner',
        reasoning: true,
        thinkingLevelMap: { minimal: null, low: null, medium: null, high: 'high', max: 'max' },
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          requiresReasoningContentOnAssistantMessages: true,
          thinkingFormat: 'deepseek',
        },
      },
    ],
  },
  {
    key: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    api: 'openai-completions',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o', reasoning: false },
      { id: 'gpt-4o-mini', name: 'GPT-4o mini', reasoning: false },
    ],
  },
  {
    key: 'anthropic',
    name: 'Anthropic Claude',
    baseUrl: 'https://api.anthropic.com',
    api: 'anthropic',
    models: [
      { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', reasoning: false },
      { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', reasoning: false },
    ],
  },
  {
    key: 'google-gemini',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    api: 'gemini',
    models: [
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', reasoning: true },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', reasoning: true },
    ],
  },
  {
    key: 'ollama',
    name: 'Ollama（本地）',
    baseUrl: 'http://localhost:11434/v1',
    api: 'openai-completions',
    models: [
      { id: 'llama3.1', name: 'Llama 3.1', reasoning: false },
      { id: 'qwen2.5', name: 'Qwen 2.5', reasoning: false },
    ],
  },
  {
    key: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    api: 'openai-completions',
    models: [
      { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', reasoning: false },
      { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', reasoning: false },
    ],
  },
];

function toConfig(providers: ProviderForm[]): Record<string, unknown> {
  const out: Record<string, unknown> = { providers: {} };
  const providersOut: Record<string, unknown> = {};
  for (const provider of providers) {
    const key = provider.key.trim() || provider.name.trim();
    if (key.length === 0) {
      continue;
    }
    const entry: Record<string, unknown> = {};
    if (provider.alias.trim().length > 0) {
      entry['alias'] = provider.alias.trim();
    }
    if (provider.name.trim().length > 0) {
      entry['name'] = provider.name.trim();
    }
    if (provider.baseUrl.trim().length > 0) {
      entry['baseUrl'] = provider.baseUrl.trim();
    }
    if (provider.apiKey.trim().length > 0) {
      entry['apiKey'] = provider.apiKey.trim();
    }
    if (provider.api.length > 0) {
      entry['api'] = provider.api;
    }
    const models = provider.models
      .filter((model) => model.id.trim().length > 0)
      .map((model) => {
        const modelEntry: Record<string, unknown> = { id: model.id.trim() };
        if (model.name.trim().length > 0) {
          modelEntry['name'] = model.name.trim();
        }
        // Explicit false persists too (touched) — otherwise the store
        // auto-fill would re-fill reasoning on the next save.
        if (model.reasoning || model.reasoningTouched) {
          modelEntry['reasoning'] = model.reasoning;
        }
        const context = Number(model.contextWindow);
        if (model.contextWindow.trim().length > 0 && Number.isFinite(context) && context > 0) {
          modelEntry['contextWindow'] = context;
        }
        const maxTokens = Number(model.maxTokens);
        if (model.maxTokens.trim().length > 0 && Number.isFinite(maxTokens) && maxTokens > 0) {
          modelEntry['maxTokens'] = maxTokens;
        }
        const input = model.inputTypes
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part.length > 0);
        if (input.length > 0) {
          modelEntry['input'] = input;
        }
        const levelMap = parseJsonStringMap(model.thinkingLevelMap);
        if (levelMap !== null) {
          modelEntry['thinkingLevelMap'] = levelMap;
        }
        const compat = parseJsonObject(model.compat);
        if (compat !== null) {
          modelEntry['compat'] = compat;
        }
        return modelEntry;
      });
    if (models.length > 0) {
      entry['models'] = models;
    }
    providersOut[key] = entry;
  }
  out['providers'] = providersOut;
  return out;
}

/** Official catalog entry → form model (P1-15 C). */
function catalogToForm(model: CatalogModel): ModelForm {
  return {
    id: model.id,
    name: model.name ?? '',
    reasoning: model.reasoning === true,
    reasoningTouched: true,
    contextWindow: model.contextWindow !== undefined ? String(model.contextWindow) : '',
    maxTokens: model.maxTokens !== undefined ? String(model.maxTokens) : '',
    inputTypes: Array.isArray(model.input) && model.input.length > 0 ? model.input.join(',') : 'text',
    thinkingLevelMap: model.thinkingLevelMap !== undefined ? JSON.stringify(model.thinkingLevelMap) : '',
    compat: model.compat !== undefined ? JSON.stringify(model.compat) : '',
    detailsOpen: false,
  };
}

interface CatalogState {
  providerIndex: number;
  models: CatalogModel[];
  checked: string[];
  loading: boolean;
  error: string | null;
  /** P1-17 C: where the entries came from (panel copy only). */
  source: 'official' | 'channel';
}

export function ChannelsSection(): React.JSX.Element {
  const { t } = useI18n();
  const [providers, setProviders] = useState<ProviderForm[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [catalog, setCatalog] = useState<CatalogState | null>(null);
  const [storeModels, setStoreModels] = useState<ModelInfo[]>([]);

  const applyTemplate = (): void => {
    const template = CHANNEL_TEMPLATES.find((entry) => entry.key === selectedTemplate);
    if (template === undefined) {
      return;
    }
    const provider: ProviderForm = {
      key: template.key,
      alias: '',
      name: template.name,
      baseUrl: template.baseUrl,
      apiKey: '',
      api: template.api,
      models: template.models.map((model) => ({
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        reasoningTouched: true,
        contextWindow: model.contextWindow !== undefined ? String(model.contextWindow) : '',
        maxTokens: model.maxTokens !== undefined ? String(model.maxTokens) : '',
        inputTypes: 'text',
        thinkingLevelMap:
          model.thinkingLevelMap !== undefined ? JSON.stringify(model.thinkingLevelMap) : '',
        compat: model.compat !== undefined ? JSON.stringify(model.compat) : '',
        detailsOpen: false,
      })),
      detailsOpen: false,
    };
    setProviders((prev) => [...prev, provider]);
    setSelectedTemplate('');
  };

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const config = await api.modelsConfig();
        const store = await api.models();
        if (cancelled) {
          return;
        }
        const rawProviders = (config['providers'] as Record<string, unknown> | undefined) ?? {};
        const forms: ProviderForm[] = Object.entries(rawProviders).map(([key, value]) => {
          const entry = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
          const rawModels = Array.isArray(entry['models']) ? (entry['models'] as unknown[]) : [];
          const models: ModelForm[] = rawModels.map((raw) => {
            const model = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
            const input = Array.isArray(model['input']) ? (model['input'] as string[]).join(',') : 'text';
            const levelMap =
              typeof model['thinkingLevelMap'] === 'object' && model['thinkingLevelMap'] !== null
                ? JSON.stringify(model['thinkingLevelMap'])
                : '';
            const compat =
              typeof model['compat'] === 'object' && model['compat'] !== null
                ? JSON.stringify(model['compat'])
                : '';
            return {
              id: typeof model['id'] === 'string' ? model['id'] : '',
              name: typeof model['name'] === 'string' ? model['name'] : '',
              reasoning: model['reasoning'] === true,
              // Explicit key means the user/template/catalog decided — store
              // auto-fill must not override it (P1-15 C).
              reasoningTouched: 'reasoning' in model,
              contextWindow:
                typeof model['contextWindow'] === 'number' ? String(model['contextWindow']) : '',
              maxTokens: typeof model['maxTokens'] === 'number' ? String(model['maxTokens']) : '',
              inputTypes: input,
              thinkingLevelMap: levelMap,
              compat,
              detailsOpen: false,
            };
          });
          return {
            key,
            alias: typeof entry['alias'] === 'string' ? entry['alias'] : '',
            name: typeof entry['name'] === 'string' ? entry['name'] : '',
            baseUrl: typeof entry['baseUrl'] === 'string' ? entry['baseUrl'] : '',
            apiKey: typeof entry['apiKey'] === 'string' ? entry['apiKey'] : '',
            api: typeof entry['api'] === 'string' ? entry['api'] : 'openai-completions',
            models,
            detailsOpen: false,
          };
        });
        setProviders(forms);
        setStoreModels(store.providers.flatMap((entry) => entry.models));
        setLoaded(true);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoaded(true);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const updateProvider = (index: number, patch: Partial<ProviderForm>): void => {
    setProviders((prev) => prev.map((provider, i) => (i === index ? { ...provider, ...patch } : provider)));
  };

  const updateModel = (providerIndex: number, modelIndex: number, patch: Partial<ModelForm>): void => {
    setProviders((prev) =>
      prev.map((provider, i) =>
        i === providerIndex
          ? {
              ...provider,
              models: provider.models.map((model, j) =>
                j === modelIndex ? { ...model, ...patch } : model,
              ),
            }
          : provider,
      ),
    );
  };

  const openCatalog = async (providerIndex: number): Promise<void> => {
    const provider = providers[providerIndex];
    if (provider === undefined) {
      return;
    }
    const key = provider.key.trim() || provider.name.trim();
    if (key.length === 0) {
      setCatalog({ providerIndex, models: [], checked: [], loading: false, error: t('channels.catalog.needKey'), source: 'official' });
      return;
    }
    setCatalog({ providerIndex, models: [], checked: [], loading: true, error: null, source: 'official' });
    try {
      const models = await api.catalogModels(key);
      setCatalog({ providerIndex, models, checked: models.map((model) => model.id), loading: false, error: null, source: 'official' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const unavailable = /not found/i.test(message);
      setCatalog({
        providerIndex,
        models: [],
        checked: [],
        loading: false,
        error: unavailable ? t('channels.catalog.unavailable') : t('channels.catalog.failed', { error: message }),
        source: 'official',
      });
    }
  };

  /** P1-17 C: pull the channel's own model list via `{baseUrl}/models`. */
  const openChannelCatalog = async (providerIndex: number): Promise<void> => {
    const provider = providers[providerIndex];
    if (provider === undefined) {
      return;
    }
    const key = provider.key.trim() || provider.name.trim();
    if (key.length === 0) {
      setCatalog({ providerIndex, models: [], checked: [], loading: false, error: t('channels.catalog.needKey'), source: 'channel' });
      return;
    }
    const baseUrl = provider.baseUrl.trim();
    const apiKey = provider.apiKey.trim();
    if (baseUrl.length === 0 || apiKey.length === 0) {
      setCatalog({ providerIndex, models: [], checked: [], loading: false, error: t('channels.catalog.needToken'), source: 'channel' });
      return;
    }
    setCatalog({ providerIndex, models: [], checked: [], loading: true, error: null, source: 'channel' });
    try {
      const models = await api.fetchChannelModels({ baseUrl, apiKey, api: provider.api });
      setCatalog({ providerIndex, models, checked: models.map((model) => model.id), loading: false, error: null, source: 'channel' });
    } catch (err) {
      setCatalog({
        providerIndex,
        models: [],
        checked: [],
        loading: false,
        error: t('channels.catalog.failed', { error: err instanceof Error ? err.message : String(err) }),
        source: 'channel',
      });
    }
  };

  const toggleCatalog = (modelId: string): void => {
    setCatalog((prev) => {
      if (prev === null) {
        return prev;
      }
      const checked = prev.checked.includes(modelId)
        ? prev.checked.filter((id) => id !== modelId)
        : [...prev.checked, modelId];
      return { ...prev, checked };
    });
  };

  const applyCatalog = (providerIndex: number): void => {
    if (catalog === null) {
      return;
    }
    const existing = new Set(providers[providerIndex]?.models.map((model) => model.id) ?? []);
    const added = catalog.models.filter(
      (model) => catalog.checked.includes(model.id) && !existing.has(model.id),
    );
    const skipped = catalog.checked.length - added.length;
    if (added.length > 0) {
      setProviders((prev) =>
        prev.map((provider, i) =>
          i === providerIndex
            ? { ...provider, models: [...provider.models, ...added.map(catalogToForm)] }
            : provider,
        ),
      );
    }
    if (skipped > 0) {
      setNotice(t('channels.catalog.skipped', { count: String(skipped) }));
    }
    setCatalog(null);
  };

  const save = async (): Promise<void> => {
    setError(null);
    try {
      // P1-15 C: fill empty model fields from the model store before saving.
      // Exact provider+id match inherits full params (incl. thinkingLevelMap
      // and compat); an id-only cross-provider match inherits only generic
      // model-family params (reasoning/contextWindow/maxTokens/input) — never
      // provider-specific thinking maps. Explicit user/template/catalog
      // values always win (fill only what is empty/untouched).
      let filled = 0;
      const next = providers.map((provider) => {
        const key = provider.key.trim() || provider.name.trim();
        const models = provider.models.map((model) => {
          const exact = storeModels.find((entry) => entry.provider === key && entry.id === model.id);
          const anyId = exact ?? storeModels.find((entry) => entry.id === model.id);
          if (anyId === undefined) {
            return { model, changed: false };
          }
          const patch: Partial<ModelForm> = {};
          if (model.contextWindow === '' && anyId.contextWindow !== undefined) {
            patch['contextWindow'] = String(anyId.contextWindow);
          }
          if (model.maxTokens === '' && anyId.maxTokens !== undefined) {
            patch['maxTokens'] = String(anyId.maxTokens);
          }
          if (model.inputTypes === '' && anyId.input !== undefined && anyId.input.length > 0) {
            patch['inputTypes'] = anyId.input.join(',');
          }
          if (!model.reasoningTouched && anyId.reasoning !== undefined) {
            patch['reasoning'] = anyId.reasoning;
            patch['reasoningTouched'] = true;
          }
          if (exact !== undefined) {
            if (model.thinkingLevelMap === '' && exact.thinkingLevelMap !== undefined) {
              patch['thinkingLevelMap'] = JSON.stringify(exact.thinkingLevelMap);
            }
            if (model.compat === '' && exact.compat !== undefined) {
              patch['compat'] = JSON.stringify(exact.compat);
            }
          }
          return Object.keys(patch).length > 0 ? { model: { ...model, ...patch }, changed: true } : { model, changed: false };
        });
        return { provider: { ...provider, models: models.map((entry) => entry.model) }, changed: models.some((entry) => entry.changed) };
      });
      const providersNext = next.map((entry) => entry.provider);
      filled = next.filter((entry) => entry.changed).reduce((acc, entry) => acc + entry.provider.models.length, 0);
      setProviders(providersNext);
      const saved = await api.saveModelsConfig(toConfig(providersNext));
      if (saved.reload === 'deferred') {
        setNotice(t('channels.reloadPending'));
      } else if (filled > 0) {
        setNotice(t('channels.fillNotice', { count: String(filled) }));
      } else {
        setSavedNotice(true);
        window.setTimeout(() => {
          setSavedNotice(false);
        }, 2500);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="channels">
      <div className="channels-head">
        <h2 className="settings-section-title mono">{t('settings.channels')}</h2>
        <span className="channels-hint mono">{t('settings.channels.hint')}</span>
      </div>

      {error !== null ? <div className="settings-error mono">{error}</div> : null}
      {notice !== null ? <div className="channel-notice mono">{notice}</div> : null}

      {!loaded ? (
        <p className="settings-hint">
          <LoadingHint>{t('settings.loading')}</LoadingHint>
        </p>
      ) : providers.length === 0 ? (
        <p className="settings-hint">{t('channels.empty')}</p>
      ) : (
        providers.map((provider, providerIndex) => (
          <div key={provider.key} className="channel-card">
            <div className="channel-head">
              <input
                className="channel-input channel-key mono"
                value={provider.key}
                aria-label={t('provider.name')}
                placeholder={t('provider.name')}
                onChange={(event) => {
                  updateProvider(providerIndex, { key: event.target.value });
                }}
              />
              <input
                className="channel-input channel-key mono"
                value={provider.alias}
                aria-label={t('provider.alias')}
                placeholder={t('provider.alias')}
                onChange={(event) => {
                  updateProvider(providerIndex, { alias: event.target.value });
                }}
              />
              <button
                type="button"
                className="channel-remove"
                onClick={() => {
                  setProviders((prev) => prev.filter((_, i) => i !== providerIndex));
                }}
              >
                {t('channels.removeProvider')}
              </button>
            </div>
            <div className="channel-fields">
              <label className="channel-field">
                <span className="channel-label mono">{t('provider.baseUrl')}</span>
                <input
                  className="channel-input mono"
                  value={provider.baseUrl}
                  onChange={(event) => {
                    updateProvider(providerIndex, { baseUrl: event.target.value });
                  }}
                />
              </label>
              <label className="channel-field">
                <span className="channel-label mono">{t('provider.apiKey')}</span>
                <input
                  className="channel-input mono"
                  type="password"
                  value={provider.apiKey}
                  autoComplete="off"
                  onChange={(event) => {
                    updateProvider(providerIndex, { apiKey: event.target.value });
                  }}
                />
              </label>
              <label className="channel-field">
                <span className="channel-label mono">{t('provider.api')}</span>
                <select
                  className="channel-input mono"
                  value={provider.api}
                  onChange={(event) => {
                    updateProvider(providerIndex, { api: event.target.value });
                  }}
                >
                  <option value="openai-completions">openai-completions</option>
                  <option value="anthropic-messages">anthropic-messages</option>
                  <option value="google-generative">google-generative</option>
                </select>
              </label>
            </div>

            <div className="channel-models">
              {provider.models.map((model, modelIndex) => (
                <div key={`${provider.key}-${String(modelIndex)}`} className="channel-model">
                  <div className="channel-model-main">
                    <label className="channel-field">
                      <span className="channel-label mono">{t('model.id')}</span>
                      <input
                        className="channel-input mono"
                        value={model.id}
                        onChange={(event) => {
                          updateModel(providerIndex, modelIndex, { id: event.target.value });
                        }}
                      />
                    </label>
                    <label className="channel-field">
                      <span className="channel-label mono">{t('model.name')}</span>
                      <input
                        className="channel-input mono"
                        value={model.name}
                        onChange={(event) => {
                          updateModel(providerIndex, modelIndex, { name: event.target.value });
                        }}
                      />
                    </label>
                    {/* P1-15 B: reasoning surfaced on the main row (was hidden
                        in the details accordion — the dsv4f thinking complaint
                        traced to a missing reasoning flag). */}
                    <label className="channel-field channel-field-small channel-field-inline">
                      <span className="channel-label mono">{t('model.reasoning')}</span>
                      <input
                        type="checkbox"
                        checked={model.reasoning}
                        onChange={(event) => {
                          updateModel(providerIndex, modelIndex, {
                            reasoning: event.target.checked,
                            reasoningTouched: true,
                          });
                        }}
                      />
                    </label>
                    <label className="channel-field channel-field-small">
                      <span className="channel-label mono">{t('model.contextWindow')}</span>
                      <input
                        className="channel-input mono"
                        type="number"
                        value={model.contextWindow}
                        placeholder="200000"
                        onChange={(event) => {
                          updateModel(providerIndex, modelIndex, {
                            contextWindow: event.target.value,
                          });
                        }}
                      />
                    </label>
                    <label className="channel-field channel-field-small">
                      <span className="channel-label mono">{t('model.maxTokens')}</span>
                      <input
                        className="channel-input mono"
                        type="number"
                        value={model.maxTokens}
                        placeholder="16384"
                        onChange={(event) => {
                          updateModel(providerIndex, modelIndex, {
                            maxTokens: event.target.value,
                          });
                        }}
                      />
                    </label>
                    <button
                      type="button"
                      className="channel-model-remove"
                      onClick={() => {
                        setProviders((prev) =>
                          prev.map((p, i) =>
                            i === providerIndex
                              ? { ...p, models: p.models.filter((_, j) => j !== modelIndex) }
                              : p,
                          ),
                        );
                      }}
                    >
                      {t('channels.removeModel')}
                    </button>
                  </div>
                  <button
                    type="button"
                    className="channel-details-toggle mono"
                    onClick={() => {
                      updateModel(providerIndex, modelIndex, {
                        detailsOpen: !model.detailsOpen,
                      });
                    }}
                    aria-expanded={model.detailsOpen}
                  >
                    {model.detailsOpen ? '▾' : '▸'} {t('model.details')}
                  </button>
                  {model.detailsOpen ? (
                    <div className="channel-model-details">
                      <label className="channel-field channel-field-wide">
                        <span className="channel-label mono">{t('model.inputTypes')}</span>
                        <input
                          className="channel-input mono"
                          value={model.inputTypes}
                          placeholder="text,image"
                          onChange={(event) => {
                            updateModel(providerIndex, modelIndex, {
                              inputTypes: event.target.value,
                            });
                          }}
                        />
                      </label>
                      <label className="channel-field channel-field-wide">
                        <span className="channel-label mono">{t('model.thinkingLevelMap')}</span>
                        <textarea
                          className="channel-input mono channel-json-input"
                          rows={2}
                          value={model.thinkingLevelMap}
                          placeholder='{"high":"high","max":"max"}'
                          spellCheck={false}
                          onChange={(event) => {
                            updateModel(providerIndex, modelIndex, {
                              thinkingLevelMap: event.target.value,
                            });
                          }}
                        />
                      </label>
                      <label className="channel-field channel-field-wide">
                        <span className="channel-label mono">{t('model.compat')}</span>
                        <textarea
                          className="channel-input mono channel-json-input"
                          rows={2}
                          value={model.compat}
                          spellCheck={false}
                          onChange={(event) => {
                            updateModel(providerIndex, modelIndex, { compat: event.target.value });
                          }}
                        />
                      </label>
                    </div>
                  ) : null}
                </div>
              ))}
              <button
                type="button"
                className="channel-add-model"
                onClick={() => {
                  updateProvider(providerIndex, {
                    models: [...provider.models, emptyModel()],
                  });
                }}
              >
                ＋ {t('channels.addModel')}
              </button>
              <button
                type="button"
                className="channel-add-model"
                disabled={catalog !== null}
                onClick={() => {
                  void openCatalog(providerIndex);
                }}
              >
                ⬇ {t('channels.catalog.import')}
              </button>
              <button
                type="button"
                className="channel-add-model"
                disabled={catalog !== null}
                onClick={() => {
                  void openChannelCatalog(providerIndex);
                }}
              >
                ⬇ {t('channels.catalog.fetch')}
              </button>
            </div>

            {catalog !== null && catalog.providerIndex === providerIndex ? (
              <div className="channel-catalog" aria-label={t('channels.catalog.heading')}>
                <div className="channel-catalog-head">
                  <span className="channel-catalog-title mono">{t('channels.catalog.heading')}</span>
                  <span className="channel-catalog-hint mono">
                    {catalog.source === 'channel'
                      ? t('channels.catalog.fetchHint')
                      : t('channels.catalog.hint')}
                  </span>
                </div>
                {catalog.loading ? (
                  <p className="settings-hint">
                    <LoadingHint>{t('settings.loading')}</LoadingHint>
                  </p>
                ) : catalog.error !== null ? (
                  <p className="channel-catalog-error mono">{catalog.error}</p>
                ) : catalog.models.length === 0 ? (
                  <p className="settings-hint">{t('channels.catalog.empty')}</p>
                ) : (
                  <div className="channel-catalog-list">
                    {catalog.models.map((model) => {
                      const checked = catalog.checked.includes(model.id);
                      return (
                        <label key={model.id} className="channel-catalog-item" data-checked={checked}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              toggleCatalog(model.id);
                            }}
                          />
                          <span className="channel-catalog-name mono">{model.name ?? model.id}</span>
                          <span className="channel-catalog-id mono">{model.id}</span>
                          {model.reasoning === true ? (
                            <span className="channel-catalog-badge mono">reasoning</span>
                          ) : null}
                        </label>
                      );
                    })}
                  </div>
                )}
                <div className="channel-catalog-actions">
                  <button
                    type="button"
                    className="channel-catalog-confirm"
                    disabled={catalog.loading || catalog.checked.length === 0}
                    onClick={() => {
                      applyCatalog(providerIndex);
                    }}
                  >
                    {t('channels.catalog.confirm', { count: String(catalog.checked.length) })}
                  </button>
                  <button
                    type="button"
                    className="channel-catalog-cancel"
                    onClick={() => {
                      setCatalog(null);
                    }}
                  >
                    {t('channels.catalog.cancel')}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ))
      )}

      <div className="channels-actions">
        <select
          className="channels-template-select mono"
          value={selectedTemplate}
          onChange={(event) => {
            setSelectedTemplate(event.target.value);
          }}
          aria-label={t('channels.template.select')}
        >
          <option value="">{t('channels.template.select')}</option>
          {CHANNEL_TEMPLATES.map((template) => (
            <option key={template.key} value={template.key}>
              {template.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="channel-add-provider"
          disabled={selectedTemplate.length === 0}
          onClick={applyTemplate}
        >
          ＋ {t('channels.template.apply')}
        </button>
        <button
          type="button"
          className="channel-add-provider"
          onClick={() => {
            setProviders((prev) => [...prev, emptyProvider()]);
          }}
        >
          ＋ {t('channels.addProvider')}
        </button>
        {savedNotice ? (
          <span className="channels-saved mono">{t('channels.saved')}</span>
        ) : (
          <button
            type="button"
            className="channel-save"
            onClick={() => {
              void save();
            }}
          >
            {t('channels.save')}
          </button>
        )}
      </div>
    </section>
  );
}
