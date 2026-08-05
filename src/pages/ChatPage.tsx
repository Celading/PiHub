import { useEffect, useRef, useState } from 'react';
import { useChatSession } from '../chat/chatState.js';
import { Composer } from '../components/Composer.js';
import { MessageItem } from '../components/MessageItem.js';
import { ModelBar } from '../components/ModelBar.js';
import { TerminalPanel } from '../components/TerminalPanel.js';
import { useI18n } from '../i18n/I18nProvider.js';
import './ChatPage.css';

export function ChatPage(): React.JSX.Element {
  const chat = useChatSession();
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasRunningRef = useRef(false);
  const [terminalOpen, setTerminalOpen] = useState(false);

  useEffect(() => {
    const element = scrollRef.current;
    if (element !== null) {
      element.scrollTop = element.scrollHeight;
    }
  }, [chat.messages.length, chat.isAgentRunning]);

  // Browser notification when the agent settles after a run.
  useEffect(() => {
    const wasRunning = wasRunningRef.current;
    wasRunningRef.current = chat.isAgentRunning;
    if (wasRunning && !chat.isAgentRunning && 'Notification' in window) {
      if (Notification.permission === 'granted') {
        new Notification(t('notify.settled.title'), { body: t('notify.settled.body') });
      } else if (Notification.permission === 'default') {
        void Notification.requestPermission().then((permission) => {
          if (permission === 'granted') {
            new Notification(t('notify.settled.title'), { body: t('notify.settled.body') });
          }
        });
      }
    }
  }, [chat.isAgentRunning, t]);

  return (
    <section className="chatpage">
      <ModelBar
        rpcState={chat.rpcState}
        onSetModel={(provider, modelId) => {
          void chat.setModel(provider, modelId);
        }}
        onSetThinking={(level) => {
          void chat.setThinkingLevel(level);
        }}
      />
      <div className="chatpage-scroll scroll-area" ref={scrollRef}>
        {chat.error !== null ? (
          <div className="chatpage-error mono">{chat.error}</div>
        ) : null}
        {chat.pendingSteer.length > 0 || chat.pendingFollowUp.length > 0 ? (
          <div className="chatpage-queue mono">
            {t('chat.queued', {
              steer: String(chat.pendingSteer.length),
              followUp: String(chat.pendingFollowUp.length),
            })}
          </div>
        ) : null}
        {chat.messages.length === 0 ? (
          <div className="chatpage-empty">
            <h2 className="panel-title">{t('chat.empty.title')}</h2>
            <p className="chatpage-empty-hint">{t('chat.empty.hint')}</p>
          </div>
        ) : (
          <div className="chatpage-stream">
            {chat.messages.map((item) => (
              <MessageItem key={item.key} message={item.message} isStreaming={item.isStreaming} />
            ))}
          </div>
        )}
      </div>
      {terminalOpen ? <TerminalPanel /> : null}
      <div className="chatpage-bottom">
        <button
          type="button"
          className="chatpage-terminal-toggle mono"
          onClick={() => {
            setTerminalOpen(!terminalOpen);
          }}
        >
          {terminalOpen ? '▾' : '▴'} {t('terminal.title')}
        </button>
        <Composer
          isAgentRunning={chat.isAgentRunning}
          onSendPrompt={(text, images) => {
            void chat.sendPrompt(text, images);
          }}
          onSendSteer={(text) => {
            void chat.sendSteer(text);
          }}
          onAbort={() => {
            void chat.abort();
          }}
        />
      </div>
    </section>
  );
}
