import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { gitStatus, parseGitStatusZ } from './git-status.js';

const execFileAsync = promisify(execFile);
let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir !== undefined) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe('P1-08b git status parsing', () => {
  it('parses modified/added/deleted/untracked entries with -z framing', () => {
    const out = parseGitStatusZ(' M src/a.ts\u0000A  src/b.ts\u0000 D src/c.ts\u0000?? src/new dir/x.ts\u0000');
    expect(out).toEqual([
      { path: 'src/a.ts', index: ' ', worktree: 'M', kind: 'modified', staged: false },
      { path: 'src/b.ts', index: 'A', worktree: ' ', kind: 'added', staged: true },
      { path: 'src/c.ts', index: ' ', worktree: 'D', kind: 'deleted', staged: false },
      { path: 'src/new dir/x.ts', index: '?', worktree: '?', kind: 'untracked', staged: false },
    ]);
  });

  it('handles paths with spaces and rename orig fields', () => {
    const out = parseGitStatusZ('R  old name.ts\u0000new name.ts\u0000 M a b.ts\u0000');
    expect(out).toEqual([
      { path: 'old name.ts', index: 'R', worktree: ' ', kind: 'renamed', staged: true },
      { path: 'a b.ts', index: ' ', worktree: 'M', kind: 'modified', staged: false },
    ]);
  });

  it('flags conflicted entries and drops empty frames', () => {
    const out = parseGitStatusZ('UU conflict.ts\u0000\u0000');
    expect(out).toEqual([{ path: 'conflict.ts', index: 'U', worktree: 'U', kind: 'conflicted', staged: true }]);
  });

  it('runs against a real repository without passing diff-only flags to status', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'pihub-git-status-'));
    await execFileAsync('git', ['init', '--quiet'], { cwd: tempDir });
    await writeFile(path.join(tempDir, 'new.txt'), 'new\n', 'utf8');
    expect(await gitStatus(tempDir)).toEqual([
      { path: 'new.txt', index: '?', worktree: '?', kind: 'untracked', staged: false },
    ]);
  });
});
