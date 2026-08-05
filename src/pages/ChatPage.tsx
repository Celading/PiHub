import { useEffect, useRef, useState } from 'react';
import { useChatSession, type ChatMessage } from '../chat/chatState.js';
import { Composer } from '../components/Composer.js';
import { IconButton } from '../components/IconButton.js';
import { MessageItem, type ThinkingStatus } from '../components/MessageItem.js';
import { TerminalPanel } from '../components/TerminalPanel.js';
import { useI18n, type Locale } from '../i18n/I18nProvider.js';
import { useLabFlag } from '../lab/labFlags.js';
import { archiveSession } from '../sessions/sessionActions.js';
import { api } from '../api/client.js';
import './ChatPage.css';

/** One user prompt and everything that followed it until the next prompt. */
interface ChatUnit {
  key: string;
  user: ChatMessage | null;
  rest: ChatMessage[];
}

function buildUnits(messages: ChatMessage[]): ChatUnit[] {
  const units: ChatUnit[] = [];
  for (const item of messages) {
    if (item.message.role === 'user') {
      units.push({ key: item.key, user: item, rest: [] });
    } else {
      const last = units[units.length - 1];
      if (last !== undefined) {
        last.rest.push(item);
      } else {
        // Resumed sessions may start mid-conversation; keep an orphan unit.
        units.push({ key: `orphan-${item.key}`, user: null, rest: [item] });
      }
    }
  }
  return units;
}

function formatDuration(ms: number, locale: Locale): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  if (locale === 'zh') {
    return `${pad(hours)}时${pad(minutes)}分${pad(seconds)}秒`;
  }
  return `${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`;
}

interface ChatPageProps {
  onSessionChanged: () => void;
}

export function ChatPage({ onSessionChanged }: ChatPageProps): React.JSX.Element {
  const chat = useChatSession();
  const { t, locale } = useI18n();
  const settledNotify = useLabFlag('settledNotify');
  const simplifiedOutput = useLabFlag('simplifiedOutput');
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasRunningRef = useRef(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [collapsedUnits, setCollapsedUnits] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // Simplified output: settled workflows auto-collapse; this set tracks the
  // ones the user explicitly expanded.
  const [userExpanded, setUserExpanded] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  useEffect(() => {
    const element = scrollRef.current;
    if (element !== null) {
      element.scrollTop = element.scrollHeight;
    }
  }, [chat.messages.length, chat.isAgentRunning]);

  // Browser notification when the agent settles after a run (lab switch).
  useEffect(() => {
    if (!settledNotify) {
      return;
    }
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
  }, [chat.isAgentRunning, settledNotify, t]);

  const units = buildUnits(chat.messages);
  const lastUnit = units[units.length - 1];
  const runSummary = chat.lastRun;
  const thinkingStatus: ThinkingStatus =
    chat.isAgentRunning && lastUnit !== undefined && lastUnit.user !== null
      ? 'active'
      : runSummary !== null && runSummary.aborted
        ? 'interrupted'
        : 'done';

  const toggleCollapsed = (key: string): void => {
    if (simplifiedOutput) {
      setUserExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(key)) {
          next.delete(key);
        } else {
          next.add(key);
        }
        return next;
      });
      return;
    }
    setCollapsedUnits((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  return (
    <section className="chatpage">
      <div className="chatpage-toolbar">
        <div className="chatpage-toolbar-spacer" />
        <div className="chatpage-toolbar-actions">
          <IconButton
            icon="hico-square-grid"
            label={t('sidebar.newBranch')}
            placement="bottom"
            onClick={() => {
              void api
                .cloneSession()
                .then((response) => {
                  if (response.success) {
                    onSessionChanged();
                  }
                })
                .catch(() => {
                  // chat state surfaces backend errors
                });
            }}
          />
          <IconButton
            icon="hico-rectangle-stack"
            label={t('sidebar.archive')}
            placement="bottom"
            onClick={() => {
              const file = chat.rpcState?.sessionFile;
              if (file !== undefined && file.length > 0) {
                archiveSession(file);
                onSessionChanged();
              }
            }}
          />
        </div>
      </div>
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
            {units.map((unit, unitIndex) => {
              const isLast = unit === lastUnit;
              const isRunningUnit = isLast && chat.isAgentRunning && unit.user !== null;
              const isSettledUnit = isLast && !chat.isAgentRunning && runSummary !== null && unit.user !== null;
              const showSummary =
                (isRunningUnit || isSettledUnit) && unit.user !== null;
              // Simplified output auto-collapses settled workflows; the
              // "....." marker then hints that more content is folded.
              const autoCollapsed =
                simplifiedOutput && isSettledUnit && !userExpanded.has(unit.key);
              const collapsed =
                autoCollapsed || collapsedUnits.has(unit.key);
              return (
                <div
                  key={unit.key}
                  className="chat-unit"
                  data-collapsed={collapsed}
                >
                  {!collapsed ? (
                    <div className="chat-unit-body">
                      {unit.user !== null ? (
                        <MessageItem
                          message={unit.user.message}
                          isStreaming={false}
                        />
                      ) : null}
                      {unit.rest.map((item) => (
                        <MessageItem
                          key={item.key}
                          message={item.message}
                          isStreaming={item.isStreaming}
                          thinkingStatus={
                            unitIndex === units.length - 1 ? thinkingStatus : 'done'
                          }
                        />
                      ))}
                    </div>
                  ) : null}
                  {showSummary ? (
                    <div className="chat-unit-summary">
                      <button
                        type="button"
                        className="chat-unit-summary-line mono"
                        onClick={() => {
                          toggleCollapsed(unit.key);
                        }}
                        aria-expanded={!collapsed}
                        aria-label={t('workflow.collapse')}
                      >
                        {isRunningUnit ? (
                          <>
                            <span className="hico hico-waveform chat-unit-running" aria-hidden="true" />
                            <span>{t('workflow.running')}</span>
                          </>
                        ) : runSummary !== null && runSummary.aborted ? (
                          <>
                            <span className="hico hico-exclamationmark chat-unit-aborted" aria-hidden="true" />
                            <span>{t('workflow.interrupted')}</span>
                          </>
                        ) : (
                          <>
                            <span className="hico hico-clock chat-unit-elapsed" aria-hidden="true" />
                            <span>
                              {t('workflow.elapsed', {
                                time: formatDuration(runSummary?.durationMs ?? 0, locale),
                              })}
                            </span>
                          </>
                        )}
                        <span className="chat-unit-chevron" aria-hidden="true">
                          {collapsed ? '>' : '>'}
                        </span>
                      </button>
                      {isSettledUnit ? (
                        <>
                          {/* Full-width divider line closing the workflow */}
                          <div className="chat-unit-divider" aria-hidden="true" />
                          {collapsed ? (
                            <div className="chat-unit-settle mono" aria-hidden="true">
                              .....
                            </div>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
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
          rpcState={chat.rpcState}
          onSendPrompt={(text, images) => {
            void chat.sendPrompt(text, images);
          }}
          onSendSteer={(text) => {
            void chat.sendSteer(text);
          }}
          onAbort={() => {
            void chat.abort();
            window.dispatchEvent(new Event('pihub:run-aborted'));
          }}
          onSetModel={(provider, modelId) => {
            void chat.setModel(provider, modelId);
          }}
          onSetThinking={(level) => {
            void chat.setThinkingLevel(level);
          }}
        />
      </div>
    </section>
  );
}
