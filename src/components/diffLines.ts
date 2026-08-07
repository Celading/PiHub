/** P1-03 C: line classification for the inline diff renderer. */
export type DiffLineClass = 'diff-meta' | 'diff-hunk' | 'diff-add' | 'diff-del' | 'diff-ctx';

export function classifyDiffLine(line: string): DiffLineClass {
  if (
    line.startsWith('diff ') ||
    line.startsWith('index ') ||
    line.startsWith('--- ') ||
    line.startsWith('+++ ')
  ) {
    return 'diff-meta';
  }
  if (line.startsWith('@@')) {
    return 'diff-hunk';
  }
  if (line.startsWith('+')) {
    return 'diff-add';
  }
  if (line.startsWith('-')) {
    return 'diff-del';
  }
  return 'diff-ctx';
}

/** P1-03 C: true when the content looks like a unified diff. */
export function looksLikeDiff(content: string): boolean {
  return (
    content.includes('diff --git') ||
    (content.includes('@@') && content.includes('--- ') && content.includes('+++ '))
  );
}
