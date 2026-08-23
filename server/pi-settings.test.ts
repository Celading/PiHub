import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_PI_SETTINGS_BYTES,
  PiSettingsValidationError,
  readPiSettings,
  savePiSettings,
  validatePiSettings,
} from './pi-settings.js';

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir !== undefined) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe('Pi Agent settings store', () => {
  it('returns an empty object when settings.json is absent', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'pihub-pi-settings-'));
    expect(await readPiSettings(path.join(tempDir, '.pi', 'agent'))).toEqual({});
  });

  it('atomically preserves unknown valid fields', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'pihub-pi-settings-'));
    const agentDir = path.join(tempDir, '.pi', 'agent');
    const settings = {
      defaultProvider: 'provider-a',
      defaultModel: 'model-a',
      defaultThinkingLevel: 'high',
      customExtensionSetting: { enabled: true },
    };
    expect(await savePiSettings(agentDir, settings)).toEqual(settings);
    expect(JSON.parse(await readFile(path.join(agentDir, 'settings.json'), 'utf8'))).toEqual(settings);
    expect(await readPiSettings(agentDir)).toEqual(settings);
  });

  it('rejects arrays and oversized JSON', () => {
    expect(() => validatePiSettings([])).toThrow(PiSettingsValidationError);
    expect(() => validatePiSettings({ value: 'x'.repeat(MAX_PI_SETTINGS_BYTES) })).toThrow(
      'settings.json exceeds 64 KiB',
    );
  });
});
