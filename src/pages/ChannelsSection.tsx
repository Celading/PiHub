import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { LoadingHint } from '../components/LoadingHint.js';
import './ChannelsSection.css';

interface ModelForm {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: string;
  maxTokens: string;
  inputTypes: string;
  detailsOpen: boolean;
}

interface ProviderForm {
  key: string;
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
    contextWindow: '',
    maxTokens: '',
    inputTypes: 'text',
    detailsOpen: false,
  };
}

function emptyProvider(): ProviderForm {
  return {
    key: '',
    name: '',
    baseUrl: '',
    apiKey: '',
    api: 'openai-completions',
    models: [],
    detailsOpen: false,
  };
}

/**
 * One-click mainstream provider templates (P1-12 E). `api` values follow the
 * pi provider contract (openai-completions covers OpenAI-compatible hosts
 * incl. Volcengine Ark; anthropic / gemini for their native APIs). Model ids
 * are current public examples — users adjust to their accounts.
 */
interface ChannelTemplate {
  key: string;
  name: string;
  baseUrl: string;
  api: string;
  models: Array<{ id: string; name: string; reasoning: boolean }>;
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
    ],
  },
  {
    key: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    api: 'openai-completions',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat', reasoning: false },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', reasoning: true },
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
        if (model.reasoning) {
          modelEntry['reasoning'] = true;
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

export function ChannelsSection(): React.JSX.Element {
  const { t } = useI18n();
  const [providers, setProviders] = useState<ProviderForm[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState('');

  const applyTemplate = (): void => {
    const template = CHANNEL_TEMPLATES.find((entry) => entry.key === selectedTemplate);
    if (template === undefined) {
      return;
    }
    const provider: ProviderForm = {
      key: template.key,
      name: template.name,
      baseUrl: template.baseUrl,
      apiKey: '',
      api: template.api,
      models: template.models.map((model) => ({
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        contextWindow: '',
        maxTokens: '',
        inputTypes: 'text',
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
            return {
              id: typeof model['id'] === 'string' ? model['id'] : '',
              name: typeof model['name'] === 'string' ? model['name'] : '',
              reasoning: model['reasoning'] === true,
              contextWindow:
                typeof model['contextWindow'] === 'number' ? String(model['contextWindow']) : '',
              maxTokens: typeof model['maxTokens'] === 'number' ? String(model['maxTokens']) : '',
              inputTypes: input,
              detailsOpen: false,
            };
          });
          return {
            key,
            name: typeof entry['name'] === 'string' ? entry['name'] : '',
            baseUrl: typeof entry['baseUrl'] === 'string' ? entry['baseUrl'] : '',
            apiKey: typeof entry['apiKey'] === 'string' ? entry['apiKey'] : '',
            api: typeof entry['api'] === 'string' ? entry['api'] : 'openai-completions',
            models,
            detailsOpen: false,
          };
        });
        setProviders(forms);
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

  const save = async (): Promise<void> => {
    setError(null);
    try {
      await api.saveModelsConfig(toConfig(providers));
      setSavedNotice(true);
      window.setTimeout(() => {
        setSavedNotice(false);
      }, 2500);
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
                      <label className="channel-field channel-field-small">
                        <span className="channel-label mono">{t('model.reasoning')}</span>
                        <input
                          type="checkbox"
                          checked={model.reasoning}
                          onChange={(event) => {
                            updateModel(providerIndex, modelIndex, {
                              reasoning: event.target.checked,
                            });
                          }}
                        />
                      </label>
                      <label className="channel-field channel-field-small">
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
            </div>
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
