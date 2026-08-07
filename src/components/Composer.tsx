import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { useI18n } from '../i18n/I18nProvider.js';
import { api, type PromptImage } from '../api/client.js';
import { addFavorite } from '../favorites/favoritesStore.js';
import { usePref } from '../prefs/preferences.js';
import type { PiCommand, RpcState } from '../../shared/types.js';
import './Composer.css';

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

interface PendingImage extends PromptImage {
  previewUrl: string;
}

import { ModelPicker } from './ModelPicker.js';

interface ModelOption {
  provider: string;
  modelId: string;
  label: string;
  /** First-level picker name: channel alias ?? provider key (P1-14). */
  alias: string;
  /** User-defined display name (italic in the picker). */
  customName: boolean;
  /** Channel without an API key. */
  locked: boolean;
}

interface ComposerProps {
  isAgentRunning: boolean;
  /** Optional: when absent (e.g. session detail resume composer) the
   *  model/thinking row is not rendered. */
  rpcState?: RpcState | null;
  /** P1-18: chat scrolled away from the bottom — the composer morphs into
   *  a slim bottom bar; click or Cmd/Ctrl+R expands it. */
  compact?: boolean;
  onToggleCompact?: () => void;
  onSendPrompt: (text: string, images?: PromptImage[]) => void;
  onSendSteer: (text: string) => void;
  onAbort: () => void;
  onSetModel?: (provider: string, modelId: string) => void;
  onSetThinking?: (level: string) => void;
}

