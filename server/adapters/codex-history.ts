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

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 200;

/** Resolves the sessions/history paths at call time (env-testable). */
function sessionsDir(): string {
  const home = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  return path.join(home, 'sessions');
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

async function collectRolloutFiles(dir: string, out: string[], depth: number, cap: number = MAX_FILES): Promise<void> {
  if (depth > 4 || out.length >= cap) {
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

/** Collects EVERY rollout file under the store (bounded depth only) — the
 *  thread aggregation dedupes before the listing cap applies, so older
 *  threads of a resumed conversation are not hidden by the cap. */
async function collectRolloutFilesAll(dir: string): Promise<string[]> {
  const out: string[] = [];
  await collectRolloutFiles(dir, out, 0, Number.POSITIVE_INFINITY);
  return out;
}

/**
 * Lists codex sessions deduped by their AUTHORITATIVE session id (audit P2
 * fix, second pass): file names can embed a DIFFERENT id than the file's
 * session_meta (copied/forked rollouts — observed in the wild), so name-
 * based grouping still leaked duplicates. Every collected file is parsed
 * (mtime-keyed cache makes repeats free; files > 8MB are never collected)
 * and grouped by session_id, keeping the newest mtime file per thread.
 */
async function listSessionsDeduped(): Promise<CodexSessionMeta[]> {
  const files = await collectRolloutFilesAll(sessionsDir());
  const bySession = new Map<string, { meta: CodexSessionMeta; mtimeMs: number }>();
  for (const file of files) {
    let info;
    try {
      info = await stat(file);
    } catch {
      continue;
    }
    const detail = await parseRolloutFile(file);
    if (detail === null) {
      continue;
    }
    const current = bySession.get(detail.sessionId);
    if (current === undefined || info.mtimeMs > current.mtimeMs) {
      bySession.set(detail.sessionId, { meta: projectMeta(detail), mtimeMs: info.mtimeMs });
    }
  }
  return [...bySession.values()]
    .map((entry) => entry.meta)
    .sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1))
    .slice(0, MAX_FILES);
}

/** Lists codex sessions (metadata only), newest activity first. */
export async function listCodexSessions(): Promise<CodexSessionMeta[]> {
  return listSessionsDeduped();
}

/** mtime-keyed parse cache: the sidebar and session views call the codex
 *  list repeatedly; re-parsing every rollout on each call made codex loading
 *  feel slow (1.5s+). Only files whose mtime changed are re-read. */
const rolloutCache = new Map<string, { mtimeMs: number; detail: CodexSessionDetail | null }>();

/** Locates a rollout file by thread id WITHOUT parsing the whole store —
 *  rollout file names embed the thread id (rollout-<ts>-<threadId>.jsonl).
 *  The targeted lookup scans the FULL tree (no MAX_FILES cap — the listing
 *  cap previously hid files beyond the 200th, making old threads unfindable)
 *  and stops at the first name match; file names are immutable per thread,
 *  so positive lookups are cached and repeats are instant. */
const rolloutFileCache = new Map<string, string>();

export async function findRolloutFile(threadId: string): Promise<string | null> {
  const hit = rolloutFileCache.get(threadId);
  if (hit !== undefined) {
    return hit;
  }
  const match = await findRolloutByName(sessionsDir(), threadId, 0);
  if (match !== null) {
    rolloutFileCache.set(threadId, match);
    return match;
  }
  return null;
}

/** Depth-first name search without the listing cap (bounded by depth 4).
 *  A resumed thread has MULTIPLE rollout files sharing the thread id; the
 *  LATEST one (by mtime) is the live conversation — picking the first match
 *  could land on an old multi-hundred-MB file. */
async function findRolloutByName(dir: string, threadId: string, depth: number): Promise<string | null> {
  if (depth > 4) {
    return null;
  }
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  let best: { file: string; mtimeMs: number } | null = null;
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
      const nested = await findRolloutByName(full, threadId, depth + 1);
      if (nested !== null) {
        const nestedInfo = await stat(nested).catch(() => null);
        if (nestedInfo !== null && (best === null || nestedInfo.mtimeMs > best.mtimeMs)) {
          best = { file: nested, mtimeMs: nestedInfo.mtimeMs };
        }
      }
    } else if (info.isFile() && entry.endsWith('.jsonl') && entry.includes(threadId)) {
      if (best === null || info.mtimeMs > best.mtimeMs) {
        best = { file: full, mtimeMs: info.mtimeMs };
      }
    }
  }
  return best?.file ?? null;
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
      // Legacy codex CLI versions write payload.id instead of session_id —
      // both identify the thread; without the fallback old rollouts parsed
      // as null and vanished from the listings.
      const sessionId = payload?.session_id ?? payload?.id;
      if (payload !== undefined && typeof sessionId === 'string') {
        meta = {
          sessionId,
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

/**
 * Background backfill: parses every rollout NOT yet in the parse cache and
 * stores the metas, so the next fast list returns full data everywhere.
 * This is the foundation for the upcoming prompt index — the parsed cache
 * becomes the shared index source.
 */
export async function listCodexSessionsFast(limit: number = FAST_PARSE_LIMIT): Promise<CodexSessionMeta[]> {
  // One deduped listing (authoritative session ids); the limit parameter is
  // kept for API compatibility — the mtime-keyed parse cache makes repeated
  // calls cheap, and the sidebar needs the deduped full view.
  void limit;
  return listSessionsDeduped();
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
