import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { configFileOf, resolvePihubHome } from './pihub-home.js';

/**
 * Minimal TOML subset for `config.toml` — sections, `key = value` scalars
 * (double/single-quoted strings, numbers, booleans), `#` comments and blank
 * lines. Intentionally NOT a full TOML parser (no arrays of tables, no
 * multiline strings): the config surface is small and we stay zero-dependency.
 *
 * Example:
 *   # PiHub config — dedicated home: ~/.pihub (fallback ./itData)
 *   [server]
 *   port = 4000
 *   host = "127.0.0.1"
 *   url = "http://127.0.0.1:4000"
 */

export interface PihubServerConfig {
  port?: number;
  host?: string;
  url?: string;
}

export interface PihubConfig {
  server: PihubServerConfig;
}

export function parseToml(input: string): PihubConfig {
  const out: PihubConfig = { server: {} };
  let section: keyof PihubConfig | null = null;
  for (const rawLine of input.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const sectionMatch = line.match(/^\[([a-zA-Z0-9_-]+)\]\s*$/);
    if (sectionMatch !== null) {
      section = sectionMatch[1] as keyof PihubConfig;
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    const rawValue = line.slice(eq + 1).trim();
    const value = parseScalar(rawValue);
    if (value === undefined) {
      continue;
    }
    if (section === 'server') {
      if (key === 'port' && typeof value === 'number') {
        out.server.port = Math.floor(value);
      } else if (key === 'host' && typeof value === 'string') {
        out.server.host = value;
      } else if (key === 'url' && typeof value === 'string') {
        out.server.url = value;
      }
    }
  }
  return out;
}

function parseScalar(raw: string): string | number | boolean | undefined {
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    return raw.slice(1, -1);
  }
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
    return raw.slice(1, -1);
  }
  if (raw === 'true') {
    return true;
  }
  if (raw === 'false') {
    return false;
  }
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && raw.trim().length > 0) {
    return numeric;
  }
  return undefined;
}

/** Reads `config.toml` from the resolved home (missing file → empty config). */
export async function loadPihubConfig(): Promise<PihubConfig> {
  try {
    const home = await resolvePihubHome();
    const file = configFileOf(home.dir);
    const raw = await readFile(file, 'utf8');
    return parseToml(raw);
  } catch {
    return { server: {} };
  }
}

export const PRODUCTION_DEFAULT_PORT = 18_384;
export const DEBUG_DEFAULT_PORT = 3_001;

export type ServerRuntimeMode = 'production' | 'debug' | 'demo';

function runtimeModeFromEnvironment(): ServerRuntimeMode {
  const value = process.env.PIHUB_MODE;
  return value === 'debug' || value === 'demo' ? value : 'production';
}

/**
 * Effective server options:
 * PIHUB_PORT → PORT → config.port → mode default.
 *
 * Production and demo use the installed product port (18384). Port 3001 is
 * reserved for the explicit debug stack, where Vite owns 18384.
 */
export function effectiveServerConfig(
  config: PihubConfig,
  runtimeMode: ServerRuntimeMode = runtimeModeFromEnvironment(),
): {
  port: number;
  host: string;
  url: string;
} {
  const envPort = process.env.PIHUB_PORT ?? process.env.PORT;
  const defaultPort = runtimeMode === 'debug' ? DEBUG_DEFAULT_PORT : PRODUCTION_DEFAULT_PORT;
  const port = envPort !== undefined && Number.isFinite(Number(envPort))
    ? Math.floor(Number(envPort))
    : config.server.port ?? defaultPort;
  const host = config.server.host ?? '127.0.0.1';
  const url = config.server.url ?? `http://${host}:${String(port)}`;
  return { port, host, url };
}

/** Absolute config file path for the current home (for display). */
export async function pihubConfigFilePath(): Promise<string | null> {
  try {
    const home = await resolvePihubHome();
    return path.join(home.dir, 'config.toml');
  } catch {
    return null;
  }
}
