/**
 * dsh gateway patch settings — the `dsh --patch` user layer (gateway.patch.yml)
 * holds the provider + default-model rows the embedded kernel boots with.
 * This module reads/writes that file so the settings page can switch models
 * without touching credentials (the key stays an env reference).
 */
import { writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveDshBinary } from './adapters/dsh-adapter.js';

export interface DshPatchInfo {
  provider: string | null;
  model: string | null;
  baseURL: string | null;
  apiKeyEnv: string | null;
  models: string[];
  patchPath: string;
}

/** Resolve the gateway patch path: PIHUB_DSH_PATCH, else $DSH_HOME/gateway.patch.yml. */
export function resolveDshPatchPath(): string | undefined {
  if (process.env.PIHUB_DSH_PATCH !== undefined && process.env.PIHUB_DSH_PATCH.length > 0) {
    return process.env.PIHUB_DSH_PATCH;
  }
  if (process.env.DSH_HOME !== undefined && process.env.DSH_HOME.length > 0) {
    return path.join(process.env.DSH_HOME, 'gateway.patch.yml');
  }
  return undefined;
}

/** Parse the fixed-shape gateway patch (machine-written YAML). */
export function parseDshPatch(raw: string): Omit<DshPatchInfo, 'patchPath'> {
  const provider = /^\s*provider:\s*(\S+)\s*$/m.exec(raw)?.[1] ?? null;
  const model = /^\s*model:\s*(\S+)\s*$/m.exec(raw)?.[1] ?? null;
  const baseURL = /^\s*baseURL:\s*(\S+)\s*$/m.exec(raw)?.[1] ?? null;
  const apiKeyEnv = /^\s*apiKeyEnv:\s*(\S+)\s*$/m.exec(raw)?.[1] ?? null;
  const models: string[] = [];
  let inModels = false;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === 'models:') {
      inModels = true;
      continue;
    }
    if (inModels) {
      const item = /^-\s*id:\s*(\S+)/.exec(trimmed);
      if (item !== null) {
        models.push(item[1] ?? '');
      } else if (trimmed.length > 0 && !trimmed.startsWith('-')) {
        inModels = false;
      }
    }
  }
  return { provider, model, baseURL, apiKeyEnv, models: models.filter(Boolean) };
}

export function readDshPatch(): DshPatchInfo | null {
  const patchPath = resolveDshPatchPath();
  if (patchPath === undefined) {
    return null;
  }
  try {
    const raw = readFileSync(patchPath, 'utf8');
    return { ...parseDshPatch(raw), patchPath };
  } catch {
    return null;
  }
}

/** Switch the default model in the gateway patch (model must be in the list). */
export async function updateDshPatchModel(model: string): Promise<{ patchPath: string } | null> {
  const patchPath = resolveDshPatchPath();
  if (patchPath === undefined) {
    return null;
  }
  try {
    const raw = readFileSync(patchPath, 'utf8');
    const updated = raw.replace(/^(\s*model:\s*)\S+(\s*)$/m, `$1${model}$2`);
    if (updated === raw) {
      throw new Error('gateway patch has no model row to update');
    }
    await writeFile(patchPath, updated, 'utf8');
    return { patchPath };
  } catch {
    return null;
  }
}

/** dsh kernel version: vendored mirror first, then the resolved binary. */
export function dshVersion(): string {
  try {
    const home = process.env.DSH_HOME;
    if (home !== undefined && home.length > 0) {
      const manifest = JSON.parse(
        readFileSync(path.join(home, 'vendor', 'dsh', 'package.json'), 'utf8'),
      ) as { version?: unknown };
      if (typeof manifest.version === 'string') {
        return manifest.version;
      }
    }
  } catch {
    // fall through to the resolved binary
  }
  try {
    const bin = resolveDshBinary();
    if (bin.length > 0) {
      const manifest = JSON.parse(
        readFileSync(path.join(path.dirname(bin), '..', 'package.json'), 'utf8'),
      ) as { version?: unknown };
      if (typeof manifest.version === 'string') {
        return manifest.version;
      }
    }
  } catch {
    // unknown
  }
  return 'unknown';
}
