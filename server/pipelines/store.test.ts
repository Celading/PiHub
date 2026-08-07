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
});
