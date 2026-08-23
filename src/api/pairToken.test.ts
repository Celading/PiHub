import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P2-02 pairing-token unit tests. The module is node-safe (no window), so
 * the persisted-code paths stub a minimal window/localStorage and re-import
 * the module fresh for each case (the module keeps a read cache).
 */

interface PairTokenApi {
  getPairCode(): string;
  setPairCode(code: string): void;
  pairQuery(): string;
  withPair(path: string): string;
}

const memory = new Map<string, string>();

const fakeLocalStorage = {
  getItem: (key: string): string | null => memory.get(key) ?? null,
  setItem: (key: string, value: string): void => {
    memory.set(key, value);
  },
  removeItem: (key: string): void => {
    memory.delete(key);
  },
};

function stubWindow(): void {
  vi.stubGlobal('window', { localStorage: fakeLocalStorage });
}

async function loadModule(): Promise<PairTokenApi> {
  vi.resetModules();
  return import('./pairToken.js');
}

beforeEach(() => {
  memory.clear();
  vi.unstubAllGlobals();
});

describe('pairToken (no window)', () => {
  it('returns no pair query when nothing is stored', async () => {
    const mod = await loadModule();
    expect(mod.getPairCode()).toBe('');
    expect(mod.pairQuery()).toBe('');
    expect(mod.withPair('/api/sessions')).toBe('/api/sessions');
  });
});

describe('pairToken (window + localStorage)', () => {
  it('persists and returns the entered code', async () => {
    stubWindow();
    const mod = await loadModule();
    expect(mod.getPairCode()).toBe('');
    mod.setPairCode('  abc123  ');
    expect(mod.getPairCode()).toBe('abc123');
    expect(memory.get('pi-panel:pair')).toBe('abc123');
  });

  it('appends pair= to paths, handling existing queries', async () => {
    stubWindow();
    const mod = await loadModule();
    mod.setPairCode('code#1');
    expect(mod.withPair('/api/sessions')).toBe('/api/sessions?pair=code%231');
    expect(mod.withPair('/api/sessions?x=1')).toBe('/api/sessions?x=1&pair=code%231');
  });

  it('clears the stored code', async () => {
    stubWindow();
    const mod = await loadModule();
    mod.setPairCode('abc');
    mod.setPairCode('');
    expect(mod.getPairCode()).toBe('');
    expect(mod.pairQuery()).toBe('');
    expect(memory.has('pi-panel:pair')).toBe(false);
  });

  it('recovers the persisted code on a fresh module load', async () => {
    stubWindow();
    let mod = await loadModule();
    mod.setPairCode('persisted');
    mod = await loadModule();
    expect(mod.getPairCode()).toBe('persisted');
  });
});
