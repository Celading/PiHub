import { useTypewriter } from './useTypewriter.js';
import { Markdown } from './Markdown.js';

/**
 * Typewriter text block (showcase sprint): renders the full markdown once
 * the reveal completes; until then it shows the progressively revealed plain
 * text with a caret, so markdown never renders half-parsed. The underlying
 * text is never modified — switching to markdown happens in the same render
 * as the final reveal, so there is no flash.
 */
export function TypewriterText({ text }: { text: string }): React.JSX.Element {
  const { revealed, done } = useTypewriter(text, text.length > 0);
  if (done) {
    return <Markdown text={text} />;
  }
  return (
    <span className="typewriter" aria-live="polite">
      {revealed}
      <span className="typewriter-caret" aria-hidden="true" />
    </span>
  );
}
