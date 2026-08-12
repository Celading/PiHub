import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * PiHub home resolution (owner convention 2026-08-12): every PiHub-owned
 * artifact — config (`config.toml`), stored data, hardcoded content,
 * databases — lives under ONE dedicated home directory:
 *
 *   1. `$PIHUB_HOME` when set (explicit override)
 *   2. `~/.pihub` (default)
 *   3. `./itData` (runtime dir) when the primary home is NOT usable — e.g.
 *      the home directory cannot be created/written (no permission).
 *
 * The home is resolved once at startup and reused by every store (pipelines,
 * future databases, …). Nothing PiHub-owned is ever written into `~/.pi`.
 */

// One shared resolution promise: the FIRST call wins and concurrent callers
// (loadPihubConfig + index wiring both resolve at import time) await the
// same result instead of racing two probe sequences.
let cachedPromise: Promise<{ dir: string; fallback: boolean }> | null = null;

// Probe file names must be unique per invocation — concurrent probes with
// the same pid would unlink each other's file and falsely report unusable.
let probeCounter = 0;

async function usable(dir: string): Promise<boolean> {
  try {
    await mkdir(dir, { recursive: true });
    // Write probe: mkdir can succeed where writes fail (quota, ACLs).
    probeCounter += 1;
    const probe = path.join(dir, `.pihub-probe-${String(process.pid)}-${String(probeCounter)}`);
    await writeFile(probe, 'ok', 'utf8');
    await unlink(probe);
    return true;
  } catch {
    return false;
  }
}

/** Resolves the PiHub home directory (env → ~/.pihub → ./itData). */
export function resolvePihubHome(): Promise<{ dir: string; fallback: boolean }> {
  if (cachedPromise === null) {
    cachedPromise = resolveOnce();
  }
  return cachedPromise;
}

async function resolveOnce(): Promise<{ dir: string; fallback: boolean }> {
  const explicit = process.env.PIHUB_HOME;
  const candidates: Array<{ dir: string; fallback: boolean }> = [];
  if (explicit !== undefined && explicit.length > 0) {
    candidates.push({ dir: path.resolve(explicit), fallback: false });
  }
  candidates.push({ dir: path.join(homedir(), '.pihub'), fallback: false });
  candidates.push({ dir: path.resolve(process.cwd(), 'itData'), fallback: true });

  for (const candidate of candidates) {
    if (await usable(candidate.dir)) {
      return candidate;
    }
  }
  // Nothing usable — last resort is the runtime dir (already tried, but
  // report it anyway so callers can fail honestly).
  const last = candidates[candidates.length - 1];
  return last ?? { dir: path.resolve(process.cwd(), 'itData'), fallback: true };
}

/** Config file path inside the home. */
export function configFileOf(home: string): string {
  return path.join(home, 'config.toml');
}

/** Test hook: drop the cached resolution (unit tests only). */
export function resetPihubHomeCache(): void {
  cachedPromise = null;
}
