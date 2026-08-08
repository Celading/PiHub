import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * P2-01b: codex read-only session records.
 *
 * Codex persists every thread as `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl`
 * plus a `history.jsonl` index. This module parses those records WITHOUT
 * spawning codex and without touching `~/.codex/auth.json` — it is the
 * read-only integration surface for the flight-recorder direction.
 *
 * Known event types in a rollout (probe 2026-08-09, codex-cli 0.146/0.147):
 *  - session_meta: session_id, cwd, forked_from_id, model_provider, source
 *  - event_msg: user/assistant text messages
 *  - response_item: agent_reasoning / custom_tool_call / custom_tool_call_output /
 *    input_text / summary_text / token_count (usage)
 */

const CODEX_HOME = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 200;

/** Resolves the sessions/history paths at call time (env-testable). */
function sessionsDir(): string {
  return path.join(CODEX_HOME, 'sessions');
}

function historyFile(): string {
  // Resolved at call time so tests can override CODEX_HOME.
  const home = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  return path.join(home, 'history.jsonl');
}

export interface CodexSessionMeta {
  sessionId: string;
  fileName: string;
  cwd: string;
  forkedFromId?: string;
  modelProvider?: string;
  source?: string;
  cliVersion?: string;
  startedAt: string;
  lastActivityAt: string;
  messageCount: number;
  toolCalls: number;
  tokens: number;
}

export interface CodexSessionDetail extends CodexSessionMeta {
  entries: CodexEntry[];
}

export interface CodexEntry {
  timestamp: string;
  type: string;
  /** Text for event_msg / input_text / agent_reasoning items. */
  text?: string;
  toolName?: string;
  isError?: boolean;
  usage?: { input: number; output: number; reasoning: number; total: number };
  raw: unknown;
}

interface RawRolloutLine {
  timestamp?: string;
  type?: string;
  payload?: {
    session_id?: string;
    cwd?: string;
    forked_from_id?: string;
    model_provider?: string;
    source?: string;
    cli_version?: string;
    id?: string;
    timestamp?: string;
  };
  [key: string]: unknown;
}

function parseJsonLine(line: string): RawRolloutLine | null {
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

function textOf(item: unknown): string | undefined {
  if (typeof item !== 'object' || item === null) {
    return undefined;
  }
  const record = item as Record<string, unknown>;
  if (typeof record['text'] === 'string') {
    return record['text'];
  }
  const content = record['content'];
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === 'object' && block !== null) {
        const b = block as Record<string, unknown>;
        if (typeof b['text'] === 'string') {
          parts.push(b['text']);
        }
      }
    }
    if (parts.length > 0) {
      return parts.join('\n');
    }
  }
  return undefined;
}

function toolNameOf(item: unknown): string | undefined {
  if (typeof item !== 'object' || item === null) {
    return undefined;
  }
  const record = item as Record<string, unknown>;
  const name = record['name'];
  if (typeof name === 'string') {
    return name;
  }
  const call = record['custom_tool_call'];
  if (typeof call === 'object' && call !== null && typeof (call as Record<string, unknown>)['name'] === 'string') {
    return (call as Record<string, unknown>)['name'] as string;
  }
  return undefined;
}

function usageOf(line: RawRolloutLine): { input: number; output: number; reasoning: number; total: number } | undefined {
  const payload = line['payload'];
  if (payload === undefined) {
    return undefined;
  }
  const p = payload as unknown as Record<string, unknown>;
  const usage = p['usage'] ?? p['token_count'];
  if (typeof usage !== 'object' || usage === null) {
    return undefined;
  }
  const u = usage as Record<string, unknown>;
  const num = (key: string): number => (typeof u[key] === 'number' ? u[key] : 0);
  const input = num('input_tokens') + num('input');
  const output = num('output_tokens') + num('output');
  const reasoning = num('reasoning_tokens') + num('reasoning');
  return { input, output, reasoning, total: input + output + reasoning };
}

async function collectRolloutFiles(dir: string, out: string[], depth: number): Promise<void> {
  if (depth > 4 || out.length >= MAX_FILES) {
    return;
  }
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith('.')) {
      continue;
    }
    const full = path.join(dir, entry);
    let info;
    try {
      info = await stat(full);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      await collectRolloutFiles(full, out, depth + 1);
    } else if (entry.startsWith('rollout-') && entry.endsWith('.jsonl') && info.size <= MAX_FILE_BYTES) {
      out.push(full);
    }
  }
}

