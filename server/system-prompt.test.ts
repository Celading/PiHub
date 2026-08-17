import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSystemPromptStore } from './system-prompt.js';

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir !== undefined) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe('system prompt store (settings preview → edit → save)', () => {
  it('returns an empty prompt when the file is absent', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'pi-panel-sp-'));
    const store = createSystemPromptStore({ home: tempDir, reload: () => 'reloaded' });
    expect(await store.get()).toBe('');
  });

  it('saves the prompt into the home dir and triggers a runtime reload', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'pi-panel-sp-'));
    const reload = vi.fn(() => 'reloaded' as const);
    const store = createSystemPromptStore({ home: tempDir, reload });
    const result = await store.save('You are a careful engineer.');
    expect(result).toEqual({ success: true });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(await readFile(path.join(tempDir, 'system-prompt.md'), 'utf8')).toBe(
      'You are a careful engineer.',
    );
    expect(await store.get()).toBe('You are a careful engineer.');
  });

  it('rejects oversized prompts without writing', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'pi-panel-sp-'));
    const reload = vi.fn(() => 'reloaded' as const);
    const store = createSystemPromptStore({ home: tempDir, reload });
    const result = await store.save('x'.repeat(64 * 1024 + 1));
    expect(result.success).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
