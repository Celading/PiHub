import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { useI18n } from '../i18n/I18nProvider.js';
import { api, type PromptImage } from '../api/client.js';
import type { PiCommand } from '../../shared/types.js';
import './Composer.css';

interface PendingImage extends PromptImage {
  previewUrl: string;
}

interface ComposerProps {
  isAgentRunning: boolean;
  onSendPrompt: (text: string, images?: PromptImage[]) => void;
  onSendSteer: (text: string) => void;
  onAbort: () => void;
}

export function Composer({
  isAgentRunning,
  onSendPrompt,
  onSendSteer,
  onAbort,
}: ComposerProps): React.JSX.Element {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [images, setImages] = useState<PendingImage[]>([]);
  const [commands, setCommands] = useState<PiCommand[] | null>(null);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
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
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
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

  return (
    <div className="composer">
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
          {isAgentRunning ? t('composer.hint.steer') : t('composer.hint')}
        </span>
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
  );
}
