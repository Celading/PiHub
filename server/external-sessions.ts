/**
 * External session watcher — the shared-session stream between PiHub and
 * agent CLIs running in a terminal (pi/codex/dsh). Every agent persists its
 * conversation to a session file; this watcher tails those files and emits
 * the new events, so a terminal-side run shows up in the panel in near-real
 * time — and the panel's own runs (which write the same files) close the
 * loop the other way (terminal resume/attach via the CLI's own tooling).
 *
 * Honest boundary: only what hits the session file is visible; TUI in-memory
 * state that never lands on disk is not.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as zlib from 'node:zlib';

export interface ExternalEvent {
  agent: 'pi' | 'codex' | 'dsh';
  sessionId: string;
  workspace: string;
  role: 'user' | 'assistant' | 'tool' | 'meta';
  text: string;
  timestamp: number;
}

export interface ExternalSessionEntry {
  agent: 'pi' | 'codex' | 'dsh';
  sessionId: string;
  workspace: string;
  lastActivity: number;
  lastText: string;
  file: string;
}

export interface ExternalSessionsOptions {
  piDir?: string;
  codexDir?: string;
  dshDir?: string;
  /** Poll interval for file tailing (fs.watch is unreliable in sandboxes). */
  pollMs?: number;
  /** Max bytes read from one file per poll (pathological-file guard). */
  maxTailBytes?: number;
  onEvent?: (event: ExternalEvent) => void;
}

const MAX_LINE_BYTES = 64 * 1024;

interface FileState {
  size: number;
  linesSeen: number;
}

/** Best-effort text extraction from a parsed JSON record. */
function extractText(record: Record<string, unknown>): string {
  const isTimestamp = (value: string): boolean =>
    /^\d{4}-\d{2}-\d{2}T/.test(value) || /^\d{4}-\d{2}-\d{2} /.test(value) || /^\d{13}$/.test(value);

  // Structured preference: message/content/text fields win over noise.
  const structured = (
    value: unknown,
  ): string | null => {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed.length > 0 && !isTimestamp(trimmed) ? trimmed : null;
    }
    if (Array.isArray(value)) {
      const parts: string[] = [];
      for (const item of value) {
        if (item !== null && typeof item === 'object') {
          const block = item as Record<string, unknown>;
          if (typeof block['text'] === 'string') {
            parts.push(block['text']);
          }
        } else if (typeof item === 'string') {
          parts.push(item);
        }
      }
      const joined = parts.join('\n').trim();
      return joined.length > 0 ? joined : null;
    }
    return null;
  };

  const payload = record['payload'];
  const payloadMessage =
    payload !== null && typeof payload === 'object'
      ? (payload as Record<string, unknown>)['message']
      : undefined;
  const message = record['message'];
  const unwrap = (value: unknown): unknown => {
    if (value !== null && typeof value === 'object') {
      const asRecord = value as Record<string, unknown>;
      if ('content' in asRecord) {
        return asRecord['content'];
      }
      if ('text' in asRecord && typeof asRecord['text'] === 'string') {
        return asRecord['text'];
      }
    }
    return value;
  };
  for (const candidate of [record['content'], record['text'], message, payloadMessage, record['answer']]) {
    const text = structured(unwrap(candidate));
    if (text !== null && text.length > 0) {
      return text;
    }
  }

  // Fallback: longest non-timestamp candidate (assistant text > ids > noise).
  let best = '';
  const walk = (value: unknown, depth: number): void => {
    if (depth > 6 || typeof value === 'boolean' || value === null || value === undefined) {
      return;
    }
    if (typeof value === 'string') {
      if (value.length > best.length && !isTimestamp(value)) {
        best = value;
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item, depth + 1);
      }
      return;
    }
    if (typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (
          key === 'usage' ||
          key === 'cost' ||
          key === 'model' ||
          key === 'provider' ||
          key === 'id' ||
          key === 'type' ||
          key === 'role' ||
          key === 'timestamp' ||
          key === 'cwd' ||
          key === 'originator' ||
          key === 'source' ||
          key === 'version'
        ) {
          continue;
        }
        walk(child, depth + 1);
      }
    }
  };
  walk(record, 0);
  return best.trim();
}

