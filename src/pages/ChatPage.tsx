import { useEffect, useRef } from 'react';
import { useChatSession } from '../chat/chatState.js';
import { Composer } from '../components/Composer.js';
import { MessageItem } from '../components/MessageItem.js';
import { ModelBar } from '../components/ModelBar.js';
import './ChatPage.css';

export function ChatPage(): React.JSX.Element {
  const chat = useChatSession();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = scrollRef.current;
    if (element !== null) {
      element.scrollTop = element.scrollHeight;
    }
  }, [chat.messages.length, chat.isAgentRunning]);

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
            queued: {String(chat.pendingSteer.length)} steer · {String(chat.pendingFollowUp.length)} follow-up
          </div>
        ) : null}
        {chat.messages.length === 0 ? (
          <div className="chatpage-empty">
            <h2 className="panel-title">pi</h2>
            <p className="chatpage-empty-hint">
              Start a conversation with the pi agent. Messages stream here in
              real time via the RPC bridge.
            </p>
          </div>
        ) : (
          <div className="chatpage-stream">
            {chat.messages.map((item) => (
              <MessageItem key={item.key} message={item.message} isStreaming={item.isStreaming} />
            ))}
          </div>
        )}
      </div>
      <Composer
        isAgentRunning={chat.isAgentRunning}
        onSendPrompt={(text) => {
          void chat.sendPrompt(text);
        }}
        onSendSteer={(text) => {
          void chat.sendSteer(text);
        }}
        onAbort={() => {
          void chat.abort();
        }}
      />
    </section>
  );
}
