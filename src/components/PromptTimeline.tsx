import { useState } from 'react';
import { useI18n } from '../i18n/I18nProvider.js';
import type { ChatUnit } from '../pages/ChatPage.js';
import './PromptTimeline.css';

/**
 * Session prompt timeline — the narrow centered rail on the left of the
 * chat content. Every user prompt of the CURRENT session is one horizontal
 * tick; the rail scrolls independently and hovering a tick shows a tooltip
 * with the prompt summary and its working time. Clicking jumps the message
 * stream to that prompt.
 */

function promptSummary(unit: ChatUnit): string {
  const message = unit.user?.message;
  if (message === undefined || (message.role !== 'user' && message.role !== 'assistant')) {
    return '';
  }
  const content = message.content;
  if (typeof content === 'string') {
    return content.replace(/\s+/g, ' ').trim();
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      // Array blocks are always objects (ContentBlock | generic record).
      const record = block as Record<string, unknown>;
      if (String(record['type']) === 'text' && typeof record['text'] === 'string') {
        parts.push(record['text']);
      }
    }
    return parts.join(' ').trim();
  }
  return '';
}

export function PromptTimeline({
  units,
  onJump,
}: {
  units: ChatUnit[];
  onJump: (key: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [hovered, setHovered] = useState<string | null>(null);
  const prompts = units.filter((unit) => unit.user !== null);

  return (
    <div className="prompt-timeline scroll-area" data-shot="prompt-timeline">
      {prompts.map((unit) => {
        const key = unit.key;
        const summary = promptSummary(unit);
        const span = workingSpan(unit);
        const showTip = hovered === key;
        return (
          <div
            key={key}
            className="prompt-timeline-item"
            data-hovered={showTip}
            onClick={() => {
              onJump(key);
            }}
            onMouseEnter={() => {
              setHovered(key);
            }}
            onMouseLeave={() => {
              setHovered(null);
            }}
          >
            <span className="prompt-timeline-tick" aria-hidden="true" />
            {showTip ? (
              <div className="prompt-timeline-tip mono">
                <span className="prompt-timeline-tip-text">
                  {summary.length > 0 ? summary.slice(0, 64) : t('promptIndex.empty')}
                </span>
                {span !== null ? (
                  <span className="prompt-timeline-tip-meta">{span}</span>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** Working time of a prompt unit (first to last message span). */
function workingSpan(unit: ChatUnit): string | null {
  const times = unit.rest
    .map((item) => item.message.timestamp)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (times.length < 2) {
    return null;
  }
  const spanMs = Math.max(0, (times[times.length - 1] ?? 0) - (times[0] ?? 0));
  const seconds = Math.round(spanMs / 1000);
  if (seconds < 60) {
    return `${String(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes)}m${String(rest).padStart(2, '0')}s`;
}
