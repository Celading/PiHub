/**
 * dsh session history — lets the panel's sessions view auto-discover
 * DeepSeek Harness sessions (the "dsh adapter" the user expects in history).
 *
 * Data sources, in order:
 *  1. a connected dsh web instance (session.list — authoritative rows with
 *     updatedAt/cwd/running/agentPreset);
 *  2. the offline DSH_HOME/sessions tree (session.jsonl.zstd headers — only
 *     created/ cwd/id survive, message content is not persisted headless).
 *
 * Gated by runtime availability and the configured DSH home.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as zlib from 'node:zlib';

export interface DshSessionRow {
  sessionId: string;
  updatedAt: number;
  cwd: string;
  running: boolean;
  agentPreset?: string;
  source: 'web' | 'files';
}

export interface DshHistoryOptions {
  dshHome?: string;
  /** Optional live source: a connected dsh web session.list callback. */
  webList?: () => Promise<{ ok: boolean; value?: unknown }>;
}

export function resolveDshSessionsDir(dshHome?: string): string {
  const home = dshHome ?? process.env.DSH_HOME;
  if (home !== undefined && home.length > 0) {
    return path.join(home, 'sessions');
  }
  return path.join(os.homedir(), '.dsh', 'sessions');
}

/** Scan $DSH_HOME/sessions for session dirs; read each zstd header record. */
export function scanDshSessionFiles(dshHome?: string, limit = 100): DshSessionRow[] {
  const root = resolveDshSessionsDir(dshHome);
  const rows: DshSessionRow[] = [];
  if (root.length === 0 || !fs.existsSync(root)) {
    return rows;
  }
  const walk = (dir: string): void => {
    if (rows.length >= limit) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (!entry.isDirectory()) {
        continue;
      }
      const sessionFile = path.join(full, 'session.jsonl.zstd');
      if (!fs.existsSync(sessionFile)) {
        walk(full);
        continue;
      }
      const stat = fs.statSync(sessionFile);
      if (stat.size === 0 || stat.size > 4 * 1024 * 1024) {
        continue;
      }
      try {
        const raw = fs.readFileSync(sessionFile);
        if (typeof zlib.zstdDecompressSync !== 'function') {
          continue;
        }
        const content = zlib.zstdDecompressSync(raw).toString('utf8');
        const firstLine = content.split('\n')[0] ?? '';
        if (firstLine.length === 0) {
          continue;
        }
        const header = JSON.parse(firstLine) as {
          type?: unknown;
          id?: unknown;
          createdAt?: unknown;
          cwd?: unknown;
        };
        if (typeof header.id !== 'string') {
          continue;
        }
        const createdAt = typeof header.createdAt === 'number' ? header.createdAt : stat.mtimeMs;
        rows.push({
          sessionId: header.id,
          updatedAt: Math.max(createdAt, Math.floor(stat.mtimeMs)),
          cwd: typeof header.cwd === 'string' ? header.cwd : '',
          running: false,
          source: 'files',
        });
      } catch {
        // unreadable/corrupt session file — skip
      }
    }
  };
  walk(root);
  return rows;
}

/** Combined listing: web rows win (authoritative), file-only rows fill gaps. */
export async function listDshSessions(options: DshHistoryOptions = {}): Promise<DshSessionRow[]> {
  const webRows: DshSessionRow[] = [];
  if (options.webList !== undefined) {
    try {
      const result = await options.webList();
      if (result.ok && typeof result.value === 'object' && result.value !== null) {
        const items = (result.value as { items?: unknown }).items;
        if (Array.isArray(items)) {
          for (const item of items) {
            if (item === null || typeof item !== 'object') {
              continue;
            }
            const row = item as Record<string, unknown>;
            if (typeof row['sessionId'] !== 'string') {
              continue;
            }
            webRows.push({
              sessionId: row['sessionId'],
              updatedAt:
                typeof row['updatedAt'] === 'number'
                  ? row['updatedAt']
                  : typeof row['createdAt'] === 'number'
                    ? row['createdAt']
                    : 0,
              cwd: typeof row['cwd'] === 'string' ? row['cwd'] : '',
              running: row['running'] === true,
              ...(typeof row['agentPreset'] === 'string'
                ? { agentPreset: row['agentPreset'] }
                : {}),
              source: 'web',
            });
          }
        }
      }
    } catch {
      // web source unavailable — fall through to the file scan
    }
  }
  const fileRows = scanDshSessionFiles(options.dshHome);
  const seen = new Set(webRows.map((row) => row.sessionId));
  const combined = [...webRows, ...fileRows.filter((row) => !seen.has(row.sessionId))];
  return combined.sort((a, b) => b.updatedAt - a.updatedAt);
}
