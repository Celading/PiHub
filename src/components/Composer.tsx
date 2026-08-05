import { useState, type KeyboardEvent } from 'react';
import { useI18n } from '../i18n/I18nProvider.js';
import './Composer.css';

interface ComposerProps {
  isAgentRunning: boolean;
  onSendPrompt: (text: string) => void;
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

  const submit = (): void => {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return;
    }
    if (isAgentRunning) {
      onSendSteer(trimmed);
    } else {
      onSendPrompt(trimmed);
    }
    setText('');
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="composer">
      <textarea
        className="composer-input"
        value={text}
        placeholder={isAgentRunning ? t('composer.placeholder.steer') : t('composer.placeholder')}
        onChange={(event) => {
          setText(event.target.value);
        }}
        onKeyDown={handleKeyDown}
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
          disabled={text.trim().length === 0}
        >
          {isAgentRunning ? t('composer.steer') : t('composer.send')}
        </button>
      </div>
    </div>
  );
}
