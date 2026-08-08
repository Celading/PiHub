import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readAtomcodeHistory } from './atomcode-history.js';
import { parseZcodeRollout } from './zcode-history.js';

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir !== undefined) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe('atomcode history (ADAPTER2 A)', () => {
  it('parses history.json message array', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'pi-panel-atomcode-test-'));
    const original = process.env['ATOMCODE_HOME'];
    process.env['ATOMCODE_HOME'] = tempDir;
    try {
      await writeFile(
        path.join(tempDir, 'history.json'),
        JSON.stringify([
          { role: 'User', content: { Text: 'hello' } },
          { role: 'Assistant', content: { Text: 'hi there' } },
          { role: 'Tool', content: { Text: 'ran command' } },
          { role: 'User', content: 'plain string message' },
        ]),
        'utf8',
      );
      const messages = await readAtomcodeHistory();
      expect(messages).toEqual([
        { role: 'user', text: 'hello' },
        { role: 'assistant', text: 'hi there' },
        { role: 'tool', text: 'ran command' },
        { role: 'user', text: 'plain string message' },
      ]);
    } finally {
      if (original === undefined) {
        delete process.env['ATOMCODE_HOME'];
      } else {
        process.env['ATOMCODE_HOME'] = original;
      }
    }
  });

  it('returns empty for missing history', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'pi-panel-atomcode-test-'));
    const original = process.env['ATOMCODE_HOME'];
    process.env['ATOMCODE_HOME'] = tempDir;
    try {
      expect(await readAtomcodeHistory()).toEqual([]);
    } finally {
      if (original === undefined) {
        delete process.env['ATOMCODE_HOME'];
      } else {
        process.env['ATOMCODE_HOME'] = original;
      }
    }
  });
});

describe('zcode rollout (ADAPTER2 B)', () => {
  it('parses a rollout file into turns with usage and timing', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'pi-panel-zcode-test-'));
    const file = path.join(tempDir, 'model-io-sess_abc.jsonl');
    await writeFile(
      file,
      [
        JSON.stringify({
          completedAt: '2026-08-09T01:00:00.000Z',
          durationMs: 1200,
          requestId: 'r1',
          model: { modelId: 'deepseek-v4-flash', providerId: 'a725dd07' },
          response: {
            finishReason: 'stop',
            modelId: 'deepseek-v4-flash',
            text: 'reply one',
            usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
          },
          sessionId: 'sess_abc',
          startedAt: '2026-08-09T00:59:58.800Z',
          turnId: 't1',
          type: 'modelIO',
        }),
        JSON.stringify({
          completedAt: '2026-08-09T01:01:00.000Z',
          durationMs: 800,
          requestId: 'r2',
          model: { modelId: 'deepseek-v4-flash', providerId: 'a725dd07' },
          response: {
            finishReason: 'stop',
            modelId: 'deepseek-v4-flash',
            text: 'reply two',
            usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 },
          },
          sessionId: 'sess_abc',
          startedAt: '2026-08-09T01:00:59.200Z',
          turnId: 't2',
          type: 'modelIO',
        }),
      ].join('\n'),
      'utf8',
    );
    const detail = await parseZcodeRollout(file);
    expect(detail).not.toBeNull();
    if (detail === null) {
      return;
    }
    expect(detail.sessionId).toBe('sess_abc');
    expect(detail.turns).toBe(2);
    expect(detail.totalTokens).toBe(180);
    expect(detail.modelId).toBe('deepseek-v4-flash');
    expect(detail.turnList).toHaveLength(2);
    expect(detail.turnList[0]?.text).toBe('reply one');
    expect(detail.turnList[1]?.durationMs).toBe(800);
  });

  it('skips lines without requestId/startedAt', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'pi-panel-zcode-test-'));
    const file = path.join(tempDir, 'model-io-sess_x.jsonl');
    await writeFile(
      file,
      [
        JSON.stringify({ type: 'something-else', payload: {} }),
        JSON.stringify({
          completedAt: '2026-08-09T02:00:00.000Z',
          durationMs: 500,
          requestId: 'r3',
          model: { modelId: 'm', providerId: 'p' },
          response: { finishReason: 'stop', text: 'ok', usage: { totalTokens: 10 } },
          sessionId: 'sess_x',
          startedAt: '2026-08-09T01:59:59.500Z',
          turnId: 't3',
        }),
      ].join('\n'),
      'utf8',
    );
    const detail = await parseZcodeRollout(file);
    expect(detail).not.toBeNull();
    expect(detail?.turns).toBe(1);
    expect(detail?.turnList[0]?.usage.totalTokens).toBe(10);
  });
});
