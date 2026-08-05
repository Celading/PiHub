import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useI18n } from '../i18n/I18nProvider.js';
import './TerminalPanel.css';

interface TerminalLine {
  key: string;
  text: string;
  isError: boolean;
}

let terminalKey = 0;

/**
 * Lightweight bash panel: runs commands through the pi RPC bash tool and
 * streams `bash_execution_update` output chunks live. No xterm.js dependency.
 */
export function TerminalPanel(): React.JSX.Element {
  const { t } = useI18n();
  const [lines, setLines] = useState<TerminalLine[]>([]);
  const [command, setCommand] = useState('');
  const [running, setRunning] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const source = new EventSource('/api/events');
    const onPiEvent = (event: MessageEvent<string>): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data) as unknown;
      } catch {
        return;
      }
      if (typeof parsed !== 'object' || parsed === null) {
        return;
      }
      const record = parsed as Record<string, unknown>;
      if (record['type'] === 'bash_execution_update') {
        const delta = record['delta'];
        if (typeof delta === 'string') {
          setLines((prev) => [
            ...prev,
            { key: `l${String(terminalKey++)}`, text: delta, isError: false },
          ]);
        }
      }
    };
    source.addEventListener('pi', onPiEvent);
    return () => {
      source.close();
    };
  }, []);

  useEffect(() => {
    const element = scrollRef.current;
    if (element !== null) {
      element.scrollTop = element.scrollHeight;
    }
  }, [lines.length]);

  const run = useCallback(async (): Promise<void> => {
    const trimmed = command.trim();
    if (trimmed.length === 0 || running) {
      return;
    }
    setCommand('');
    setRunning(true);
    setLines((prev) => [
      ...prev,
      { key: `l${String(terminalKey++)}`, text: `$ ${trimmed}`, isError: false },
    ]);
    try {
      const response = await api.bash(trimmed);
      if (!response.success) {
        setLines((prev) => [
          ...prev,
          { key: `l${String(terminalKey++)}`, text: response.error ?? 'bash failed', isError: true },
        ]);
      }
    } catch (err) {
      setLines((prev) => [
        ...prev,
        { key: `l${String(terminalKey++)}`, text: err instanceof Error ? err.message : String(err), isError: true },
      ]);
    }
    setRunning(false);
  }, [command, running]);

  const abort = useCallback(async (): Promise<void> => {
    try {
      await api.abortBash();
    } catch {
      // ignore; terminal state resets on next run
    }
    setRunning(false);
  }, []);

  return (
    <div className="terminal">
      <div className="terminal-head">
        <span className="terminal-title mono">{t('terminal.title')}</span>
        <span className="terminal-hint mono">{t('terminal.hint')}</span>
      </div>
      <div className="terminal-output scroll-area" ref={scrollRef}>
        {lines.length === 0 ? (
          <p className="terminal-empty mono">{t('terminal.noOutput')}</p>
        ) : (
          lines.map((line) => (
            <div key={line.key} className="terminal-line mono" data-error={line.isError}>
              {line.text}
            </div>
          ))
        )}
        {running ? <div className="terminal-cursor mono">▌</div> : null}
      </div>
      <div className="terminal-input-row">
        <input
          className="terminal-input mono"
          type="text"
          value={command}
          placeholder={t('terminal.placeholder')}
          disabled={running}
          onChange={(event) => {
            setCommand(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              void run();
            }
          }}
          aria-label={t('terminal.placeholder')}
        />
        {running ? (
          <button type="button" className="terminal-abort" onClick={() => { void abort(); }}>
            {t('terminal.abort')}
          </button>
        ) : null}
        <button type="button" className="terminal-run" onClick={() => { void run(); }} disabled={running || command.trim().length === 0}>
          {t('terminal.run')}
        </button>
      </div>
    </div>
  );
}
