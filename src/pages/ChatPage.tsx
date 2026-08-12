import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChatSession, type ChatMessage } from '../chat/chatState.js';
import { Composer } from '../components/Composer.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { IconButton } from '../components/IconButton.js';
import { MessageItem, type ThinkingStatus } from '../components/MessageItem.js';
import { FilePreview } from '../components/FilePreview.js';
import { TerminalPanel } from '../components/TerminalPanel.js';
import { useI18n, type Locale } from '../i18n/I18nProvider.js';
import { useLabFlag } from '../lab/labFlags.js';
import { useMode } from '../kMode/useMode.js';
import { api } from '../api/client.js';
import type { AgentMessage } from '../../shared/types.js';
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

/** Extracts the assistant reply as plain markdown text (copy primitive). */
function extractAssistantMarkdown(message: AgentMessage): string {
  if (message.role !== 'assistant') {
    return '';
  }
  return message.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')
    .trim();
}

/** Showcase sprint: the one-line final summary of a settled unit — the last
 *  assistant reply, whitespace-collapsed and capped for the settle line. */
function finalReplySummary(unit: ChatUnit): string | null {
  const last = [...unit.rest].reverse().find((item) => item.message.role === 'assistant');
  if (last === undefined) {
    return null;
  }
  const text = extractAssistantMarkdown(last.message).replace(/\s+/g, ' ').trim();
  if (text.length === 0) {
    return null;
  }
  return text.length > 96 ? `${text.slice(0, 96)}…` : text;
}

/** Extracts the user prompt text (copy + edit primitives, P1-13 D/E). */
function extractUserPrompt(message: ChatMessage | null): string {
  if (message === null || message.message.role !== 'user') {
    return '';
  }
  const content = message.message.content;
  if (typeof content === 'string') {
    return content;
  }
  return content
    .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('\n')
    .trim();
}

/** Items that belong in the collapsed tool cluster only.
 *  Assistant messages that also carry text/thinking must stay in the main
 *  stream — otherwise the moment a toolCall block is appended mid-stream the
 *  whole reply vanishes into the (default-collapsed) cluster, which looks
 *  like flickering "text appears then disappears until the run finishes". */
function isToolMessage(item: ChatMessage): boolean {
  if (item.message.role === 'toolResult' || item.message.role === 'bashExecution') {
    return true;
  }
  if (item.message.role === 'assistant') {
    const { content } = item.message;
    return content.length > 0 && content.every((block) => block.type === 'toolCall');
  }
  return false;
}

/** Tool-cluster collapse (P1-10 C3): all tool blocks of one prompt run fold
 *  into a single set with a tool-name list header. */
