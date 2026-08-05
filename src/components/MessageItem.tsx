import { useState } from 'react';
import type { AgentMessage, ContentBlock } from '../../shared/types.js';
import { Markdown } from './Markdown.js';
import './MessageItem.css';

function ToolCallBlock({
  block,
}: {
  block: Extract<ContentBlock, { type: 'toolCall' }>;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const argumentsText = JSON.stringify(block.arguments, null, 2);

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
        <span className="toolcall-name mono">{block.name}</span>
        <span className="toolcall-chevron" aria-hidden="true">
          {expanded ? '−' : '+'}
        </span>
      </button>
      {expanded ? (
        <pre className="toolcall-args">{argumentsText}</pre>
      ) : null}
    </div>
  );
}

function ThinkingBlock({
  text,
}: {
  text: string;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="thinking" data-expanded={expanded}>
      <button
        type="button"
        className="thinking-toggle"
        onClick={() => {
          setExpanded(!expanded);
        }}
        aria-expanded={expanded}
      >
        <span className="thinking-label mono">thinking</span>
        <span aria-hidden="true">{expanded ? '−' : '+'}</span>
      </button>
      {expanded ? <div className="thinking-body">{text}</div> : null}
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

function ContentBlocks({
  blocks,
}: {
  blocks: ContentBlock[];
}): React.JSX.Element {
  return (
    <>
      {blocks.map((block, index) => {
        switch (block.type) {
          case 'text':
            return <Markdown key={index} text={block.text} />;
          case 'thinking':
            return <ThinkingBlock key={index} text={block.thinking} />;
          case 'toolCall':
            return <ToolCallBlock key={index} block={block} />;
          case 'image':
            return <ImageBlock key={index} block={block} />;
        }
      })}
    </>
  );
}

function UserMessageView({ message }: { message: Extract<AgentMessage, { role: 'user' }> }): React.JSX.Element {
  const content = message.content;
  if (typeof content === 'string') {
    return (
      <div className="user-bubble">
        <Markdown text={content} />
      </div>
    );
  }
  return (
    <div className="user-bubble">
      <ContentBlocks blocks={content} />
    </div>
  );
}

function AssistantMessageView({
  message,
  isStreaming,
}: {
  message: Extract<AgentMessage, { role: 'assistant' }>;
  isStreaming: boolean;
}): React.JSX.Element {
  return (
    <div className="assistant-body" data-streaming={isStreaming}>
      <ContentBlocks blocks={message.content} />
      {isStreaming ? <span className="stream-cursor" aria-hidden="true" /> : null}
    </div>
  );
}

function ToolResultView({ message }: { message: Extract<AgentMessage, { role: 'toolResult' }> }): React.JSX.Element {
  const [expanded, setExpanded] = useState(true);
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
        <span className="toolresult-status mono">{message.isError ? 'error' : 'ok'}</span>
        <span aria-hidden="true">{expanded ? '−' : '+'}</span>
      </button>
      {expanded ? <pre className="toolresult-output">{preview}</pre> : null}
    </div>
  );
}

function BashExecutionView({ message }: { message: Extract<AgentMessage, { role: 'bashExecution' }> }): React.JSX.Element {
  return (
    <div className="toolresult">
      <div className="toolresult-header">
        <span className="toolresult-name mono">bash</span>
        <span className="toolresult-status mono">exit {String(message.exitCode)}</span>
      </div>
      <pre className="toolresult-output">{message.output}</pre>
    </div>
  );
}

interface MessageItemProps {
  message: AgentMessage;
  isStreaming: boolean;
}

export function MessageItem({ message, isStreaming }: MessageItemProps): React.JSX.Element {
  switch (message.role) {
    case 'user':
      return (
        <div className="message message-user">
          <UserMessageView message={message} />
        </div>
      );
    case 'assistant':
      return (
        <div className="message message-assistant">
          <AssistantMessageView message={message} isStreaming={isStreaming} />
        </div>
      );
    case 'toolResult':
      return (
        <div className="message message-tool">
          <ToolResultView message={message} />
        </div>
      );
    case 'bashExecution':
      return (
        <div className="message message-tool">
          <BashExecutionView message={message} />
        </div>
      );
  }
}
