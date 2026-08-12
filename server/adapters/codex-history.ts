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
  /** Fast-list placeholder (old record not yet parsed / no session_meta). */
  placeholder?: boolean;
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

/** Meta projection: strips entries/raw so serialization stays small. */
function projectMeta(detail: CodexSessionDetail): CodexSessionMeta {
  return {
    sessionId: detail.sessionId,
    fileName: detail.fileName,
    cwd: detail.cwd,
    ...(detail.forkedFromId !== undefined ? { forkedFromId: detail.forkedFromId } : {}),
    ...(detail.modelProvider !== undefined ? { modelProvider: detail.modelProvider } : {}),
    ...(detail.source !== undefined ? { source: detail.source } : {}),
    ...(detail.cliVersion !== undefined ? { cliVersion: detail.cliVersion } : {}),
    startedAt: detail.startedAt,
    lastActivityAt: detail.lastActivityAt,
    messageCount: detail.messageCount,
    toolCalls: detail.toolCalls,
    tokens: detail.tokens,
  };
}

/** Lists codex sessions (metadata only), newest activity first. */
export async function listCodexSessions(): Promise<CodexSessionMeta[]> {
  const files: string[] = [];
  await collectRolloutFiles(sessionsDir(), files, 0);
  const sessions: CodexSessionMeta[] = [];
  for (const file of files) {
    const detail = await parseRolloutFile(file);
    if (detail !== null) {
      // Explicit meta projection: the parsed detail carries the full entries
      // (+ raw frames) — serializing those made /api/codex/sessions return
      // ~58MB and take 250ms+.
      sessions.push(projectMeta(detail));
    }
  }
  sessions.sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1));
  return sessions.slice(0, MAX_FILES);
}

/** mtime-keyed parse cache: the sidebar and session views call the codex
 *  list repeatedly; re-parsing every rollout on each call made codex loading
 *  feel slow (1.5s+). Only files whose mtime changed are re-read. */
const rolloutCache = new Map<string, { mtimeMs: number; detail: CodexSessionDetail | null }>();

/** Locates a rollout file by thread id WITHOUT parsing the whole store —
 *  rollout file names embed the thread id (rollout-<ts>-<threadId>.jsonl). */
export async function findRolloutFile(threadId: string): Promise<string | null> {
  const found: string[] = [];
  await collectRolloutFiles(sessionsDir(), found, 0);
  const match = found.find((file) => path.basename(file).includes(threadId));
  return match ?? null;
}

/** Parses one rollout file into a lightweight session record. */
export async function parseRolloutFile(file: string): Promise<CodexSessionDetail | null> {
  let info;
  try {
    info = await stat(file);
  } catch {
    return null;
  }
  const cached = rolloutCache.get(file);
  if (cached !== undefined && cached.mtimeMs === info.mtimeMs) {
    return cached.detail;
  }
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
    rolloutCache.set(file, { mtimeMs: info.mtimeMs, detail: null });
    return null;
  }
  const last = entries.length > 0 ? entries[entries.length - 1]?.timestamp ?? meta.startedAt : meta.startedAt;
  const detail: CodexSessionDetail = {
    ...meta,
    fileName: file,
    startedAt: meta.startedAt,
    lastActivityAt: last,
    messageCount,
    toolCalls,
    tokens,
    entries,
  };
  rolloutCache.set(file, { mtimeMs: info.mtimeMs, detail });
  return detail;
}

/** Number of newest rollouts parsed fully on the fast path. */
const FAST_PARSE_LIMIT = 20;

/** Extracts the thread id and timestamp embedded in a rollout file name. */
function fileNameMeta(file: string): { threadId: string; startedAt: string } {
  const base = path.basename(file); // rollout-2026-08-12T13-24-45-019ff46e-...jsonl
  const parts = base.split('-');
  // ts = parts[1..3] joined (date + time + nanos-ish), threadId = parts[4]
  const ts = parts.slice(1, 4).join('-');
  const threadId = parts.slice(4).join('-').replace(/\.jsonl$/, '');
  return {
    threadId,
    startedAt: Number.isNaN(Date.parse(ts)) ? '' : ts,
  };
}

/**
 * Fast list: full-parses only the NEWEST `limit` rollouts (mtime order) and
 * returns the rest as lightweight placeholders derived from the file name.
 * The heavy backfill (below) fills the placeholders in the background, so
 * the sidebar renders almost instantly and converges shortly after.
 */
export async function listCodexSessionsFast(limit: number = FAST_PARSE_LIMIT): Promise<CodexSessionMeta[]> {
  const files: string[] = [];
  await collectRolloutFiles(sessionsDir(), files, 0);
  const withMtime = new Map<string, number>();
  for (const file of files) {
    try {
      const info = await stat(file);
      withMtime.set(file, info.mtimeMs);
    } catch {
      // skip unreadable files
    }
  }
  const ordered = [...withMtime.entries()].sort((a, b) => (a[1] < b[1] ? 1 : -1));
  const newest = ordered.slice(0, limit).map(([file]) => file);
  const sessions: CodexSessionMeta[] = [];
  for (const file of newest) {
    const detail = await parseRolloutFile(file);
    if (detail !== null) {
      sessions.push(projectMeta(detail));
    }
  }
  for (const [file] of ordered.slice(limit)) {
    if (sessions.length >= MAX_FILES) {
      break;
    }
    // Prefer the parse cache (backfill fills it); only fall back to a
    // file-name placeholder for not-yet-parsed records.
    const cached = rolloutCache.get(file);
    if (cached !== undefined && cached.detail !== null) {
      sessions.push(projectMeta(cached.detail));
      continue;
    }
    const { threadId, startedAt } = fileNameMeta(file);
    sessions.push({
      sessionId: threadId,
      fileName: file,
      cwd: '',
      startedAt,
      lastActivityAt: startedAt,
      messageCount: 0,
      toolCalls: 0,
      tokens: 0,
      placeholder: true,
    });
  }
  sessions.sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1));
  return sessions.slice(0, MAX_FILES);
}

/**
 * Background backfill: parses every rollout NOT yet in the parse cache and
 * stores the metas, so the next fast list returns full data everywhere.
 * This is the foundation for the upcoming prompt index — the parsed cache
 * becomes the shared index source.
 */
export async function backfillCodexSessions(): Promise<void> {
  const files: string[] = [];
  await collectRolloutFiles(sessionsDir(), files, 0);
  for (const file of files) {
    await parseRolloutFile(file); // mtime cache makes repeats free
  }
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
