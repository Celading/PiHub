import { useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { useI18n } from '../i18n/I18nProvider.js';
import type { PromptImage } from '../api/client.js';
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

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="composer">
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
        className="composer-input"
        value={text}
        placeholder={isAgentRunning ? t('composer.placeholder.steer') : t('composer.placeholder')}
        onChange={(event) => {
          setText(event.target.value);
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
