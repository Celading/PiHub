import { useEffect, useState } from 'react';
import type { RpcState } from '../../shared/types.js';
import { api } from '../api/client.js';
import { useI18n } from '../i18n/I18nProvider.js';
import './ModelBar.css';
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

interface ModelBarProps {
  rpcState: RpcState | null;
  onSetModel: (provider: string, modelId: string) => void;
  onSetThinking: (level: string) => void;
}

interface ModelOption {
  provider: string;
  modelId: string;
  label: string;
}

export function ModelBar({ rpcState, onSetModel, onSetThinking }: ModelBarProps): React.JSX.Element {
  const { t } = useI18n();
  const [options, setOptions] = useState<ModelOption[]>([]);
  const [savedNotice, setSavedNotice] = useState(false);

  const saveCurrent = async (): Promise<void> => {
    const model = rpcState?.model;
    if (model === undefined || model === null) {
      return;
    }
    try {
      await api.saveModel(model.provider, model.id);
      setSavedNotice(true);
      window.setTimeout(() => {
        setSavedNotice(false);
      }, 2500);
    } catch {
      setSavedNotice(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const response = await api.models();
        if (cancelled) {
          return;
        }
        const flat: ModelOption[] = [];
        for (const entry of response.providers) {
          for (const model of entry.models) {
            flat.push({
              provider: entry.provider,
              modelId: model.id,
              label: model.name,
            });
          }
        }
        setOptions(flat);
      } catch {
        if (!cancelled) {
          setOptions([]);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const currentModel = rpcState?.model;
  const currentLabel = currentModel === null || currentModel === undefined
    ? 'model'
    : currentModel.name;

  const handleModelChange = (value: string): void => {
    const option = options.find((item) => `${item.provider}/${item.modelId}` === value);
    if (option !== undefined) {
      onSetModel(option.provider, option.modelId);
    }
  };

  const handleThinkingChange = (value: string): void => {
    onSetThinking(value);
  };

  return (
    <div className="modelbar">
      <label className="modelbar-field">
        <span className="modelbar-label mono">{t('modelbar.model')}</span>
        <select
          className="modelbar-select"
          value={`${currentModel?.provider ?? ''}/${currentModel?.id ?? ''}`}
          onChange={(event) => {
            handleModelChange(event.target.value);
          }}
          aria-label={t('modelbar.model')}
        >
          <option value="/" disabled>
            {currentLabel}
          </option>
          {options.map((option) => (
            <option key={`${option.provider}/${option.modelId}`} value={`${option.provider}/${option.modelId}`}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="modelbar-field">
        <span className="modelbar-label mono">{t('modelbar.thinking')}</span>
        <select
          className="modelbar-select"
          value={rpcState?.thinkingLevel ?? 'off'}
          onChange={(event) => {
            handleThinkingChange(event.target.value);
          }}
          aria-label={t('modelbar.thinking')}
        >
          {THINKING_LEVELS.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      </label>
      {savedNotice ? (
        <span className="modelbar-saved mono">{t('session.save.done')}</span>
      ) : (
        <button
          type="button"
          className="modelbar-save"
          onClick={() => {
            void saveCurrent();
          }}
          disabled={rpcState?.model === null || rpcState?.model === undefined}
        >
          {t('session.saveModel')}
        </button>
      )}
    </div>
  );
}
