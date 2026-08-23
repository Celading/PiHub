import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkspaceSnapshotStore } from './workspace-snapshot.js';

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir !== undefined) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe('workspace snapshot fallback', () => {
  it('keeps the first baseline and reports added files with a text diff', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'pihub-workspace-snapshot-'));
    const root = path.join(tempDir, 'workspace');
    const home = path.join(tempDir, 'baselines');
    await mkdir(root);
    const store = createWorkspaceSnapshotStore(home);
    await store.ensureBaseline(root);
    await writeFile(path.join(root, 'hello.txt'), 'hello\n', 'utf8');
    expect(await store.status(root)).toEqual([
      { path: 'hello.txt', index: ' ', worktree: 'A', kind: 'added', staged: false },
    ]);
    expect(await store.diff(root, 'hello.txt')).toContain('+hello');
    expect(await store.status(root)).toHaveLength(1);
  });

  it('reports modified and deleted baseline files', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'pihub-workspace-snapshot-'));
    const root = path.join(tempDir, 'workspace');
    await mkdir(root);
    await writeFile(path.join(root, 'edit.txt'), 'before\n', 'utf8');
    await writeFile(path.join(root, 'delete.txt'), 'gone\n', 'utf8');
    const store = createWorkspaceSnapshotStore(path.join(tempDir, 'baselines'));
    await store.ensureBaseline(root);
    await writeFile(path.join(root, 'edit.txt'), 'after\n', 'utf8');
    await rm(path.join(root, 'delete.txt'));
    expect(await store.status(root)).toEqual([
      { path: 'delete.txt', index: ' ', worktree: 'D', kind: 'deleted', staged: false },
      { path: 'edit.txt', index: ' ', worktree: 'M', kind: 'modified', staged: false },
    ]);
    const diff = await store.diff(root, 'edit.txt');
    expect(diff).toContain('-before');
    expect(diff).toContain('+after');
  });
});
