import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPipelineStore, type PipelineStore } from './store.js';
import type { Pipeline } from '../../shared/types.js';

let tempDir: string | undefined;

async function makeStore(): Promise<PipelineStore> {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'pi-panel-pipe-test-'));
  return createPipelineStore(tempDir);
}

afterEach(async () => {
  if (tempDir !== undefined) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

function samplePipeline(overrides: Partial<Pipeline> = {}): Pipeline {
  return {
    id: 'p1',
    name: 'Refactor HTML',
    description: 'plan, confirm, execute',
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:00.000Z',
    onError: 'stop',
    steps: [
      { id: 's1', name: 'Plan', type: 'prompt', prompt: 'analyze {{input}}' },
      { id: 's2', name: 'Confirm', type: 'approval', requiresApproval: true },
      {
        id: 's3',
        name: 'Execute',
        type: 'prompt',
        prompt: 'run the plan; last output: {{lastOutput}}',
        match: 'error',
        nextOnMatch: 's4',
      },
    ],
    ...overrides,
  };
}

describe('pipeline store', () => {
  it('round-trips save/list/get/remove', async () => {
    const store = await makeStore();
    expect(store.list()).toEqual([]);

    const saved = store.save(samplePipeline());
    expect(saved.id).toBe('p1');
    expect(store.list()).toHaveLength(1);
    expect(store.get('p1')?.name).toBe('Refactor HTML');

    // save with same id replaces
    store.save(samplePipeline({ name: 'Renamed' }));
    expect(store.list()).toHaveLength(1);
    expect(store.get('p1')?.name).toBe('Renamed');

    expect(store.remove('p1')).toBe(true);
    expect(store.remove('p1')).toBe(false);
    expect(store.list()).toHaveLength(0);
  });

  it('persists across store instances (same base dir)', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'pi-panel-pipe-test-'));
    const a = createPipelineStore(tempDir);
    a.save(samplePipeline());
    const b = createPipelineStore(tempDir);
    expect(b.get('p1')?.name).toBe('Refactor HTML');
  });

  it('rejects invalid definitions via the zod schema', async () => {
    const store = await makeStore();
    expect(() => store.save({ ...samplePipeline(), steps: [] })).toThrow();
    expect(() =>
      store.save({
        ...samplePipeline(),
        steps: [{ ...samplePipeline().steps[0], type: 'nope' } as unknown as Pipeline['steps'][number]],
      }),
    ).toThrow();
    expect(store.list()).toHaveLength(0);
  });

  it('backs up a corrupted definitions file and reads empty', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'pi-panel-pipe-test-'));
    const defsPath = path.join(tempDir, 'pipelines.json');
    await writeFile(defsPath, '{not json', 'utf8');
    const store = createPipelineStore(tempDir);
    expect(store.list()).toEqual([]);
    // original bytes preserved under a .corrupt-* backup
    const entries = await readdir(tempDir);
    expect(entries.some((e) => /^pipelines\.json\.corrupt-\d+$/.test(e))).toBe(true);
  });

  it('appends run log lines and bounds the log size', async () => {
    const store = await makeStore();
    for (let i = 0; i < 20; i += 1) {
      store.appendRunLine('p1', { step: i });
    }
    const log = store.readRunLog('p1');
    expect(log).toHaveLength(20);
    expect((log[0] as { step: number }).step).toBe(0);
    expect((log[19] as { step: number }).step).toBe(19);

    // readRunLog of a pipeline with no runs is empty
    expect(store.readRunLog('missing')).toEqual([]);
  });

  it('v1b: rejects path-traversal ids on write (fail-closed)', async () => {
    const store = await makeStore();
    expect(() => {
      store.appendRunLine('../../escape', { step: 1 });
    }).toThrow(/unsafe id/);
    expect(() => {
      store.appendRunLine('..', { step: 1 });
    }).toThrow(/unsafe id/);
    expect(() => {
      store.appendRunLine('a/b', { step: 1 });
    }).toThrow(/unsafe id/);
    expect(() => {
      store.appendRunLine('', { step: 1 });
    }).toThrow(/unsafe id/);
    // the escape file must never exist outside the runs dir
    const { readdir } = await import('node:fs/promises');
    const entries = tempDir === undefined ? [] : await readdir(tempDir);
    expect(entries.some((e) => e === 'escape.jsonl')).toBe(false);
  });

  it('v1b: returns [] for unsafe ids on read (never touches the filesystem)', async () => {
    const store = await makeStore();
    store.appendRunLine('p1', { step: 1 });
    expect(store.readRunLog('../../escape')).toEqual([]);
    expect(store.readRunLog('a/b')).toEqual([]);
  });

  it('v1b: run log truncation keeps exactly MAX_RUN_LINES newest lines', async () => {
    const store = await makeStore();
    for (let i = 0; i < 505; i += 1) {
      store.appendRunLine('p1', { step: i });
    }
    const log = store.readRunLog('p1');
    expect(log).toHaveLength(500);
    expect((log[0] as { step: number }).step).toBe(5);
    expect((log[499] as { step: number }).step).toBe(504);
  });

  it('v1b: journal appends per-run snapshots and recoverable scans running runs', async () => {
    const store = await makeStore();
    store.appendRunJournal('run-1', { runId: 'run-1', status: 'running', step: 1 });
    store.appendRunJournal('run-1', { runId: 'run-1', status: 'running', step: 2 });
    store.appendRunJournal('run-2', { runId: 'run-2', status: 'completed' });
    const recoverable = store.listRecoverableRuns();
    expect(recoverable).toHaveLength(1);
    expect(recoverable[0]?.runId).toBe('run-1');
    expect((recoverable[0]?.snapshot as { step: number }).step).toBe(2);
  });

  it('v1b: journal and receipts reject unsafe run ids', async () => {
    const store = await makeStore();
    expect(() => {
      store.appendRunJournal('../../x', {});
    }).toThrow(/unsafe id/);
    expect(() => {
      store.writeRunReceipt('../../x', {});
    }).toThrow(/unsafe id/);
  });

  it('v1b: receipts round-trip, filter by pipeline and sort newest first', async () => {
    const store = await makeStore();
    store.writeRunReceipt('run-1', { runId: 'run-1', pipelineId: 'p1', status: 'completed', finishedAt: 100 });
    store.writeRunReceipt('run-2', { runId: 'run-2', pipelineId: 'p1', status: 'aborted', finishedAt: 200 });
    store.writeRunReceipt('run-3', { runId: 'run-3', pipelineId: 'other', status: 'completed', finishedAt: 300 });
    expect((store.readRunReceipt('run-1') as { runId: string }).runId).toBe('run-1');
    expect(store.readRunReceipt('missing')).toBeNull();
    const p1 = store.listRunReceipts('p1');
    expect(p1).toHaveLength(2);
    expect((p1[0] as { runId: string }).runId).toBe('run-2'); // newest first
    expect(store.listRunReceipts('../../x')).toEqual([]);
  });
});