/** Lists codex sessions (metadata only), newest activity first. */
export async function listCodexSessions(): Promise<CodexSessionMeta[]> {
  const files: string[] = [];
  await collectRolloutFiles(sessionsDir(), files, 0);
  const sessions: CodexSessionMeta[] = [];
  for (const file of files) {
    const detail = await parseRolloutFile(file);
    if (detail !== null) {
      sessions.push(detail);
    }
  }
  sessions.sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1));
  return sessions.slice(0, MAX_FILES);
}

/** Parses one rollout file into a lightweight session record. */
export async function parseRolloutFile(file: string): Promise<CodexSessionDetail | null> {
  let content: string;
  try {
    content = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  const lines = content.split('\n');
  let meta: {
    sessionId: string;
    cwd: string;
    forkedFromId?: string;
    modelProvider?: string;
    source?: string;
    cliVersion?: string;
    startedAt: string;
  } | null = null;
  const entries: CodexEntry[] = [];
  let messageCount = 0;
  let toolCalls = 0;
  let tokens = 0;

  for (const line of lines) {
    const parsed = parseJsonLine(line);
    if (parsed === null) {
      continue;
    }
    const type = parsed.type ?? '';
    const timestamp = parsed.timestamp ?? '';
    if (type === 'session_meta') {
      const payload = parsed.payload;
      if (payload !== undefined && typeof payload.session_id === 'string') {
        meta = {
          sessionId: payload.session_id,
          cwd: payload.cwd ?? '',
          ...(typeof payload.forked_from_id === 'string' ? { forkedFromId: payload.forked_from_id } : {}),
          ...(typeof payload.model_provider === 'string' ? { modelProvider: payload.model_provider } : {}),
          ...(typeof payload.source === 'string' ? { source: payload.source } : {}),
          ...(typeof payload.cli_version === 'string' ? { cliVersion: payload.cli_version } : {}),
          startedAt:
            typeof payload.timestamp === 'string' ? payload.timestamp : timestamp,
        };
      }
      continue;
    }
    if (type === 'event_msg') {
      const text = textOf(parsed.payload ?? parsed);
      entries.push({ timestamp, type, ...(text !== undefined ? { text } : {}), raw: parsed });
      messageCount += 1;
      continue;
    }
    if (type === 'response_item') {
      const item = parsed.payload ?? parsed;
      // item is always an object (RawRolloutLine or its payload) — read the
      // response_item's inner type directly.
      const itemType = (item as RawRolloutLine)['type'];
      const text = textOf(item);
      const toolName = toolNameOf(item);
      const usage = usageOf(parsed);
      if (usage !== undefined) {
        tokens += usage.total;
      }
      if (toolName !== undefined) {
        toolCalls += 1;
      }
      entries.push({
        timestamp,
        type: itemType ?? 'response_item',
        ...(text !== undefined ? { text } : {}),
        ...(toolName !== undefined ? { toolName } : {}),
        ...(usage !== undefined ? { usage } : {}),
        raw: parsed,
      });
      if (itemType === 'input_text' || itemType === 'summary_text' || itemType === 'message') {
        messageCount += 1;
      }
      continue;
    }
    // Unknown frames are kept so nothing is lost.
    entries.push({ timestamp, type, raw: parsed });
  }

  if (meta === null) {
    return null;
  }
  const last = entries.length > 0 ? entries[entries.length - 1]?.timestamp ?? meta.startedAt : meta.startedAt;
  return {
    ...meta,
    fileName: file,
    startedAt: meta.startedAt,
    lastActivityAt: last,
    messageCount,
    toolCalls,
    tokens,
    entries,
  };
}

/** Reads the history.jsonl index (session_id / ts / text) for quick listing. */
export async function readCodexHistory(): Promise<
  Array<{ sessionId: string; ts: number; text: string }>
> {
  let content: string;
  try {
    content = await readFile(historyFile(), 'utf8');
  } catch {
    return [];
  }
  const out: Array<{ sessionId: string; ts: number; text: string }> = [];
  for (const line of content.split('\n')) {
    const parsed = parseJsonLine(line);
    if (parsed === null) {
      continue;
    }
    const sessionId = parsed.session_id;
    const ts = parsed.ts;
    const text = parsed.text;
    if (typeof sessionId === 'string' && typeof ts === 'number' && typeof text === 'string') {
      out.push({ sessionId, ts, text });
    }
  }
  return out;
}
