import { spawn } from 'node:child_process';

/** One changed path from `git status --porcelain=v1 -z`. */
export interface GitChange {
  path: string;
  /** Index status char (space when unchanged). */
  index: string;
  /** Worktree status char (space when unchanged). */
  worktree: string;
  kind: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted' | 'other';
  staged: boolean;
}

/**
 * P1-08b: parse `git status --porcelain=v1 -z` output. Entries are
 * `XY <path>\0` (renames carry a second `<orig>\0`); paths may contain
 * spaces — that is why the -z framing is used.
 */
export function parseGitStatusZ(input: string): GitChange[] {
  const out: GitChange[] = [];
  const parts = input.split('\0');
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    if (entry === undefined || entry.length < 4) {
      continue;
    }
    const index = entry[0] ?? ' ';
    const worktree = entry[1] ?? ' ';
    const path = entry.slice(3);
    if ((index === 'R' || index === 'C') && i + 1 < parts.length) {
      // renames/copies: next field is the original path — skip it
      i += 1;
    }
    const kind = kindOf(index, worktree);
    if (kind === null) {
      continue;
    }
    out.push({ path, index, worktree, kind, staged: index !== ' ' && index !== '?' });
  }
  return out;
}

function kindOf(index: string, worktree: string): GitChange['kind'] | null {
  if (index === '?' && worktree === '?') {
    return 'untracked';
  }
  if (index === 'A') {
    return 'added';
  }
  if (index === 'D' || (index === ' ' && worktree === 'D')) {
    return 'deleted';
  }
  if (index === 'R' || index === 'C') {
    return 'renamed';
  }
  if (index === 'U' || worktree === 'U' || (index === 'A' && worktree === 'A')) {
    return 'conflicted';
  }
  if (index === 'M' || worktree === 'M') {
    return 'modified';
  }
  return index === ' ' && worktree === ' ' ? null : 'other';
}

function runGit(root: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // P2-2: a malicious repository's .gitattributes can point diff drivers /
    // textconv at arbitrary executables — disable both, and clear the
    // GIT_EXTERNAL_DIFF escape hatch, so git never runs repository-owned
    // code while the panel reads status/diff.
    const child = spawn('git', args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EXTERNAL_DIFF: '' },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`git ${args[0] ?? ''} timed out after ${String(timeoutMs)}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      const message = stderr.trim() || `git exited with code ${String(code ?? '?')}`;
      const error = new Error(message);
      (error as NodeJS.ErrnoException).code = 'EGIT';
      reject(error);
    });
  });
}

/** True only when the host has no Git executable. Other Git failures stay
 *  visible instead of silently falling back to a different truth source. */
export function isGitUnavailableError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (((error as NodeJS.ErrnoException).code === 'ENOENT') || /spawn git ENOENT/iu.test(error.message))
  );
}

/** Read-only git status; null when the root is not a git repository. */
export async function gitStatus(root: string): Promise<GitChange[] | null> {
  try {
    const raw = await runGit(
      root,
      // `--no-ext-diff` and `--no-textconv` belong to `git diff`, not
      // `git status`. Status does not invoke diff drivers or textconv, so the
      // hardened environment above is sufficient for this read-only probe.
      ['status', '--porcelain=v1', '-z'],
      10_000,
    );
    return parseGitStatusZ(raw);
  } catch (error) {
    if (error instanceof Error && /not a git repository/i.test(error.message)) {
      return null;
    }
    throw error;
  }
}

/** Read-only diff of one path (staged or worktree); null when not a repo. */
export async function gitDiff(
  root: string,
  relPath: string,
  staged: boolean,
): Promise<string | null> {
  const args = staged
    ? ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--', relPath]
    : ['diff', '--no-ext-diff', '--no-textconv', '--', relPath];
  try {
    return await runGit(root, args, 10_000);
  } catch (error) {
    if (error instanceof Error && /not a git repository/i.test(error.message)) {
      return null;
    }
    throw error;
  }
}
