import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetPihubHomeCache, resolvePihubHome } from './pihub-home.js';

const originalEnv = { ...process.env };

beforeEach(() => {
  resetPihubHomeCache();
});

// Restore keys on the REAL process.env object — reassigning the whole
// object would detach the native (setenv) linkage that os.homedir() uses.
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (originalEnv[key] === undefined) {
      Reflect.deleteProperty(process.env, key);
    }
  }
  for (const [key, value] of Object.entries(originalEnv)) {
    if (process.env[key] !== value) {
      process.env[key] = value;
    }
  }
});

describe('P1-08c pihub home resolution', () => {
  it('uses PIHUB_HOME when set and usable', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pihub-home-'));
    process.env.PIHUB_HOME = dir;
    const home = await resolvePihubHome();
    expect(home.dir).toBe(dir);
    expect(home.fallback).toBe(false);
  });

  it('falls back to ./itData when the primary home is unusable', async () => {
    // A FILE blocks both PIHUB_HOME and $HOME (mkdir fails → unusable), so
    // the chain lands on the runtime dir ./itData.
    const blocked = path.join(mkdtempSync(path.join(tmpdir(), 'pihub-home-')), 'blocker');
    writeFileSync(blocked, 'x', 'utf8');
    process.env.PIHUB_HOME = blocked;
    process.env.HOME = blocked;
    const home = await resolvePihubHome();
    expect(home.dir.endsWith(path.sep + 'itData') || home.dir.endsWith('/itData')).toBe(true);
    expect(home.fallback).toBe(true);
  });
});
