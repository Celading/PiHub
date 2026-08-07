import type { ReactNode } from 'react';
import './FilePreview.css';
import { classifyDiffLine } from './diffLines.js';

/**
 * P1-03 C: inline diff renderer. Lines are classified by their leading
 * marker: diff/index/---/+++ meta, @@ hunks, + additions and - deletions
 * (background highlights), everything else stays neutral.
 */
export function DiffView({ content }: { content: string }): React.JSX.Element {
  const lines = content.split('\n');
  const nodes: ReactNode[] = [];
  for (const line of lines) {
    const cls = classifyDiffLine(line);
    nodes.push(
      <span key={nodes.length} className={`diff-line ${cls}`}>
        {line === '' ? '\u00a0' : line}
      </span>,
    );
  }
  return <div className="diff-view mono">{nodes}</div>;
}
