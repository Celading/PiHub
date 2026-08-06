/**
 * Pipeline definitions and run history persistence (P1-02-C).
 *
 * PiHub-owned data lives under `~/.pihub` — never inside `~/.pi`. The store
 * is injectable with a base directory so tests run against temp dirs.
 * Definitions are validated with the zod pipeline schema on every read and
 * write; a corrupted file is backed up (not silently dropped) and re-read as
 * empty.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pipelineSchema } from '../../shared/schemas.js';
import type { Pipeline } from '../../shared/types.js';

const PIPELINES_FILE = 'pipelines.json';
const RUNS_DIR = 'pipeline-runs';
const MAX_RUN_LINES = 500;

interface PipelinesFile {
  pipelines: Pipeline[];
}

export interface PipelineStore {
  /** All stored definitions (validation-failed entries are excluded). */
  list(): Pipeline[];
  get(id: string): Pipeline | undefined;
  /** Validates with the zod schema; throws on invalid input. */
  save(pipeline: Pipeline): Pipeline;
  remove(id: string): boolean;
  /** Appends one run record line (JSON) to the pipeline's run log. */
  appendRunLine(pipelineId: string, line: unknown): void;
  /** Last MAX_RUN_LINES run records, parsed JSON (malformed lines skipped). */
  readRunLog(pipelineId: string): unknown[];
}

export function createPipelineStore(baseDir: string = path.join(homedir(), '.pihub')): PipelineStore {
  const defsPath = path.join(baseDir, PIPELINES_FILE);
  const runsDir = path.join(baseDir, RUNS_DIR);

  const ensureDirs = (): void => {
    mkdirSync(baseDir, { recursive: true });
    mkdirSync(runsDir, { recursive: true });
  };

  const readDefs = (): Pipeline[] => {
    if (!existsSync(defsPath)) {
      return [];
    }
    let raw: string;
    try {
      raw = readFileSync(defsPath, 'utf8');
    } catch {
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      const file = parsed as Partial<PipelinesFile>;
      const list = Array.isArray(file.pipelines) ? file.pipelines : [];
      return list.filter((p): p is Pipeline => pipelineSchema.safeParse(p).success);
    } catch {
      // Corrupted definitions file: preserve the original bytes for recovery,
      // then start fresh instead of overwriting silently.
      try {
        renameSync(defsPath, `${defsPath}.corrupt-${String(Date.now())}`);
      } catch {
        // backup failed; still proceed with an empty store
      }
      return [];
    }
  };

  const writeDefs = (pipelines: Pipeline[]): void => {
    ensureDirs();
    const payload: PipelinesFile = { pipelines };
    const tmpPath = `${defsPath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
    renameSync(tmpPath, defsPath);
  };

  const runLogPath = (pipelineId: string): string => path.join(runsDir, `${pipelineId}.jsonl`);

  return {
    list() {
      return readDefs();
    },

    get(id: string): Pipeline | undefined {
      return readDefs().find((p) => p.id === id);
    },

    save(pipeline: Pipeline): Pipeline {
      const validated = pipelineSchema.parse(pipeline); // throws on invalid
      const rest = readDefs().filter((p) => p.id !== validated.id);
      const all = [...rest, validated].sort((a, b) => a.name.localeCompare(b.name));
      writeDefs(all);
      return validated;
    },

    remove(id: string): boolean {
      const rest = readDefs().filter((p) => p.id !== id);
      if (rest.length === readDefs().length) {
        return false;
      }
      writeDefs(rest);
      return true;
    },

    appendRunLine(pipelineId: string, line: unknown): void {
      ensureDirs();
      const logPath = runLogPath(pipelineId);
      appendFileSync(logPath, `${JSON.stringify(line)}\n`, 'utf8');
      // Keep the log bounded: rewrite with the last MAX_RUN_LINES lines.
      if (existsSync(logPath)) {
        const lines = readFileSync(logPath, 'utf8').split('\n');
        if (lines.length > MAX_RUN_LINES + 1) {
          writeFileSync(logPath, lines.slice(-MAX_RUN_LINES).join('\n'), 'utf8');
        }
      }
    },

    readRunLog(pipelineId: string): unknown[] {
      const logPath = runLogPath(pipelineId);
      if (!existsSync(logPath)) {
        return [];
      }
      try {
        const lines = readFileSync(logPath, 'utf8').split('\n').filter((l) => l.length > 0);
        const records: unknown[] = [];
        for (const line of lines.slice(-MAX_RUN_LINES)) {
          try {
            records.push(JSON.parse(line) as unknown);
          } catch {
            // malformed historical line; skip
          }
        }
        return records;
      } catch {
        return [];
      }
    },
  };
}