export function Composer({
  isAgentRunning,
  rpcState,
  compact = false,
  onToggleCompact,
  onSendPrompt,
  onSendSteer,
  onAbort,
  onSetModel,
  onSetThinking,
}: ComposerProps): React.JSX.Element {
  const { t } = useI18n();
  const sendMode = usePref('sendMode');
  const [text, setText] = useState('');
  const [images, setImages] = useState<PendingImage[]>([]);
  const [commands, setCommands] = useState<PiCommand[] | null>(null);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [favoriteNotice, setFavoriteNotice] = useState(false);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load commands once for the "/" suggestion surface.
  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const list = await api.commands();
        if (!cancelled) {
          setCommands(list);
        }
      } catch {
        if (!cancelled) {
          setCommands([]);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load model options once for the inline model selector (phase-3: the
  // model/thinking controls moved down next to the send button). Merges the
  // pi model store with the panel's custom channels (models.json) so
  // configured providers are switchable from the chat (P1-13 A).
  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const [storeRes, configRes] = await Promise.all([
          api.models(),
          api.modelsConfig().catch(() => null),
        ]);
        if (cancelled) {
          return;
        }
        const flat: ModelOption[] = [];
        for (const entry of storeRes.providers) {
          for (const model of entry.models) {
            flat.push({
              provider: entry.provider,
              alias: entry.provider,
              modelId: model.id,
              label: model.name,
              customName: false,
              locked: false,
            });
          }
        }
        const config = configRes as
          | {
              providers?: Record<
                string,
                {
                  name?: string;
                  alias?: string;
                  apiKey?: string;
                  models?: Array<{ id: string; name?: string }>;
                }
              >;
            }
          | null
          | undefined;
        const providers = config?.providers;
        if (providers !== undefined) {
          for (const [key, provider] of Object.entries(providers)) {
            const hasKey = typeof provider.apiKey === 'string' && provider.apiKey.length > 0;
            const alias =
              typeof provider.alias === 'string' && provider.alias.length > 0
                ? provider.alias
                : key;
            for (const model of provider.models ?? []) {
              const display = model.name ?? model.id;
              flat.push({
                provider: key,
                alias,
                modelId: model.id,
                label: display,
                customName: model.name !== undefined && model.name !== model.id,
                locked: !hasKey,
              });
            }
          }
        }
        setModelOptions(flat);
      } catch {
        if (!cancelled) {
          setModelOptions([]);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const modelChanged = (value: string): void => {
    if (onSetModel === undefined) {
      return;
    }
    const option = modelOptions.find(
      (item) => `${item.provider}/${item.modelId}` === value,
    );
    if (option !== undefined) {
      onSetModel(option.provider, option.modelId);
    }
  };

  const slashSuggestions = useMemo(() => {
    if (!slashOpen || commands === null) {
      return [];
    }
    const raw = text.slice(1);
    const needle = raw.trim().toLowerCase();
    const filtered = commands.filter((command) => {
      return (
        needle.length === 0 ||
        command.name.toLowerCase().includes(needle) ||
        (command.description ?? '').toLowerCase().includes(needle)
      );
    });
    return filtered.slice(0, 8);
  }, [slashOpen, commands, text]);

  useEffect(() => {
    setSlashIndex(0);
  }, [text]);

  const applySuggestion = (commandName: string): void => {
    setText(`/${commandName} `);
    setSlashOpen(false);
    textareaRef.current?.focus();
  };

  const handleTextChange = (value: string): void => {
    setText(value);
    const isSlashMode = value.startsWith('/') && !value.includes(' ');
    setSlashOpen(isSlashMode);
  };

  const isSubmitKey = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) {
      return false;
    }
    if (sendMode === 'enter') {
      return true;
    }
    if (sendMode === 'cmd-enter') {
      return event.metaKey;
    }
    return event.ctrlKey;
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (slashOpen && slashSuggestions.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSlashIndex((prev) => (prev + 1) % slashSuggestions.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSlashIndex((prev) => (prev - 1 + slashSuggestions.length) % slashSuggestions.length);
        return;
      }
      if (event.key === 'Tab' || event.key === 'Enter') {
        const suggestion = slashSuggestions[slashIndex];
        if (suggestion !== undefined) {
          event.preventDefault();
          applySuggestion(suggestion.name);
        }
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setSlashOpen(false);
        return;
      }
    }
    if (isSubmitKey(event)) {
      event.preventDefault();
      submit();
    }
  };

  const submit = (): void => {
    const trimmed = text.trim();
    if (trimmed.length === 0 && images.length === 0) {
      return;
    }
    if (isAgentRunning) {
      if (trimmed.length > 0) {
        onSendSteer(trimmed);
      }
    } else {
      onSendPrompt(
        trimmed,
        images.map((image) => ({
          type: image.type,
          data: image.data,
          ...(image.mimeType === undefined ? {} : { mimeType: image.mimeType }),
        })),
      );
    }
    setText('');
    setImages([]);
    setSlashOpen(false);
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const items = event.clipboardData.items;
    const imageFiles: File[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item === undefined || !item.type.startsWith('image/')) {
        continue;
      }
      const file = item.getAsFile();
      if (file !== null) {
        imageFiles.push(file);
      }
    }
    if (imageFiles.length === 0) {
      return;
    }
    event.preventDefault();
    for (const file of imageFiles) {
      const reader = new FileReader();
      reader.onload = () => {
        const data = typeof reader.result === 'string' ? reader.result : '';
        const base64 = data.startsWith('data:') ? data.slice(data.indexOf(',') + 1) : data;
        setImages((prev) => [
          ...prev,
          {
            type: 'image',
            data: base64,
            mimeType: file.type,
            previewUrl: data,
          },
        ]);
      };
      reader.readAsDataURL(file);
    }
  };

  // navigator.platform is deprecated; macOS detection via userAgentData falls
  // back to the user agent string (P1-18 shortcut hint).
  const isMac =
    typeof navigator !== 'undefined' &&
    ((navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform === 'macOS' ||
      /Mac|iPhone|iPad/i.test(navigator.userAgent));
  const shortcut = isMac ? '⌘R' : 'Ctrl+R';

  return (
    <div className="composer" data-compact={compact} data-shot="composer">
      {/* P1-18: slim bottom bar while the chat is scrolled away from the
          bottom; click or Cmd/Ctrl+R expands the composer back. */}
      <button
        type="button"
        className="composer-compact-bar mono"
        aria-expanded={!compact}
        onClick={() => {
          onToggleCompact?.();
        }}
      >
        <span className="composer-compact-arrow" aria-hidden="true">
          ↑
        </span>
        <span>{t('composer.compactHint', { shortcut })}</span>
      </button>
      {slashOpen && slashSuggestions.length > 0 ? (
        <div className="composer-slash" role="listbox" aria-label={t('sidebar.features')}>
          {slashSuggestions.map((suggestion, index) => (
            <button
              key={`${suggestion.source}:${suggestion.name}`}
              type="button"
              className="composer-slash-item"
              data-active={index === slashIndex}
              role="option"
              aria-selected={index === slashIndex}
              onMouseEnter={() => {
                setSlashIndex(index);
              }}
              onClick={() => {
                applySuggestion(suggestion.name);
              }}
            >
              <span className="composer-slash-name mono">/{suggestion.name}</span>
              {suggestion.description !== undefined && suggestion.description.length > 0 ? (
                <span className="composer-slash-desc">{suggestion.description}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
      {/* P1-18: the composer body collapses into the bar via the grid-rows
          animation when the chat is scrolled away from the bottom. */}
      <div className="composer-collapse collapse-region" data-collapsed={compact}>
        <div className="collapse-region-inner">
          {isAgentRunning ? (
            <div className="composer-progress" aria-hidden="true">
              {[0, 1, 2, 3, 4].map((index) => (
                <span
                  key={index}
                  className="composer-progress-square"
                  style={{ animationDelay: `${String(index * 0.12)}s` }}
                />
              ))}
            </div>
          ) : null}
          {images.length > 0 ? (
            <div className="composer-images">
              {images.map((image, index) => (
                <div key={index} className="composer-image-wrap">
                  <img className="composer-image" src={image.previewUrl} alt={`pasted ${String(index + 1)}`} />
                  <button
                    type="button"
                    className="composer-image-remove"
                    aria-label="remove image"
                    onClick={() => {
                      setImages((prev) => prev.filter((_, i) => i !== index));
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <textarea
            ref={textareaRef}
            className="composer-input"
            value={text}
            placeholder={isAgentRunning ? t('composer.placeholder.steer') : t('composer.placeholder')}
            onChange={(event) => {
              handleTextChange(event.target.value);
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            rows={3}
            aria-label={t('composer.placeholder')}
          />
          <div className="composer-actions">
            <span className="composer-hint mono">
              {isAgentRunning
                ? t('composer.hint.steer')
                : sendMode === 'cmd-enter'
                  ? t('composer.hint.cmdEnter')
                  : sendMode === 'ctrl-enter'
                    ? t('composer.hint.ctrlEnter')
                    : t('composer.hint')}
            </span>
        {/* Model / thinking shown as quiet inline text on the action row
            (owner: static display, small font, 0.7 opacity; selection takes
            effect immediately — no save button). */}
        {rpcState !== undefined && rpcState !== null && onSetModel !== undefined && onSetThinking !== undefined ? (
          <span className="composer-model-fields">
            <label className="modelbar-field">
              <span className="modelbar-label mono">{t('modelbar.model')}</span>
              <ModelPicker
                options={modelOptions}
                value={`${rpcState.model?.provider ?? ''}/${rpcState.model?.id ?? ''}`}
                onSelect={(provider, modelId) => {
                  modelChanged(`${provider}/${modelId}`);
                }}
                label={rpcState.model?.name ?? 'model'}
              />
            </label>
            <label className="modelbar-field">
              <span className="modelbar-label mono">{t('modelbar.thinking')}</span>
              <select
                className="modelbar-select"
                value={rpcState.thinkingLevel}
                onChange={(event) => {
                  onSetThinking(event.target.value);
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
          </span>
        ) : null}
        <button
          type="button"
          className="composer-favorite"
          title={t('composer.favorite')}
          aria-label={t('composer.favorite')}
          disabled={text.trim().length === 0}
          onClick={() => {
            addFavorite(text);
            setFavoriteNotice(true);
            window.setTimeout(() => {
              setFavoriteNotice(false);
            }, 1800);
          }}
        >
          <span className="hico hico-bookmark" aria-hidden="true" />
          {favoriteNotice ? (
            <span className="composer-favorite-notice mono">{t('composer.favoriteAdded')}</span>
          ) : null}
        </button>
        {isAgentRunning ? (
          <button type="button" className="composer-abort" onClick={onAbort}>
            {t('composer.abort')}
          </button>
        ) : null}
        <button
          type="button"
          className="composer-send"
          onClick={submit}
          disabled={text.trim().length === 0 && images.length === 0}
        >
          {isAgentRunning ? t('composer.steer') : t('composer.send')}
        </button>
          </div>
        </div>
      </div>
    </div>
  );
}
