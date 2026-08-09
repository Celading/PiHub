import { useEffect, useRef, useState } from 'react';

/**
 * Typewriter reveal (showcase sprint): a character-level reveal animation
 * that never touches the underlying text. The data stays complete and
 * immutable — copy, resend, markdown export and the session file all see the
 * full message; only the *rendered* portion is revealed progressively.
 *
 * Rules:
 * - When `text` grows (streaming deltas, or a whole block arriving at once
 *   in demo mode), the reveal continues from where it left off — the message
 *   never re-types from the start.
 * - When `text` shrinks (edited-prompt resend), the reveal resets.
 * - Long text caps the animation (reveal finishes within `maxDurationMs`)
 *   and the caller can force-instant completion via `enabled: false` or by
 *   the message settling.
 */

const TICK_MS = 16;
/** Target typing speed in characters per second (feels like typing). */
const CHARS_PER_SECOND = 90;
/** Reveal never runs longer than this, however long the text is. */
const MAX_DURATION_MS = 12000;
/** Texts at or below this length always type out fully. */
const ALWAYS_TYPE_CHARS = 600;

export interface TypewriterState {
  /** The portion of `text` that should be visible right now. */
  revealed: string;
  /** True once the full text is revealed (stable, safe to render markdown). */
  done: boolean;
}

export function useTypewriter(text: string, enabled: boolean): TypewriterState {
  const [revealedCount, setRevealedCount] = useState(enabled ? 0 : text.length);
  const countRef = useRef(revealedCount);
  const textRef = useRef(text);

  useEffect(() => {
    countRef.current = enabled ? 0 : text.length;
    textRef.current = text;
    setRevealedCount(countRef.current);
  }, [text, enabled]);

  useEffect(() => {
    if (!enabled) {
      setRevealedCount(text.length);
      countRef.current = text.length;
      return;
    }
    const target = text.length;
    // Short texts type out fully; long ones still get the animation but are
    // throttled by the duration cap so they finish in reasonable time.
    const speed =
      target <= ALWAYS_TYPE_CHARS
        ? CHARS_PER_SECOND
        : Math.max(CHARS_PER_SECOND, target / (MAX_DURATION_MS / 1000));
    const step = Math.max(1, Math.round((speed * TICK_MS) / 1000));
    const timer = setInterval(() => {
      const next = Math.min(target, countRef.current + step);
      countRef.current = next;
      setRevealedCount(next);
      if (next >= target) {
        clearInterval(timer);
      }
    }, TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [text, enabled]);

  const done = revealedCount >= text.length;
  return { revealed: text.slice(0, revealedCount), done };
}