function roleOf(record: Record<string, unknown>): ExternalEvent['role'] {
  const type = typeof record['type'] === 'string' ? record['type'] : '';
  const role = typeof record['role'] === 'string' ? record['role'] : '';
  const payload = record['payload'];
  const payloadRole =
    payload !== null && typeof payload === 'object'
      ? (payload as Record<string, unknown>)['role']
      : undefined;
  const message = record['message'];
  const messageRole =
    message !== null && typeof message === 'object'
      ? (message as Record<string, unknown>)['role']
      : undefined;
  const roleText =
    typeof payloadRole === 'string' && payloadRole.length > 0
      ? payloadRole
      : typeof messageRole === 'string' && messageRole.length > 0
        ? messageRole
        : role;
  const combined = `${roleText} ${type}`;
  if (/assistant|agent_message|response/i.test(combined)) return 'assistant';
  if (/tool|function|command/i.test(combined)) return 'tool';
  if (/user|prompt|message/i.test(combined)) return 'user';
  if (/session_meta|title|meta/i.test(combined)) return 'meta';
  return 'meta';
}

function sessionIdOf(agent: 'pi' | 'codex' | 'dsh', file: string): string {
  if (agent === 'dsh') {
    const match = /session-([0-9a-f-]+)/i.exec(file);
    if (match !== null) return match[1] ?? file;
    return file;
  }
  const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(file);
  if (match !== null) return match[1] ?? file;
  return path.basename(file);
}

/** Workspace hint: the directory holding the session file. */
function workspaceOf(file: string): string {
  const dirName = path.basename(path.dirname(file));
  const cleaned = dirName.replace(/^--/, '').replace(/--$/, '');
  return cleaned.length > 0 && cleaned !== dirName ? cleaned : dirName;
}

/** Parse JSONL lines; returns role/text pairs. */
function parseLines(agent: 'pi' | 'codex' | 'dsh', lines: string[]): ExternalEvent[] {
  const events: ExternalEvent[] = [];
  for (const line of lines) {
    if (line.length === 0 || line.length > MAX_LINE_BYTES) {
      continue;
    }
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record === null || typeof record !== 'object') {
      continue;
    }
    const asRecord = record as Record<string, unknown>;
    const role = roleOf(asRecord);
    const text = extractText(asRecord);
    if (text.length === 0 && role === 'meta') {
      continue;
    }
    const timestampRaw =
      typeof asRecord['timestamp'] === 'string'
        ? asRecord['timestamp']
        : typeof (asRecord['payload'] as Record<string, unknown> | undefined)?.['timestamp'] === 'string'
          ? String((asRecord['payload'] as Record<string, unknown>)['timestamp'])
          : null;
    const timestamp =
      timestampRaw !== null ? Date.parse(timestampRaw) : Number.isFinite(Date.now()) ? Date.now() : Date.now();
    events.push({
      agent,
      sessionId: '',
      workspace: '',
      role,
      text,
      timestamp: Number.isNaN(timestamp) ? Date.now() : timestamp,
    });
  }
  return events;
}

/** Read the tail of a file after `offset`, returning new bytes + new offset. */
function tailFile(file: string, offset: number, maxBytes: number): { chunk: Buffer; offset: number } {
  const stat = fs.statSync(file);
  if (stat.size <= offset) {
    return { chunk: Buffer.alloc(0), offset: stat.size };
  }
  const start = Math.max(offset, stat.size - maxBytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    return { chunk: buffer, offset: stat.size };
  } finally {
    fs.closeSync(fd);
  }
}

function decompressZstd(buffer: Buffer): Buffer {
  if (typeof zlib.zstdDecompressSync !== 'function') {
    return Buffer.alloc(0);
  }
  return zlib.zstdDecompressSync(buffer);
}

export class ExternalSessionWatcher {
  private readonly piDir: string | undefined;
  private readonly codexDir: string | undefined;
  private readonly dshDir: string | undefined;
  private readonly pollMs: number;
  private readonly maxTailBytes: number;
  private readonly onEvent: ((event: ExternalEvent) => void) | undefined;
  private readonly fileState = new Map<string, FileState>();
  private readonly dshLineState = new Map<string, number>();
  private readonly sessions = new Map<string, ExternalSessionEntry>();
  private timer: NodeJS.Timeout | undefined;

  constructor(options: ExternalSessionsOptions = {}) {
    this.piDir = options.piDir ?? path.join(os.homedir(), '.pi', 'agent', 'sessions');
    this.codexDir = options.codexDir ?? path.join(os.homedir(), '.codex', 'sessions');
    this.dshDir =
      options.dshDir ??
      (process.env.DSH_HOME !== undefined && process.env.DSH_HOME.length > 0
        ? path.join(process.env.DSH_HOME, 'sessions')
        : path.join(os.homedir(), '.dsh', 'sessions'));
    this.pollMs = options.pollMs ?? 2000;
    this.maxTailBytes = options.maxTailBytes ?? 2 * 1024 * 1024;
    this.onEvent = options.onEvent;
  }

