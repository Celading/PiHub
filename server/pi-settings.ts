import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const MAX_PI_SETTINGS_BYTES = 64 * 1024;

export class PiSettingsValidationError extends Error {}

export function validatePiSettings(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PiSettingsValidationError('settings must be a JSON object');
  }
  const settings = value as Record<string, unknown>;
  const encoded = `${JSON.stringify(settings, null, 2)}\n`;
  if (Buffer.byteLength(encoded, 'utf8') > MAX_PI_SETTINGS_BYTES) {
    throw new PiSettingsValidationError('settings.json exceeds 64 KiB');
  }
  return settings;
}

export async function readPiSettings(agentDir: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(path.join(agentDir, 'settings.json'), 'utf8'),
    );
    return validatePiSettings(parsed);
  } catch (error) {
    if (error instanceof PiSettingsValidationError) {
      return {};
    }
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || error instanceof SyntaxError) {
      return {};
    }
    throw error;
  }
}

export async function savePiSettings(
  agentDir: string,
  value: unknown,
): Promise<Record<string, unknown>> {
  const settings = validatePiSettings(value);
  const target = path.join(agentDir, 'settings.json');
  const temp = path.join(agentDir, `.settings.json.${String(process.pid)}.${String(Date.now())}.tmp`);
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temp, target);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
  return settings;
}
