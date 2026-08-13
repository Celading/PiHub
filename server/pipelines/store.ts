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
  readdirSync,
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
/** v1b: per-run durable journal (append-only full-run snapshots). */
const RUN_JOURNALS_DIR = 'run-journals';
/** v1b: terminal typed receipts (atomic write). */
const RECEIPTS_DIR = 'pipeline-receipts';
/** v1b: ids used as log/receipt file names must be path-safe (audit P1-1). */
const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

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
  /** v1b: appends one full-run snapshot to the run's durable journal. */
  appendRunJournal(runId: string, snapshot: unknown): void;
  /** v1b: atomically writes the terminal typed receipt for a run. */
  writeRunReceipt(runId: string, receipt: unknown): void;
  /** v1b: reads a run's receipt; null when absent or corrupt (bytes kept). */
  readRunReceipt(runId: string): unknown;
  /** v1b: all receipts whose run belongs to a pipeline (newest first). */
  listRunReceipts(pipelineId: string): unknown[];
  /** v1b: runs whose journal's last snapshot is still `running` (recover). */
  listRecoverableRuns(): Array<{ runId: string; snapshot: unknown }>;
}

export function createPipelineStore(baseDir: string = path.join(homedir(), '.pihub')): PipelineStore {
  const defsPath = path.join(baseDir, PIPELINES_FILE);
  const runsDir = path.join(baseDir, RUNS_DIR);
  const journalsDir = path.join(baseDir, RUN_JOURNALS_DIR);
  const receiptsDir = path.join(baseDir, RECEIPTS_DIR);

  const ensureDirs = (): void => {
    mkdirSync(baseDir, { recursive: true });
    mkdirSync(runsDir, { recursive: true });
    mkdirSync(journalsDir, { recursive: true });
    mkdirSync(receiptsDir, { recursive: true });
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

  /** Validates an id before it is used as a file name (v1b fail-closed:
   *  path traversal via `../../escape` must throw, never write elsewhere). */
  const assertSafeLogId = (id: string): void => {
    if (id.length === 0 || id.length > 128 || !SAFE_ID_PATTERN.test(id) || path.basename(id) !== id) {
      throw new Error(`unsafe id for log path: ${id}`);
    }
  };

  const runLogPath = (pipelineId: string): string => {
    assertSafeLogId(pipelineId);
    return path.join(runsDir, `${pipelineId}.jsonl`);
  };

  const journalPath = (runId: string): string => {
    assertSafeLogId(runId);
    return path.join(journalsDir, `${runId}.jsonl`);
  };

  const receiptPath = (runId: string): string => {
    assertSafeLogId(runId);
    return path.join(receiptsDir, `${runId}.json`);
  };

  const readReceipt = (runId: string): unknown => {
    const target = receiptPath(runId);
    if (!existsSync(target)) {
      return null;
    }
    try {
      return JSON.parse(readFileSync(target, 'utf8')) as unknown;
    } catch {
      // Corrupt receipt: keep the bytes for recovery; report as absent.
      return null;
    }
  };

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
      // Keep the log bounded: atomically rewrite with the last MAX_RUN_LINES
      // lines (v1b: off-by-one fixed — the trailing newline's empty split
      // element used to eat one slot; >MAX now keeps exactly MAX; tmp+rename
      // so a crash never leaves a half-written log).
      if (existsSync(logPath)) {
        const lines = readFileSync(logPath, 'utf8').split('\n');
        const dataLines = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
        if (dataLines.length > MAX_RUN_LINES) {
          const tmpPath = `${logPath}.tmp`;
          writeFileSync(tmpPath, `${dataLines.slice(-MAX_RUN_LINES).join('\n')}\n`, 'utf8');
          renameSync(tmpPath, logPath);
        }
      }
    },

    readRunLog(pipelineId: string): unknown[] {
      if (pipelineId.length === 0 || !SAFE_ID_PATTERN.test(pipelineId) || path.basename(pipelineId) !== pipelineId) {
        // Fail-closed on reads too: an unsafe id must not touch the filesystem.
        return [];
      }
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

    appendRunJournal(runId: string, snapshot: unknown): void {
      ensureDirs();
      // Journals are the audit truth for a run: never truncated.
      appendFileSync(journalPath(runId), `${JSON.stringify(snapshot)}\n`, 'utf8');
    },

    writeRunReceipt(runId: string, receipt: unknown): void {
      ensureDirs();
      const target = receiptPath(runId);
      const tmpPath = `${target}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(receipt, null, 2), 'utf8');
      renameSync(tmpPath, target);
    },

    readRunReceipt(runId: string): unknown {
      return readReceipt(runId);
    },

    listRunReceipts(pipelineId: string): unknown[] {
      if (pipelineId.length === 0 || !SAFE_ID_PATTERN.test(pipelineId) || path.basename(pipelineId) !== pipelineId) {
        return [];
      }
      if (!existsSync(receiptsDir)) {
        return [];
      }
      const receipts: unknown[] = [];
      for (const entry of readdirSync(receiptsDir)) {
        if (!entry.endsWith('.json')) {
          continue;
        }
        const receipt = readReceipt(path.basename(entry, '.json'));
        if (receipt !== null && typeof receipt === 'object') {
          const record = receipt as { pipelineId?: unknown };
          if (record.pipelineId === pipelineId) {
            receipts.push(receipt);
          }
        }
      }
      // Newest first by finishedAt when present.
      return receipts.sort((a, b) => {
        const fa = (a as { finishedAt?: unknown }).finishedAt;
        const fb = (b as { finishedAt?: unknown }).finishedAt;
        return Number(fb ?? 0) - Number(fa ?? 0);
      });
    },

    listRecoverableRuns(): Array<{ runId: string; snapshot: unknown }> {
      if (!existsSync(journalsDir)) {
        return [];
      }
      const recoverable: Array<{ runId: string; snapshot: unknown }> = [];
      for (const entry of readdirSync(journalsDir)) {
        if (!entry.endsWith('.jsonl')) {
          continue;
        }
        const runId = path.basename(entry, '.jsonl');
        try {
          const lines = readFileSync(path.join(journalsDir, entry), 'utf8')
            .split('\n')
            .filter((l) => l.length > 0);
          const lastLine = lines[lines.length - 1];
          if (lastLine === undefined) {
            continue;
          }
          const snapshot = JSON.parse(lastLine) as { status?: unknown };
          if (snapshot.status === 'running') {
            recoverable.push({ runId, snapshot: JSON.parse(lastLine) });
          }
        } catch {
          // malformed journal; skip (bytes kept for recovery)
        }
      }
      return recoverable;
    },
  };
}