function ToolCluster({
  items,
  onOpenFile,
}: {
  items: ChatMessage[];
  onOpenFile?: ((path: string) => void) | undefined;
}): React.JSX.Element {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const names = [
    ...new Set(
      items
        .map((item) => {
          if (item.message.role === 'toolResult') {
            return item.message.toolName;
          }
          if (item.message.role === 'bashExecution') {
            return 'bash';
          }
          if (item.message.role === 'assistant') {
            const call = item.message.content.find((block) => block.type === 'toolCall');
            return call?.type === 'toolCall' && typeof call.name === 'string' ? call.name : '';
          }
          return '';
        })
        .filter((name) => name.length > 0),
    ),
  ];
  return (
    <div className="tool-cluster" data-expanded={expanded}>
      <button
        type="button"
        className="tool-cluster-header mono"
        onClick={() => {
          setExpanded(!expanded);
        }}
        aria-expanded={expanded}
      >
        <span className="hico hico-rectangle-stack" aria-hidden="true" />
        <span>{t('workflow.tools', { names: names.join(' / ') })}</span>
        <span className="tool-cluster-chevron" aria-hidden="true">
          {expanded ? '−' : '+'}
        </span>
      </button>
      {expanded ? (
        <div className="tool-cluster-body">
          {items.map((item) => (
            <MessageItem key={item.key} message={item.message} isStreaming={item.isStreaming} onOpenFile={onOpenFile} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * P1-16 E: a settled prompt run can leave several `.message message-assistant`
 * entries — only the LAST one is kept fully visible; the earlier ones fold
 * behind a process toggle (animated via the collapse-region grid rows).
 * P1-17 B: the toggle shows the run's total working duration.
 */
function AssistantProcessCollapse({
  items,
  durationLabel,
  onOpenFile,
}: {
  items: ChatMessage[];
  durationLabel: string | null;
  onOpenFile?: ((path: string) => void) | undefined;
}): React.JSX.Element {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="assistant-process">
      <button
        type="button"
        className="assistant-process-toggle mono"
        data-shot="process"
        aria-expanded={expanded}
        onClick={() => {
          setExpanded(!expanded);
        }}
      >
        <span className="assistant-process-chevron" aria-hidden="true">
          {expanded ? '−' : '>'}
        </span>
        <span>{t('chat.processPrefix', { count: String(items.length) })}</span>
        {durationLabel !== null ? (
          <span className="assistant-process-duration" aria-label={durationLabel}>
            {durationLabel}
          </span>
        ) : null}
      </button>
      <div className="collapse-region" data-collapsed={!expanded}>
        <div className="collapse-region-inner">
          {items.map((item) => (
            <MessageItem key={item.key} message={item.message} isStreaming={false} thinkingStatus="done" onOpenFile={onOpenFile} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** P1-17 B: wall-clock span of a prompt run, from the first to the last
 *  message of the unit (epoch-ms timestamps), or null when undeterminable. */
function runDurationLabel(items: ChatMessage[]): string | null {
  const times = items
    .map((item) => item.message.timestamp)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (times.length < 2) {
    return null;
  }
  const spanMs = Math.max(0, (times[times.length - 1] ?? 0) - (times[0] ?? 0));
  const totalSeconds = Math.round(spanMs / 1000);
  if (totalSeconds < 60) {
    return `${String(totalSeconds)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes)}m ${String(seconds).padStart(2, '0')}s`;
}

interface ChatPageProps {
  onSessionChanged: () => void;
}

export function ChatPage({ onSessionChanged }: ChatPageProps): React.JSX.Element {
  const chat = useChatSession();
  const { t, locale } = useI18n();
  const mode = useMode();
  const settledNotify = useLabFlag('settledNotify');
  const simplifiedOutput = useLabFlag('simplifiedOutput');
  // Showcase sprint: a settled run folds into one block (with a final
  // summary line) instead of leaving the whole tool chain visible.
  const settledCollapse = useLabFlag('settledCollapse');
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasRunningRef = useRef(false);

  // Showcase sprint: in demo mode, auto-play the scripted conversation so
  // the panel performs the whole feature showcase (typewriter, tool chain,
  // settle collapse) without any input. The play resets the mock session;
  // reload then sees an empty conversation and the SSE stream fills it.
  const chatReload = chat.reload;
  useEffect(() => {
    if (mode !== 'demo') {
      return;
    }
    void (async () => {
      try {
        await api.demoPlay();
      } catch {
        // demo backend offline; the pre-seeded dataset stays visible
      }
      await chatReload();
    })();
  }, [mode, chatReload]);
  const [terminalOpen, setTerminalOpen] = useState(false);
  // P1-18: composer morphs into a bottom bar while the chat scroll is not
  // at the bottom; clicking the bar or Cmd/Ctrl+R expands it (forced).
  const [atBottom, setAtBottom] = useState(true);
  const [composerForced, setComposerForced] = useState(false);
  // P1-03: read-only file preview + recent file operations.
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [collapsedUnits, setCollapsedUnits] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // Simplified output: settled workflows auto-collapse; this set tracks the
  // ones the user explicitly expanded.
  const [userExpanded, setUserExpanded] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const updateAtBottom = useCallback((): void => {
    const element = scrollRef.current;
    if (element === null) {
      return;
    }
    // Within ~96px of the bottom counts as "at the bottom".
    const near = element.scrollHeight - element.scrollTop - element.clientHeight <= 96;
    setAtBottom(near);
    if (near) {
      setComposerForced(false);
    }
  }, []);

  useEffect(() => {
    const element = scrollRef.current;
    if (element !== null) {
      element.scrollTop = element.scrollHeight;
      updateAtBottom();
    }
  }, [chat.messages.length, chat.isAgentRunning, updateAtBottom]);

  // P1-18: Cmd/Ctrl+R toggles the compact composer bar.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'r') {
        event.preventDefault();
        setComposerForced((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  // P1-03 D: recent file operations aggregated from the tool calls of the
  // visible conversation (most recent unique paths, capped).
  const recentFiles = useMemo(() => {
    const out: Array<{ path: string; action: string }> = [];
    const seen = new Set<string>();
    for (let index = chat.messages.length - 1; index >= 0 && out.length < 12; index -= 1) {
      const item = chat.messages[index];
      if (item === undefined || item.message.role !== 'assistant') {
        continue;
      }
      for (const block of item.message.content) {
        if (block.type !== 'toolCall') {
          continue;
        }
        const name = typeof block.name === 'string' ? block.name : '';
        if (name !== 'read' && name !== 'write' && name !== 'edit' && name !== 'patch') {
          continue;
        }
        const args =
          typeof block.arguments === 'object' && block.arguments !== null
            ? (block.arguments as Record<string, unknown>)
            : {};
        const rawPath =
          typeof args['path'] === 'string'
            ? args['path']
            : typeof args['filePath'] === 'string'
              ? args['filePath']
              : typeof args['file'] === 'string'
                ? args['file']
                : null;
        if (rawPath === null || rawPath.length === 0 || seen.has(rawPath)) {
          continue;
        }
        seen.add(rawPath);
        out.push({ path: rawPath, action: name });
      }
    }
    return out;
  }, [chat.messages]);

  const openFile = useCallback((filePath: string): void => {
    setPreviewPath(filePath);
  }, []);

  // Refresh the model display when the model is cycled via Ctrl+Shift+L.
  useEffect(() => {
    const onCycled = (): void => {
      void chat.refreshState();
    };
    window.addEventListener('pihub:model-cycled', onCycled);
    return () => {
      window.removeEventListener('pihub:model-cycled', onCycled);
    };
  }, [chat]);

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
    // Auto-collapse (simplified output or the showcase settle-collapse) is
    // overridden through userExpanded; manual folds go through collapsedUnits.
    if (simplifiedOutput || settledCollapse) {
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

  // Branch at the bottom of an agent reply (P1-10 B): pi's fork RPC splits
  // before a user message, so forking the *next* user message after this
  // reply yields a branch that ends exactly at this reply. If no next user
  // message exists (this reply is the session leaf), clone forks at the leaf
  // — the same break point.
  const forkAtReply = async (entryId: string): Promise<void> => {
    try {
      const index = chat.messages.findIndex((item) => item.entryId === entryId);
      const nextUser = chat.messages
        .slice(index + 1)
        .find((item) => item.message.role === 'user' && item.entryId !== undefined);
      const response =
        nextUser?.entryId !== undefined
          ? await api.forkSession(nextUser.entryId)
          : await api.cloneSession();
      if (!response.success) {
        return;
      }
      // P1-13 B: the new branch gets the traditional alias prefix
      // 新支源自{旧 alias}（旧 alias = session name or last cwd folder）。
      const branchName = await resolveBranchAlias();
      if (branchName === null) {
        onSessionChanged();
        return;
      }
      const sessions = await api.sessions().catch(() => null);
      const duplicate = sessions?.sessions.some((session) => session.name === branchName) ?? false;
      if (duplicate) {
        setBranchConfirm({ entryId, name: branchName });
        return;
      }
      await api.renameSession(branchName);
      onSessionChanged();
    } catch {
      // chat state surfaces backend errors
    }
  };

  /** 新支源自{旧 alias}；旧 alias 取当前会话名，缺省用 cwd 最后文件夹名。 */
  const resolveBranchAlias = async (): Promise<string | null> => {
    const sessionName = chat.rpcState?.sessionName;
    if (sessionName !== undefined && sessionName.length > 0) {
      return t('session.branchPrefix', { name: sessionName });
    }
    const file = chat.rpcState?.sessionFile;
    if (file === undefined || file.length === 0) {
      return null;
    }
    const sessions = await api.sessions().catch(() => null);
    const current = sessions?.sessions.find((session) => session.fileName === file);
    const alias =
      current?.name !== undefined && current.name.length > 0
        ? current.name
        : current?.cwd.split('/').filter((part) => part.length > 0).pop() ?? null;
    return alias === null ? null : t('session.branchPrefix', { name: alias });
  };

  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  // P1-13 B: branch alias duplicates need a second confirmation.
  const [branchConfirm, setBranchConfirm] = useState<{ entryId: string; name: string } | null>(
    null,
  );
  // P1-13 D: last-prompt edit-and-resend (double confirmation).
  const [editingUnitKey, setEditingUnitKey] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [confirmResend, setConfirmResend] = useState(false);
  // Live elapsed timer for the running unit (1s tick; renders only while a
  // run is active so idle pages never pay the interval cost).
  const [, setNowTick] = useState(0);

  useEffect(() => {
    if (!chat.isAgentRunning) {
      return;
    }
    const timer = window.setInterval(() => {
      setNowTick((prev) => prev + 1);
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [chat.isAgentRunning]);

  const runningElapsed =
    chat.isAgentRunning && chat.runStartedAt !== null ? Date.now() - chat.runStartedAt : 0;

  const copyReplyAsMarkdown = async (item: ChatMessage): Promise<void> => {
    try {
      const text = extractAssistantMarkdown(item.message);
      await navigator.clipboard.writeText(text);
      setCopiedKey(item.key);
      window.setTimeout(() => {
        setCopiedKey((current) => (current === item.key ? null : current));
      }, 1500);
    } catch {
      // clipboard unavailable; ignore
    }
  };

  const copyUserPrompt = async (item: ChatMessage | null): Promise<void> => {
    if (item === null) {
      return;
    }
    try {
      await navigator.clipboard.writeText(extractUserPrompt(item));
      setCopiedKey(item.key);
      window.setTimeout(() => {
        setCopiedKey((current) => (current === item.key ? null : current));
      }, 1500);
    } catch {
      // clipboard unavailable; ignore
    }
  };

  return (
    <section className="chatpage" data-shot="chat">
      <div className="chatpage-scroll scroll-area" ref={scrollRef} onScroll={updateAtBottom}>
        {chat.error !== null ? (
          <div className="chatpage-error mono" role="alert">
            {chat.error}
          </div>
        ) : null}
        {chat.retrying ? (
          <div className="chatpage-retry mono" role="status">
            <span className="hico hico-exclamationmark" aria-hidden="true" />
            {t('chat.retrying')}
          </div>
        ) : null}
        {chat.pendingSteer.length > 0 || chat.pendingFollowUp.length > 0 ? (
          <div className="chatpage-queue mono">
            {t('chat.queued', {
              steer: String(chat.pendingSteer.length),
              followUp: String(chat.pendingFollowUp.length),
            })}
          </div>
        ) : null}
        {/* P1-17 D: skeleton while the switched session's messages load. */}
        {!chat.hasLoaded ? (
          <div className="chat-skeleton" aria-hidden="true">
            {[0, 1, 2, 3, 4].map((index) => (
              <div
                key={index}
                className={`chat-skeleton-row ${index % 2 === 0 ? 'chat-skeleton-user' : 'chat-skeleton-assistant'}`}
              >
                <span
                  className="chat-skeleton-line"
                  style={{ width: `${String(58 + ((index * 13) % 35))}%` }}
                />
                <span
                  className="chat-skeleton-line"
                  style={{ width: `${String(36 + ((index * 17) % 30))}%` }}
                />
              </div>
            ))}
          </div>
        ) : chat.messages.length === 0 ? (
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
              const finalSummary = isSettledUnit ? finalReplySummary(unit) : null;
              // Simplified output / settle-collapse: settled workflows fold
              // automatically; the "....." marker then hints that more
              // content is folded, and a final summary line summarizes the
              // last assistant reply.
              const autoCollapsed =
                (simplifiedOutput || settledCollapse) &&
                isSettledUnit &&
                !userExpanded.has(unit.key);
              const collapsed =
                autoCollapsed || collapsedUnits.has(unit.key);
              return (
                <div
                  key={unit.key}
                  className="chat-unit"
                  data-collapsed={collapsed}
                >
                  <div className="chat-unit-body" data-collapsed={collapsed}>
                    <div className="chat-unit-body-inner">
                      {unit.user !== null ? (
                        editingUnitKey === unit.key ? (
                          <div className="chat-unit-edit">
                            <textarea
                              className="chat-unit-edit-text mono"
                              value={editText}
                              spellCheck={false}
                              onChange={(event) => {
                                setEditText(event.target.value);
                                setConfirmResend(false);
                              }}
                              onKeyDown={(event) => {
                                if (event.key === 'Escape') {
                                  setEditingUnitKey(null);
                                  setConfirmResend(false);
                                }
                              }}
                            />
                            <div className="chat-unit-edit-actions">
                              <button
                                type="button"
                                className="btn-secondary mono chat-unit-edit-btn"
                                onClick={() => {
                                  setEditingUnitKey(null);
                                  setConfirmResend(false);
                                }}
                              >
                                {t('chat.cancelEdit')}
                              </button>
                              <button
                                type="button"
                                className={confirmResend ? 'btn-danger mono chat-unit-edit-btn' : 'btn-primary mono chat-unit-edit-btn'}
                                disabled={editText.trim().length === 0}
                                onClick={() => {
                                  if (!confirmResend) {
                                    setConfirmResend(true);
                                    return;
                                  }
                                  // Second confirmation overwrites: drop
                                  // everything from this prompt onward and
                                  // resend the edited text (P1-13 D).
                                  const key = unit.key;
                                  chat.clearAfter(key);
                                  setEditingUnitKey(null);
                                  setConfirmResend(false);
                                  void chat.sendPrompt(editText.trim());
                                }}
                              >
                                {confirmResend ? t('chat.confirmResend') : t('chat.editPrompt')}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <MessageItem
                              message={unit.user.message}
                              isStreaming={false}
                              footer={
                                <>
                                  <IconButton
                                    icon="hico-square-on-square-fill"
                                    label={t('chat.copyPrompt')}
                                    placement="top"
                                    onClick={() => {
                                      void copyUserPrompt(unit.user);
                                    }}
                                  />
                                  {isLast ? (
                                    <IconButton
                                      icon="hico-square-and-pencil"
                                      label={t('chat.editPrompt')}
                                      placement="top"
                                      onClick={() => {
                                        setEditingUnitKey(unit.key);
                                        setEditText(extractUserPrompt(unit.user));
                                        setConfirmResend(false);
                                      }}
                                    />
                                  ) : null}
                                </>
                              }
                            />
                          </>
                        )
                      ) : null}
                      {(() => {
                        // Tool blocks of this run collapse into one set
                        // (P1-10 C3); thinking/text messages render inline.
                        // P1-16 E: once the run settles, multiple assistant
                        // messages fold — only the last stays visible.
                        const toolItems = unit.rest.filter(isToolMessage);
                        const nonToolItems = unit.rest.filter((item) => !isToolMessage(item));
                        const canFoldProcess =
                          nonToolItems.length > 1 && nonToolItems.every((item) => !item.isStreaming);
                        const processItems = canFoldProcess ? nonToolItems.slice(0, -1) : [];
                        const keptItems = canFoldProcess ? nonToolItems.slice(-1) : nonToolItems;
                        return (
                          <>
                            {canFoldProcess ? (
                              <AssistantProcessCollapse
                                items={processItems}
                                durationLabel={runDurationLabel(unit.rest)}
                                onOpenFile={openFile}
                              />
                            ) : null}
                            {keptItems.map((item) => (
                              <MessageItem
                                key={item.key}
                                message={item.message}
                                isStreaming={item.isStreaming}
                                thinkingStatus={
                                  unitIndex === units.length - 1 ? thinkingStatus : 'done'
                                }
                                onOpenFile={openFile}
                              />
                            ))}
                            {toolItems.length > 0 ? <ToolCluster items={toolItems} onOpenFile={openFile} /> : null}
                          </>
                        );
                      })()}
                    </div>
                  </div>
                  {(() => {
                    // Reply footer (P1-10 B / P1-11 B): branch at this reply's
                    // tree node + copy as markdown. Hidden until hover; pure
                    // icons with IconButton's hover tooltip labels.
                    const lastAssistant = [...unit.rest].reverse().find(
                      (item) => item.message.role === 'assistant',
                    );
                    const branchEntryId = lastAssistant?.entryId;
                    if (lastAssistant === undefined) {
                      return null;
                    }
                    return (
                      <div className="chat-unit-footer">
                        <IconButton
                          icon="hico-arrow-triangle-divide"
                          label={t('sidebar.newBranch')}
                          placement="top"
                          disabled={branchEntryId === undefined}
                          onClick={() => {
                            if (branchEntryId !== undefined) {
                              void forkAtReply(branchEntryId);
                            }
                          }}
                        />
                        <IconButton
                          icon="hico-square-on-square-fill"
                          label={
                            copiedKey === lastAssistant.key
                              ? t('chat.copied')
                              : t('chat.copyResult')
                          }
                          placement="top"
                          onClick={() => {
                            void copyReplyAsMarkdown(lastAssistant);
                          }}
                        />
                      </div>
                    );
                  })()}
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
                            <span>
                              {t('workflow.elapsed', {
                                time: formatDuration(runningElapsed, locale),
                              })}
                            </span>
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
                      {isSettledUnit || isRunningUnit ? (
                        <>
                          {/* Full-width divider line closing the workflow */}
                          <div className="chat-unit-divider" aria-hidden="true" />
                          {collapsed ? (
                            <div className="chat-unit-settle mono">
                              {isSettledUnit && finalSummary !== null ? (
                                <span className="chat-unit-final-summary">
                                  {t('chat.finalSummary')}：{finalSummary}
                                </span>
                              ) : null}
                              <span aria-hidden="true">.....</span>
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
      {previewPath !== null ? (
        <FilePreview
          path={previewPath}
          onClose={() => {
            setPreviewPath(null);
          }}
        />
      ) : null}
      <div className="chatpage-bottom">
        {/* P1-03 D: recent file operations aggregated from tool calls. */}
        {recentFiles.length > 0 ? (
          <div className="chat-files mono">
            <span className="chat-files-label">{t('chat.files')}</span>
            <div className="chat-files-list">
              {recentFiles.map((file: { path: string; action: string }) => (
                <button
                  key={file.path}
                  type="button"
                  className="chat-file-chip mono"
                  title={file.path}
                  onClick={() => {
                    setPreviewPath(file.path);
                  }}
                >
                  <span className="chat-file-action">{file.action}</span>
                  <span className="chat-file-path">{file.path}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
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
          compact={!atBottom && !composerForced}
          onToggleCompact={() => {
            setComposerForced((prev) => !prev);
          }}
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

      {branchConfirm !== null ? (
        <ConfirmDialog
          title={t('sidebar.newBranch')}
          message={t('session.branchConfirm', { name: branchConfirm.name })}
          danger={false}
          confirmLabel={t('sidebar.newBranch')}
          onConfirm={() => {
            void (async (): Promise<void> => {
              try {
                await api.renameSession(branchConfirm.name);
              } catch {
                // chat state surfaces backend errors
              }
              setBranchConfirm(null);
              onSessionChanged();
            })();
          }}
          onCancel={() => {
            setBranchConfirm(null);
            onSessionChanged();
          }}
        />
      ) : null}
    </section>
  );
}
