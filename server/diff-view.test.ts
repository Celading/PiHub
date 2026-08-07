import { describe, expect, it } from 'vitest';
import { classifyDiffLine, looksLikeDiff } from '../src/components/diffLines.js';

describe('P1-03 diff view', () => {
  it('classifies unified diff lines by leading marker', () => {
    expect(classifyDiffLine('diff --git a/x.ts b/x.ts')).toBe('diff-meta');
    expect(classifyDiffLine('index 123..456 100644')).toBe('diff-meta');
    expect(classifyDiffLine('--- a/x.ts')).toBe('diff-meta');
    expect(classifyDiffLine('+++ b/x.ts')).toBe('diff-meta');
    expect(classifyDiffLine('@@ -1,3 +1,4 @@')).toBe('diff-hunk');
    expect(classifyDiffLine('+const added = 1;')).toBe('diff-add');
    expect(classifyDiffLine('-const removed = 1;')).toBe('diff-del');
    expect(classifyDiffLine('  const context = 1;')).toBe('diff-ctx');
    expect(classifyDiffLine('plain text')).toBe('diff-ctx');
    expect(classifyDiffLine('')).toBe('diff-ctx');
  });

  it('detects unified diffs conservatively', () => {
    expect(looksLikeDiff('diff --git a/a b/b\n@@ -1 +1 @@\n')).toBe(true);
    expect(looksLikeDiff('--- a/a\n+++ b/b\n@@ -1 +1 @@\n')).toBe(true);
    expect(looksLikeDiff('plain file content without markers')).toBe(false);
    expect(looksLikeDiff('+a plus-prefixed line alone')).toBe(false);
  });
});
