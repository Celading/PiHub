import type { ReactNode } from 'react';

/**
 * P1-03 B: conservative file-path detection for tool output. Two patterns:
 * absolute paths (`/a/b/c.ext`) and relative paths with at least one slash
 * and an extension (`./src/x.ts`, `src/x.ts`, `../x/y.md`). Matches are
 * rendered as buttons that open the read-only preview.
 */
const ABSOLUTE_PATH = /(\/(?:[\w@.-]+\/)+[\w@.-]+\.\w{1,10})/g;
const RELATIVE_PATH = /(?:^|[\s([{])((?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)+\.\w{1,10})/g;

/** Render tool output with clickable file paths (P1-03 B). */
export function linkifyPaths(text: string, onOpen: (path: string) => void): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Absolute paths first: split yields [text, path, text, path, …].
  const absoluteParts = text.split(ABSOLUTE_PATH);
  absoluteParts.forEach((part, index) => {
    if (index % 2 === 1) {
      nodes.push(
        <button
          key={`a${String(index)}`}
          type="button"
          className="file-link mono"
          onClick={() => {
            onOpen(part);
          }}
        >
          {part}
        </button>,
      );
      return;
    }
    // Within the remaining text, linkify relative paths.
    let cursor = 0;
    RELATIVE_PATH.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = RELATIVE_PATH.exec(part)) !== null) {
      const path = match[1];
      if (path === undefined) {
        break;
      }
      nodes.push(<span key={`t${String(index)}-${String(cursor)}`}>{part.slice(cursor, match.index)}</span>);
      nodes.push(
        <button
          key={`p${String(index)}-${String(match.index)}`}
          type="button"
          className="file-link mono"
          onClick={() => {
            onOpen(path);
          }}
        >
          {path}
        </button>,
      );
      cursor = match.index + path.length;
    }
    nodes.push(<span key={`e${String(index)}-${String(cursor)}`}>{part.slice(cursor)}</span>);
  });
  return nodes;
}
