import { useEffect, useState } from 'react';
import type { RpcState } from '../../shared/types.js';
import { api } from '../api/client.js';
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
  const [options, setOptions] = useState<ModelOption[]>([]);

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
        <span className="modelbar-label mono">model</span>
        <select
          className="modelbar-select"
          value={`${currentModel?.provider ?? ''}/${currentModel?.id ?? ''}`}
          onChange={(event) => {
            handleModelChange(event.target.value);
          }}
          aria-label="Model"
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
        <span className="modelbar-label mono">thinking</span>
        <select
          className="modelbar-select"
          value={rpcState?.thinkingLevel ?? 'off'}
          onChange={(event) => {
            handleThinkingChange(event.target.value);
          }}
          aria-label="Thinking level"
        >
          {THINKING_LEVELS.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
