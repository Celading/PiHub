import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { GitChange } from '../shared/types.js';

const SNAPSHOT_VERSION = 1;
const MAX_FILES = 2_000;
const MAX_HASH_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_HASH_BYTES = 32 * 1024 * 1024;
const MAX_TEXT_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_TEXT_BYTES = 4 * 1024 * 1024;
const IGNORED_NAMES = new Set(['.git', 'node_modules', '.DS_Store']);

interface SnapshotEntry {
  size: number;
  mtimeMs: number;
  signature: string;
  text?: string;
}

interface StoredSnapshot {
  version: 1;
  root: string;
  createdAt: string;
  truncated: boolean;
  entries: Record<string, SnapshotEntry>;
}

interface ScanResult {
  root: string;
  truncated: boolean;
  entries: Record<string, SnapshotEntry>;
}

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function isSnapshot(value: unknown): value is StoredSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record['version'] === SNAPSHOT_VERSION &&
    typeof record['root'] === 'string' &&
    typeof record['createdAt'] === 'string' &&
    typeof record['truncated'] === 'boolean' &&
    typeof record['entries'] === 'object' &&
    record['entries'] !== null &&
    !Array.isArray(record['entries'])
  );
}

async function scanWorkspace(root: string): Promise<ScanResult> {
  const realRoot = await realpath(path.resolve(root));
  const entries: Record<string, SnapshotEntry> = {};
  let fileCount = 0;
  let hashedBytes = 0;
  let textBytes = 0;
  let truncated = false;

  const walk = async (absoluteDir: string, relativeDir: string): Promise<void> => {
    const dirents = await readdir(absoluteDir, { withFileTypes: true });
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of dirents) {
      if (IGNORED_NAMES.has(dirent.name) || dirent.isSymbolicLink()) {
        continue;
      }
      const absolute = path.join(absoluteDir, dirent.name);
      const relative = relativeDir.length === 0 ? dirent.name : `${relativeDir}/${dirent.name}`;
      if (dirent.isDirectory()) {
        await walk(absolute, relative);
        continue;
      }
      if (!dirent.isFile()) {
        continue;
      }
      if (fileCount >= MAX_FILES) {
        truncated = true;
        continue;
      }
      fileCount += 1;
      const info = await stat(absolute);
      let signature = `meta:${String(info.size)}:${String(Math.trunc(info.mtimeMs))}`;
      let text: string | undefined;
      if (
        info.size <= MAX_HASH_FILE_BYTES &&
        hashedBytes + info.size <= MAX_TOTAL_HASH_BYTES
      ) {
        const data = await readFile(absolute);
        hashedBytes += data.length;
        signature = `sha256:${sha256(data)}`;
        if (
          data.length <= MAX_TEXT_FILE_BYTES &&
          textBytes + data.length <= MAX_TOTAL_TEXT_BYTES &&
          !data.includes(0)
        ) {
          text = data.toString('utf8');
          textBytes += data.length;
        }
      } else {
        truncated = true;
      }
      entries[relative] = {
        size: info.size,
        mtimeMs: info.mtimeMs,
        signature,
        ...(text !== undefined ? { text } : {}),
      };
    }
  };

  await walk(realRoot, '');
  return { root: realRoot, truncated, entries };
}

function fullFileDiff(relativePath: string, before: string, after: string): string {
  const beforeLines = before.length === 0 ? [] : before.replace(/\n$/u, '').split('\n');
  const afterLines = after.length === 0 ? [] : after.replace(/\n$/u, '').split('\n');
  const beforeRange = beforeLines.length === 0 ? '0,0' : `1,${String(beforeLines.length)}`;
  const afterRange = afterLines.length === 0 ? '0,0' : `1,${String(afterLines.length)}`;
  return [
    `--- a/${relativePath}`,
    `+++ b/${relativePath}`,
    `@@ -${beforeRange} +${afterRange} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
    '',
  ].join('\n');
}

export function createWorkspaceSnapshotStore(home: string) {
  const snapshotPath = (realRoot: string): string =>
    path.join(home, `${sha256(realRoot).slice(0, 24)}.json`);

  const readSnapshot = async (realRoot: string): Promise<StoredSnapshot | null> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(snapshotPath(realRoot), 'utf8'));
      return isSnapshot(parsed) && parsed.root === realRoot ? parsed : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) {
        return null;
      }
      throw error;
    }
  };

  const writeSnapshot = async (snapshot: StoredSnapshot): Promise<void> => {
    await mkdir(home, { recursive: true, mode: 0o700 });
    const target = snapshotPath(snapshot.root);
    const temp = `${target}.${String(process.pid)}.${String(Date.now())}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(snapshot)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temp, target);
    } finally {
      await rm(temp, { force: true }).catch(() => {});
    }
  };

  const ensureBaseline = async (root: string): Promise<StoredSnapshot> => {
    const realRoot = await realpath(path.resolve(root));
    const existing = await readSnapshot(realRoot);
    if (existing !== null) {
      return existing;
    }
    const scan = await scanWorkspace(realRoot);
    const snapshot: StoredSnapshot = {
      version: SNAPSHOT_VERSION,
      root: scan.root,
      createdAt: new Date().toISOString(),
      truncated: scan.truncated,
      entries: scan.entries,
    };
    await writeSnapshot(snapshot);
    return snapshot;
  };

  const status = async (root: string): Promise<GitChange[]> => {
    const baseline = await ensureBaseline(root);
    const current = await scanWorkspace(baseline.root);
    const changes: GitChange[] = [];
    for (const relativePath of Object.keys(current.entries).sort()) {
      const now = current.entries[relativePath];
      const before = baseline.entries[relativePath];
      if (now === undefined) {
        continue;
      }
      if (before === undefined) {
        changes.push({
          path: relativePath,
          index: ' ',
          worktree: 'A',
          kind: 'added',
          staged: false,
        });
      } else if (before.signature !== now.signature) {
        changes.push({
          path: relativePath,
          index: ' ',
          worktree: 'M',
          kind: 'modified',
          staged: false,
        });
      }
    }
    for (const relativePath of Object.keys(baseline.entries).sort()) {
      if (current.entries[relativePath] === undefined) {
        changes.push({
          path: relativePath,
          index: ' ',
          worktree: 'D',
          kind: 'deleted',
          staged: false,
        });
      }
    }
    return changes.sort((a, b) => a.path.localeCompare(b.path));
  };

  const diff = async (root: string, relativePath: string): Promise<string> => {
    const baseline = await ensureBaseline(root);
    const current = await scanWorkspace(baseline.root);
    const before = baseline.entries[relativePath];
    const after = current.entries[relativePath];
    if (before?.signature === after?.signature) {
      return '';
    }
    const beforeText = before === undefined ? '' : before.text;
    const afterText = after === undefined ? '' : after.text;
    if (beforeText === undefined || afterText === undefined) {
      return `Workspace baseline changed: ${relativePath}\nBinary or large-file diff is unavailable.`;
    }
    return fullFileDiff(relativePath, beforeText, afterText);
  };

  return { ensureBaseline, status, diff };
}

export type WorkspaceSnapshotStore = ReturnType<typeof createWorkspaceSnapshotStore>;
