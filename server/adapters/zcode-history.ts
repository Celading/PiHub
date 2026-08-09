import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * ADAPTER2 B: zcode read-only session records (flight-recorder surface).
 *
 * ZCode (the hosting agent) persists per-session model I/O as
 * `~/.zcode/cli/rollout/model-io-<session>.jsonl`. Each line:
 *   { completedAt, durationMs, requestId, model{modelId,providerId},
 *     request, response{finishReason, modelId, text, toolCalls, usage},
 *     sessionId, startedAt, turnId, type }
 *
 * ZCode has NO standalone CLI (it is the host) — this module is strictly a
 * record consumer. usage → tokens, durationMs → time, sessionId → grouping.
 * Sensitive fields (metadata.user_id) are REDACTED upstream and never
 * rendered here.
 */

const ZCODE_HOME = process.env.ZCODE_HOME ?? path.join(os.homedir(), '.zcode');
const ROLLOUT_DIR = path.join(ZCODE_HOME, 'cli', 'rollout');
const MAX_FILE_BYTES = 32 * 1024 * 1024;

export interface ZcodeUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ZcodeTurn {
  requestId: string;
  turnId: string;
  modelId: string;
  providerId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  finishReason: string;
  text: string;
  usage: ZcodeUsage;
}

export interface ZcodeSessionMeta {
  sessionId: string;
  fileName: string;
  startedAt: string;
  completedAt: string;
  turns: number;
  totalTokens: number;
  modelId: string;
  providerId: string;
}

export interface ZcodeSessionDetail extends ZcodeSessionMeta {
  turnList: ZcodeTurn[];
}

interface RawRolloutLine {
  completedAt?: string;
  durationMs?: number;
  requestId?: string;
  model?: { modelId?: string; providerId?: string };
  response?: {
    finishReason?: string;
    modelId?: string;
    text?: string;
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  };
  sessionId?: string;
  startedAt?: string;
  turnId?: string;
  type?: string;
  [key: string]: unknown;
}

function parseLine(line: string): RawRolloutLine | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as RawRolloutLine) : null;
  } catch {
    return null;
  }
}

function turnOf(line: RawRolloutLine): ZcodeTurn | null {
  const requestId = line.requestId;
  const startedAt = line.startedAt;
  if (typeof requestId !== 'string' || typeof startedAt !== 'string') {
    return null;
  }
  const usage = line.response?.usage;
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  return {
    requestId,
    turnId: line.turnId ?? '',
    modelId: line.response?.modelId ?? line.model?.modelId ?? '',
    providerId: line.model?.providerId ?? '',
    startedAt,
    completedAt: line.completedAt ?? startedAt,
    durationMs: line.durationMs ?? 0,
    finishReason: line.response?.finishReason ?? '',
    text: line.response?.text ?? '',
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: usage?.totalTokens ?? inputTokens + outputTokens,
    },
  };
}

async function collectRolloutFiles(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith('model-io-') && entry.endsWith('.jsonl')) {
      try {
        const info = await stat(path.join(dir, entry));
        if (info.size <= MAX_FILE_BYTES) {
          out.push(path.join(dir, entry));
        }
      } catch {
        // skip unreadable
      }
    }
  }
  return out;
}

function sessionMetaOf(fileName: string, turns: ZcodeTurn[]): ZcodeSessionMeta | null {
  if (turns.length === 0) {
    return null;
  }
  const sessionId = path.basename(fileName).replace(/^model-io-/, '').replace(/\.jsonl$/, '');
  const first = turns[0];
  const last = turns[turns.length - 1];
  if (first === undefined) {
    return null;
  }
  return {
    sessionId: sessionId === 'no-session' ? '(no session)' : sessionId,
    fileName,
    startedAt: first.startedAt,
    completedAt: last?.completedAt ?? first.completedAt,
    turns: turns.length,
    totalTokens: turns.reduce((sum, turn) => sum + turn.usage.totalTokens, 0),
    modelId: last?.modelId ?? first.modelId,
    providerId: last?.providerId ?? first.providerId,
  };
}

/** Lists zcode sessions (rollout files), newest first. */
export async function listZcodeSessions(): Promise<ZcodeSessionMeta[]> {
  const files = await collectRolloutFiles(ROLLOUT_DIR);
  const sessions: ZcodeSessionMeta[] = [];
  for (const file of files) {
    const detail = await parseZcodeRollout(file);
    if (detail !== null) {
      sessions.push(detail);
    }
  }
  sessions.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  return sessions;
}

/** Parses one rollout file into turn timeline + session summary. */
export async function parseZcodeRollout(file: string): Promise<ZcodeSessionDetail | null> {
  let content: string;
  try {
    content = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  const turns: ZcodeTurn[] = [];
  for (const line of content.split('\n')) {
    const parsed = parseLine(line);
    if (parsed === null) {
      continue;
    }
    const turn = turnOf(parsed);
    if (turn !== null) {
      turns.push(turn);
    }
  }
  const meta = sessionMetaOf(file, turns);
  if (meta === null) {
    return null;
  }
  return { ...meta, turnList: turns };
}