  start(): void {
    if (this.timer !== undefined) {
      return;
    }
    // Initial scan without emitting (existing history is not "activity").
    this.scanAll(false);
    this.timer = setInterval(() => {
      this.scanAll(true);
    }, this.pollMs);
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Active external sessions, most recently active first. */
  list(limit = 50): ExternalSessionEntry[] {
    return [...this.sessions.values()]
      .sort((a, b) => b.lastActivity - a.lastActivity)
      .slice(0, limit);
  }

  private scanAll(emit: boolean): void {
    if (this.piDir !== undefined) {
      this.scanJsonlDir('pi', this.piDir, emit);
    }
    if (this.codexDir !== undefined) {
      this.scanJsonlDir('codex', this.codexDir, emit);
    }
    if (this.dshDir !== undefined) {
      this.scanDshDir(emit);
    }
  }

  private scanJsonlDir(agent: 'pi' | 'codex', root: string, emit: boolean): void {
    let files: string[] = [];
    try {
      files = collectFiles(root, (name) => name.endsWith('.jsonl'));
    } catch {
      return;
    }
    for (const file of files) {
      let state = this.fileState.get(file);
      if (state === undefined) {
        try {
          const size = fs.statSync(file).size;
          state = { size, linesSeen: 0 };
          this.fileState.set(file, state);
        } catch {
          continue;
        }
      }
      let chunk: Buffer;
      try {
        chunk = tailFile(file, state.size, this.maxTailBytes).chunk;
      } catch {
        continue;
      }
      if (chunk.length === 0) {
        continue;
      }
      const text = chunk.toString('utf8');
      const lines = text.split('\n');
      const newLines = lines.slice(0, lines.length - (text.endsWith('\n') ? 1 : 0));
      state.linesSeen += newLines.length;
      state.size += chunk.length;
      if (!emit) {
        continue;
      }
      const sessionId = sessionIdOf(agent, file);
      const workspace = workspaceOf(file);
      for (const event of parseLines(agent, newLines)) {
        this.record(agent, sessionId, workspace, event);
      }
    }
  }

  private scanDshDir(emit: boolean): void {
    let dirs: string[] = [];
    try {
      dirs = collectDirs(this.dshDir ?? '');
    } catch {
      return;
    }
    for (const dir of dirs) {
      const sessionFile = path.join(dir, 'session.jsonl.zstd');
      let stat: fs.Stats | null = null;
      try {
        stat = fs.statSync(sessionFile);
      } catch {
        continue;
      }
      const prevLines = this.dshLineState.get(sessionFile) ?? 0;
      if (stat.size === 0 || stat.size > this.maxTailBytes) {
        continue;
      }
      let content: Buffer;
      try {
        const raw = fs.readFileSync(sessionFile);
        content = decompressZstd(raw);
      } catch {
        continue;
      }
      if (content.length === 0) {
        continue;
      }
      const lines = content.toString('utf8').split('\n');
      const totalLines = lines.length;
      if (!emit || totalLines <= prevLines) {
        this.dshLineState.set(sessionFile, totalLines);
        continue;
      }
      const sessionId = sessionIdOf('dsh', dir);
      const workspace = workspaceOf(dir);
      const newLines = lines.slice(prevLines);
      this.dshLineState.set(sessionFile, totalLines);
      for (const event of parseLines('dsh', newLines)) {
        this.record('dsh', sessionId, workspace, event);
      }
    }
  }

  private record(agent: 'pi' | 'codex' | 'dsh', sessionId: string, workspace: string, event: ExternalEvent): void {
    const full: ExternalEvent = { ...event, agent, sessionId, workspace };
    const key = `${agent}:${sessionId}`;
    const existing = this.sessions.get(key);
    const entry: ExternalSessionEntry = {
      agent,
      sessionId,
      workspace,
      lastActivity: full.timestamp,
      lastText: full.text.slice(0, 200),
      file: existing?.file ?? full.workspace,
    };
    this.sessions.set(key, entry);
    if (this.onEvent !== undefined) {
      this.onEvent(full);
    }
  }
}

/** Collect *.jsonl files under root (recursive, bounded). */
function collectFiles(root: string, match: (name: string) => boolean, limit = 2000): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (out.length >= limit) {
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
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && match(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

/** Collect session directories (containing session.jsonl.zstd) under root. */
function collectDirs(root: string, limit = 500): string[] {
  if (root.length === 0 || !fs.existsSync(root)) {
    return [];
  }
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (out.length >= limit) {
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
      if (fs.existsSync(path.join(full, 'session.jsonl.zstd'))) {
        out.push(full);
      } else {
        walk(full);
      }
    }
  };
  walk(root);
  return out;
}
