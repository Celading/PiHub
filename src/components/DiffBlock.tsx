/* eslint-disable react-refresh/only-export-components */
import { useMemo, useState } from 'react';

/**
 * Rich diff block (P1-12 D): renders unified-diff text as colored lines —
 * additions (green), deletions (red), hunk headers (bold gray), context
 * plain. Large diffs collapse with an expand toggle. Detected by language
 * tag or by leading +/- markers in the code fence content.
 */
interface DiffBlockProps {
  code: string;
}

const COLLAPSE_THRESHOLD = 30;

interface DiffLine {
  kind: 'add' | 'del' | 'hunk' | 'context';
  text: string;
}

function parseDiff(code: string): DiffLine[] {
  return code.split('\n').map((line) => {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      return { kind: 'add', text: line };
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      return { kind: 'del', text: line };
    }
    if (line.startsWith('@@')) {
      return { kind: 'hunk', text: line };
    }
    return { kind: 'context', text: line };
  });
}

/** True when the code fence content looks like a unified diff. */
export function looksLikeDiff(code: string): boolean {
  const lines = code.split('\n');
  let markers = 0;
  for (const line of lines) {
    if (line.startsWith('+') || line.startsWith('-')) {
      markers += 1;
      if (markers >= 2) {
        return true;
      }
    }
  }
  return false;
}

export function DiffBlock({ code }: DiffBlockProps): React.JSX.Element {
  const lines = useMemo(() => parseDiff(code), [code]);
  const [expanded, setExpanded] = useState(false);
  const collapsed = lines.length > COLLAPSE_THRESHOLD && !expanded;
  const visible = collapsed ? lines.slice(0, COLLAPSE_THRESHOLD) : lines;
  const hiddenCount = lines.length - visible.length;

  return (
    <div className="diffblock" data-collapsed={collapsed}>
      <div className="diffblock-body" aria-label="diff">
        {visible.map((line, index) => (
          <div key={index} className={`diffblock-line diffblock-${line.kind}`}>
            <span className="diffblock-gutter mono" aria-hidden="true">
              {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
            </span>
            <span className="diffblock-text mono">{line.text || ' '}</span>
          </div>
        ))}
      </div>
      {collapsed ? (
        <button
          type="button"
          className="diffblock-toggle mono"
          onClick={() => {
            setExpanded(true);
          }}
        >
          + {hiddenCount} lines hidden — expand
        </button>
      ) : null}
    </div>
  );
}
