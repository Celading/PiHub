import { useLayoutEffect, useRef, useState } from 'react';
import type { AgentMessage, ContentBlock } from '../../shared/types.js';
import { Markdown } from './Markdown.js';
import { TypewriterText } from './TypewriterText.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { useLabFlag } from '../lab/labFlags.js';
import { summarizeToolCall } from './toolSummary.js';
import { linkifyPaths } from './filePaths.js';
import './MessageItem.css';

export type ThinkingStatus = 'active' | 'done' | 'interrupted';

function ToolCallBlock({
  block,
}: {
  block: Extract<ContentBlock, { type: 'toolCall' }>;
}): React.JSX.Element {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const argumentsText = JSON.stringify(block.arguments, null, 2);
  const summary = summarizeToolCall(block.name, block.arguments);

  return (
    <div className="toolcall">
      <button
        type="button"
        className="toolcall-header"
        onClick={() => {
          setExpanded(!expanded);
        }}
        aria-expanded={expanded}
      >
        <span className="toolcall-summary">
          {t(summary.key, summary.params)}
        </span>
        <span className="toolcall-chevron" aria-hidden="true">
          {expanded ? '−' : '>'}
        </span>
      </button>
      <div className="collapse-region" data-collapsed={!expanded}>
        <div className="collapse-region-inner">
          <div className="toolcall-meta mono">{block.name}</div>
          <pre className="toolcall-args">{argumentsText}</pre>
        </div>
      </div>
    </div>
  );
}

