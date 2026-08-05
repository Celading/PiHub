import { useState, type KeyboardEvent } from 'react';
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
        placeholder={isAgentRunning ? 'Steer the running agent…' : 'Message pi…'}
        onChange={(event) => {
          setText(event.target.value);
        }}
        onKeyDown={handleKeyDown}
        rows={3}
        aria-label="Message input"
      />
      <div className="composer-actions">
        <span className="composer-hint mono">
          {isAgentRunning ? 'steer mode · running' : 'enter to send · shift+enter for newline'}
        </span>
        {isAgentRunning ? (
          <button type="button" className="composer-abort" onClick={onAbort}>
            abort
          </button>
        ) : null}
        <button
          type="button"
          className="composer-send"
          onClick={submit}
          disabled={text.trim().length === 0}
        >
          {isAgentRunning ? 'steer' : 'send'}
        </button>
      </div>
    </div>
  );
}
