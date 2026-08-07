import { useEffect, useMemo, useState } from 'react';
import './ModelPicker.css';

/**
 * Two-level model picker (P1-14): first level = channel alias (the provider
 * key or its custom alias), second level = models. Custom model display
 * names (name ≠ id) render in italic to mark user-defined labels; channels
 * without an API key show a lock hint. Replaces the flat native select.
 */
export interface ModelOption {
  provider: string;
  /** First-level menu name: channel alias ?? provider key. */
  alias: string;
  modelId: string;
  /** Second-level display name (custom name or the model id). */
  label: string;
  /** True when label is a user-defined display name (italic). */
  customName: boolean;
  /** True when the channel has no API key configured. */
  locked: boolean;
}

interface ModelPickerProps {
  options: ModelOption[];
  /** Current selection: `${provider}/${modelId}`. */
  value: string;
  onSelect: (provider: string, modelId: string) => void;
  label: string;
}

export function ModelPicker({
  options,
  value,
  onSelect,
  label,
}: ModelPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const groups = useMemo(() => {
    const map = new Map<string, ModelOption[]>();
    for (const option of options) {
      const list = map.get(option.alias);
      if (list !== undefined) {
        list.push(option);
      } else {
        map.set(option.alias, [option]);
      }
    }
    return [...map.entries()];
  }, [options]);

  // Store and user-channel entries can share `${provider}/${modelId}` (same
  // model via a different channel). Resolve the selection deterministically:
  // prefer the entry whose label equals the session-reported model name
  // (the truthful channel), else the first match — never two checkmarks.
  const current =
    options.find(
      (option) =>
        `${option.provider}/${option.modelId}` === value && option.label === label,
    ) ?? options.find((option) => `${option.provider}/${option.modelId}` === value);

  return (
    <div className="model-picker">
      <button
        type="button"
        className="model-picker-trigger mono"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <span className="model-picker-current">
          {current !== undefined ? `${current.alias}/${current.label}` : label}
        </span>
        <span className="model-picker-chevron" aria-hidden="true">
          {open ? '−' : '>'}
        </span>
      </button>
      {open ? (
        <>
          <div
            className="model-picker-overlay"
            role="presentation"
            onClick={() => {
              setOpen(false);
            }}
          />
          <div className="model-picker-menu" role="listbox" aria-label={label}>
            {groups.map(([alias, items]) => (
              <div key={alias} className="model-picker-group">
                {/* Custom channel aliases (alias ≠ provider key) render in
                    italic, mirroring the custom model-name convention. */}
                <div
                  className="model-picker-group-head mono"
                  data-custom={items[0] !== undefined && alias !== items[0].provider}
                >
                  {alias}
                </div>
                {items.map((option) => {
                  const selected = option === current;
                  return (
                    <button
                      key={`${option.provider}/${option.modelId}`}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className="model-picker-item mono"
                      data-custom={option.customName}
                      data-selected={selected}
                      onClick={() => {
                        onSelect(option.provider, option.modelId);
                        setOpen(false);
                      }}
                    >
                      <span className="model-picker-item-label" data-locked={option.locked}>
                        {option.locked ? '🔒 ' : ''}
                        {option.label}
                      </span>
                      {selected ? (
                        <span className="model-picker-check" aria-hidden="true">
                          ✓
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