function ThinkingBlock({
  text,
  status,
  animate,
}: {
  text: string;
  status: ThinkingStatus;
  animate: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  // L005 owner spec keeps the reasoning body collapsed while streaming; the
  // lab option reveals it live until the run settles.
  const showLive = useLabFlag('showThinkingLive');

  const label =
    status === 'active'
      ? t('thinking.active')
      : status === 'interrupted'
        ? t('thinking.interrupted')
        : t('thinking.done');
  const iconClass =
    status === 'interrupted' ? 'hico-exclamationmark' : 'hico-waveform';

  if (status === 'active') {
    return (
      <div className="thinking thinking-active" data-anim={animate} data-expanded={showLive}>
        <div className="thinking-toggle" aria-live="polite">
          <span className={`hico ${iconClass} thinking-icon`} aria-hidden="true" />
          <span className="thinking-label mono" aria-hidden="true">
            {label.split('').map((char, index) => (
              <span
                key={index}
                className="thinking-char"
                style={{ animationDelay: `${String(index * 0.18)}s` }}
              >
                {char}
              </span>
            ))}
          </span>
          <span className="thinking-label mono thinking-sr">{label}</span>
        </div>
        {showLive && text.trim().length > 0 ? (
          <div className="thinking-body thinking-body-live">{text}</div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="thinking" data-expanded={expanded} data-status={status}>
      <button
        type="button"
        className="thinking-toggle"
        onClick={() => {
          setExpanded(!expanded);
        }}
        aria-expanded={expanded}
      >
        <span className={`hico ${iconClass} thinking-icon`} aria-hidden="true" />
        <span className="thinking-label mono">{label}</span>
        <span className="hico hico-chevron-down thinking-chevron" aria-hidden="true" />
      </button>
      <div className="collapse-region" data-collapsed={!expanded}>
        <div className="collapse-region-inner">
          <div className="thinking-body">{text}</div>
        </div>
      </div>
    </div>
  );
}

function ImageBlock({
  block,
}: {
  block: Extract<ContentBlock, { type: 'image' }>;
}): React.JSX.Element | null {
  const src = block.url ?? (block.data !== undefined ? `data:${block.mimeType ?? 'image/png'};base64,${block.data}` : undefined);
  if (src === undefined) {
    return null;
  }
  return <img className="message-image" src={src} alt="attachment" />;
}

/** Renderable block: known ContentBlock or a provider-extension generic
 *  object (P1-12 E) that is skipped by the switch. */
type RenderBlock = ContentBlock | Record<string, unknown>;

function ContentBlocks({
  blocks,
  thinkingStatus,
  animate,
  typewriter,
}: {
  blocks: RenderBlock[];
  thinkingStatus: ThinkingStatus;
  animate: boolean;
  /** Showcase sprint: render streaming text blocks with the typewriter
   *  reveal (markdown takes over once the reveal completes). */
  typewriter?: boolean;
}): React.JSX.Element {
  return (
    <>
      {blocks.map((block, index) => {
        // Unknown provider blocks (e.g. Volcengine reasoning_content) are
        // preserved in the data but render nothing here. The runtime guard
        // goes through `unknown` because the static type cannot express the
        // loose schema output.
        const raw: unknown = block;
        if (raw === null || typeof raw !== 'object' || !('type' in raw)) {
          return null;
        }
        const typeValue: unknown = (raw as { type?: unknown }).type;
        if (typeof typeValue !== 'string') {
          return null;
        }
        const known = block as ContentBlock;
        switch (known.type) {
          case 'text': {
            // Runtime guard: the loose provider-tolerant schema can keep a
            // malformed block alive; never crash the stream on it.
            const textValue: unknown = (known as { text?: unknown }).text;
            return typeof textValue === 'string' ? (
              typewriter === true ? (
                <TypewriterText key={index} text={textValue} />
              ) : (
                <Markdown key={index} text={textValue} />
              )
            ) : null;
          }
          case 'thinking': {
            const thinkingValue: unknown = (known as { thinking?: unknown }).thinking;
            return typeof thinkingValue === 'string' ? (
              <ThinkingBlock
                key={index}
                text={thinkingValue}
                status={thinkingStatus}
                animate={animate}
              />
            ) : null;
          }
          case 'toolCall':
            return <ToolCallBlock key={index} block={known} />;
          case 'image':
            return <ImageBlock key={index} block={known} />;
        }
      })}
    </>
  );
}

/**
 * P1-16 D: long user prompts collapse to the first 12 lines with an
 * expand/collapse toggle; the copy path always uses the full original text.
 * The cap and the expanded height are measured in layout effects so the
 * max-height transition animates both directions.
 */
function CollapsibleUserBubble({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const [capPx, setCapPx] = useState<string | null>(null);
  const [fullPx, setFullPx] = useState<string | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const el = innerRef.current;
    if (el === null) {
      return;
    }
    // scrollHeight reports the full content height even when max-height caps
    // the box (overflow hidden) — no DOM mutation needed, so the effect can
    // never fight React's style prop for the expand/collapse animation.
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 24;
    const cap = Math.round(lineHeight * 12);
    const full = el.scrollHeight;
    setCapPx(`${String(cap)}px`);
    setFullPx(`${String(full)}px`);
    setOverflowing(full > cap);
  }, [children]);

  return (
    <div className="user-bubble">
      {overflowing ? (
        // P1-17 A: the collapse control is a full-height strip on the LEFT
        // edge, following the content height — a second tap instantly undoes
        // a mis-triggered expand/collapse.
        <button
          type="button"
          className="user-bubble-strip"
          aria-expanded={expanded}
          aria-label={expanded ? t('chat.collapse') : t('chat.expand')}
          title={expanded ? t('chat.collapse') : t('chat.expand')}
          onClick={() => {
            setExpanded(!expanded);
          }}
        >
          <span className="user-bubble-strip-chevron" aria-hidden="true">
            {/* P1-18: folded state = up arrow, expanded = down arrow. */}
            {expanded ? '↓' : '↑'}
          </span>
        </button>
      ) : null}
      <div className="user-bubble-body">
        <div
          ref={innerRef}
          className="user-bubble-collapse"
          data-expanded={expanded}
          style={{ maxHeight: expanded ? (fullPx ?? 'none') : (capPx ?? '18rem') }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

function UserMessageView({ message }: { message: Extract<AgentMessage, { role: 'user' }> }): React.JSX.Element {
  const content = message.content;
  if (typeof content === 'string') {
    return (
      <CollapsibleUserBubble>
        <Markdown text={content} />
      </CollapsibleUserBubble>
    );
  }
  return (
    <CollapsibleUserBubble>
      <ContentBlocks blocks={content} thinkingStatus="done" animate={false} />
    </CollapsibleUserBubble>
  );
}

function AssistantMessageView({
  message,
  isStreaming,
  thinkingStatus,
  animate,
  typewriter,
}: {
  message: Extract<AgentMessage, { role: 'assistant' }>;
  isStreaming: boolean;
  thinkingStatus: ThinkingStatus;
  animate: boolean;
  typewriter: boolean;
}): React.JSX.Element {
  return (
    <div className="assistant-body" data-streaming={isStreaming}>
      <ContentBlocks
        blocks={message.content}
        thinkingStatus={thinkingStatus}
        animate={animate}
        typewriter={typewriter && isStreaming}
      />
      {isStreaming && animate ? <span className="stream-cursor" aria-hidden="true" /> : null}
    </div>
  );
}

function ToolResultView({
  message,
  onOpenFile,
}: {
  message: Extract<AgentMessage, { role: 'toolResult' }>;
  onOpenFile?: ((path: string) => void) | undefined;
}): React.JSX.Element {
  const compactTools = useLabFlag('compactTools');
  const [expanded, setExpanded] = useState(!compactTools);
  const text = message.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')
    .trim();
  const preview = text.length > 400 ? `${text.slice(0, 400)}…` : text;

  return (
    <div className="toolresult" data-error={message.isError}>
      <button
        type="button"
        className="toolresult-header"
        onClick={() => {
          setExpanded(!expanded);
        }}
        aria-expanded={expanded}
      >
        <span className="toolresult-name mono">{message.toolName}</span>
        <span className="toolresult-status mono" aria-label={message.isError ? 'error' : 'ok'}>
          {message.isError ? '❌' : '✅'}
        </span>
        <span aria-hidden="true">{expanded ? '−' : '+'}</span>
      </button>
      <div className="collapse-region" data-collapsed={!expanded}>
        <div className="collapse-region-inner">
          {/* P1-03 B: clickable file paths inside tool output. */}
          <pre className="toolresult-output">
            {onOpenFile !== undefined ? linkifyPaths(preview, onOpenFile) : preview}
          </pre>
        </div>
      </div>
    </div>
  );
}

function BashExecutionView({
  message,
  onOpenFile,
}: {
  message: Extract<AgentMessage, { role: 'bashExecution' }>;
  onOpenFile?: ((path: string) => void) | undefined;
}): React.JSX.Element {
  return (
    <div className="toolresult">
      <div className="toolresult-header">
        <span className="toolresult-name mono">bash</span>
        <span className="toolresult-status mono">exit {String(message.exitCode)}</span>
      </div>
      {/* P1-03 B: clickable file paths inside bash output. */}
      <pre className="toolresult-output">
        {onOpenFile !== undefined ? linkifyPaths(message.output, onOpenFile) : message.output}
      </pre>
    </div>
  );
}

interface MessageItemProps {
  message: AgentMessage;
  isStreaming: boolean;
  thinkingStatus?: ThinkingStatus;
  /** P1-16 B: action row rendered INSIDE the user message container so the
   *  bubble + footer form one unit (footer right-aligned via CSS). */
  footer?: React.ReactNode;
  /** P1-03 B: clickable file paths in tool output open the preview. */
  onOpenFile?: ((path: string) => void) | undefined;
}

export function MessageItem({
  message,
  isStreaming,
  thinkingStatus = 'done',
  footer,
  onOpenFile,
}: MessageItemProps): React.JSX.Element {
  const streamAnimation = useLabFlag('streamAnimation');
  const typewriter = useLabFlag('typewriter');
  switch (message.role) {
    case 'user':
      return (
        <div className="message message-user">
          <UserMessageView message={message} />
          {footer !== undefined ? <div className="chat-unit-user-footer">{footer}</div> : null}
        </div>
      );
    case 'assistant':
      return (
        <div className="message message-assistant">
          <AssistantMessageView
            message={message}
            isStreaming={isStreaming}
            thinkingStatus={thinkingStatus}
            animate={streamAnimation}
            typewriter={typewriter}
          />
        </div>
      );
    case 'toolResult':
      return (
        <div className="message message-tool">
          <ToolResultView message={message} onOpenFile={onOpenFile} />
        </div>
      );
    case 'bashExecution':
      return (
        <div className="message message-tool">
          <BashExecutionView message={message} onOpenFile={onOpenFile} />
        </div>
      );
  }
}
