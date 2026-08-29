import { useEffect, useRef, useState } from 'react';
import type { AgentMessage } from '../../shared/types.js';
import type { ChatMessage } from '../chat/chatState.js';
import { MessageItem, type ThinkingStatus } from './MessageItem.js';
import { summarizeToolCall } from './toolSummary.js';
import { useI18n } from '../i18n/I18nProvider.js';
import './RunLedger.css';

/**
 * UX workbench (audit): the Run Ledger — process items of one prompt unit
 * render as compact event rows (`13:42 bash · 读取 9 个文件 · 成功`); a
 * click expands the raw block (params / output / reasoning). Only the final
 * answer keeps full layout. Long sessions read as auditable execution logs
 * instead of chat blobs.
 */

interface RunLedgerProps {
  /** Process items: tool calls, bash executions, thinking frames. */
  items: ChatMessage[];
  /** This prompt unit is the active run. */
  active: boolean;
  /** Fold process details after a short settle grace period. */
  autoFold: boolean;
  thinkingStatus: ThinkingStatus;
  onOpenFile?: ((path: string) => void) | undefined;
}

function timeOf(message: AgentMessage): string {
  const ts = message.timestamp;
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) {
    return '--:--';
  }
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** One-line event summary; ok = null when the row has no success/failure. */
function summarize(
  item: ChatMessage,
  t: ReturnType<typeof useI18n>['t'],
): { text: string; ok: boolean | null } {
  const message = item.message;
  switch (message.role) {
    case 'bashExecution': {
      const command = message.command.trim().split('\n')[0] ?? '';
      const line =
        command.length > 0
          ? command
          : message.output.trim().split('\n')[0] ?? '';
      return {
        text: `bash · ${line.slice(0, 72)}`,
        ok: message.exitCode === 0 && !message.cancelled,
      };
    }
    case 'toolResult': {
      const text = message.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join(' ')
        .trim();
      return { text: `${message.toolName} · ${text.slice(0, 72)}`, ok: !message.isError };
    }
    case 'assistant': {
      const toolCall = message.content.find((block) => block.type === 'toolCall');
      if (toolCall !== undefined && toolCall.type === 'toolCall') {
        const name = typeof toolCall.name === 'string' ? toolCall.name : 'tool';
        const summary = summarizeToolCall(name, toolCall.arguments);
        return { text: t(summary.key, summary.params), ok: null };
      }
      const thinking = message.content.find((block) => block.type === 'thinking');
      const text = message.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join(' ')
        .trim();
      if (text.length > 0) {
        return { text: text.slice(0, 72), ok: null };
      }
      if (thinking !== undefined && thinking.type === 'thinking') {
        const bodyValue: unknown = (thinking as { thinking?: unknown }).thinking;
        const body =
          typeof bodyValue === 'string' ? bodyValue.replace(/\s+/g, ' ').trim() : '';
        return { text: `思考 · ${body.slice(0, 72)}`, ok: null };
      }
      return { text: '', ok: null };
    }
    default:
      return { text: '', ok: null };
  }
}

export function RunLedger({
  items,
  active,
  autoFold,
  thinkingStatus,
  onOpenFile,
}: RunLedgerProps): React.JSX.Element | null {
  const { t } = useI18n();
  const [autoExpanded, setAutoExpanded] = useState(active);
  const [manualState, setManualState] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  const wasActive = useRef(active);

  useEffect(() => {
    if (active) {
      setAutoExpanded(true);
      wasActive.current = true;
      return;
    }
    if (!autoFold) {
      setAutoExpanded(true);
      wasActive.current = false;
      return;
    }
    if (!wasActive.current) {
      setAutoExpanded(false);
      return;
    }
    wasActive.current = false;
    const timer = window.setTimeout(() => {
      setAutoExpanded(false);
    }, 3500);
    return () => {
      window.clearTimeout(timer);
    };
  }, [active, autoFold]);

  if (items.length === 0) {
    return null;
  }

  return (
    <div className="run-ledger" data-shot="run-ledger">
      {items.map((item) => {
        const summary = summarize(item, t);
        const open = manualState.get(item.key) ?? autoExpanded;
        const live = active && item.isStreaming;
        return (
          <div key={item.key} className="run-ledger-row" data-open={open}>
            <button
              type="button"
              className="run-ledger-line mono"
              aria-expanded={open}
              onClick={() => {
                setManualState((prev) => {
                  const next = new Map(prev);
                  next.set(item.key, !open);
                  return next;
                });
              }}
            >
              <span className="run-ledger-time">{timeOf(item.message)}</span>
              <span className="run-ledger-state" data-ok={summary.ok} data-live={live} aria-hidden="true">
                {live ? '…' : summary.ok === null ? '·' : summary.ok ? '✓' : '✗'}
              </span>
              <span className="run-ledger-text">
                {live ? `${summary.text}…` : summary.text}
              </span>
              <span className="run-ledger-chevron" aria-hidden="true">
                {open ? '−' : '+'}
              </span>
            </button>
            <div
              className="collapse-region run-ledger-collapse"
              data-collapsed={!open}
              aria-hidden={!open}
            >
              <div className="collapse-region-inner run-ledger-body">
                <MessageItem
                  message={item.message}
                  isStreaming={live}
                  thinkingStatus={thinkingStatus}
                  revealThinking={open}
                  onOpenFile={onOpenFile}
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
