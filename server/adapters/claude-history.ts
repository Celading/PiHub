import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Claude Code read-only records (claude adapter, 2026-08-12): Claude Code
 * (the CLI; claude.app shares its engine) stores every conversation as a
 * JSONL transcript under ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl.
 * The panel only reads these records — it never writes ~/.claude, never
 * touches credentials, and never spawns claude.
 */

const MAX_FILES = 200;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const CLAUDE_HOME = process.env.CLAUDE_HOME ?? path.join(os.homedir(), '.claude');

export interface ClaudeSessionMeta {
  sessionId: string;
  fileName: string;
  cwd: string;
  startedAt: string;
  lastActivityAt: string;
  messageCount: number;
  toolCalls: number;
  placeholder?: boolean;
}

interface ClaudeLine {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
  toolUse?: { name?: string };
  [key: string]: unknown;
}

/** Reads the cwd slug from a project directory name. */
function slugToCwd(slug: string): string {
  return slug.replace(/^-/, '').replace(/-/g, '/').replace(/\/([A-Za-z]):\//, '$1:/');
}

async function collectTranscripts(out: string[]): Promise<void> {
  let projects: string[];
  try {
    projects = await readdir(path.join(CLAUDE_HOME, 'projects'));
  } catch {
    return;
  }
  for (const slug of projects) {
    if (slug.startsWith('.')) {
      continue;
    }
    const dir = path.join(CLAUDE_HOME, 'projects', slug);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl') || file.startsWith('.')) {
        continue;
      }
      const full = path.join(dir, file);
      try {
        const info = await stat(full);
        if (info.size <= MAX_FILE_BYTES) {
          out.push(full);
        }
      } catch {
        // unreadable — skip
      }
    }
  }
  if (out.length > MAX_FILES) {
    out.length = MAX_FILES;
  }
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block);
      } else if (typeof block === 'object' && block !== null) {
        const record = block as { text?: unknown; type?: unknown };
        if (typeof record.text === 'string') {
          parts.push(record.text);
        }
      }
    }
    return parts.join('\n');
  }
  return '';
}

/** Parses one transcript into a lightweight record. */
export async function parseClaudeTranscript(file: string): Promise<ClaudeSessionMeta | null> {
  let content: string;
  try {
    content = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  let startedAt = '';
  let lastActivityAt = '';
  let messageCount = 0;
  let toolCalls = 0;
  let cwd = '';
  for (const line of content.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    let parsed: ClaudeLine;
    try {
      parsed = JSON.parse(line) as ClaudeLine;
    } catch {
      continue;
    }
    const timestamp = parsed.timestamp ?? '';
    if (timestamp.length > 0 && (lastActivityAt === '' || timestamp > lastActivityAt)) {
      lastActivityAt = timestamp;
    }
    if (startedAt === '' && timestamp.length > 0) {
      startedAt = timestamp;
    }
    if (typeof parsed.cwd === 'string' && cwd === '') {
      cwd = parsed.cwd;
    }
    if (parsed.type === 'user' || parsed.type === 'assistant') {
      messageCount += 1;
      if (parsed.type === 'assistant') {
        const text = textOfContent(parsed.message?.content);
        if (text.includes('tool_use') || Array.isArray(parsed.message?.content)) {
          toolCalls += 1;
        }
      }
    } else if (parsed.type === 'tool_use' || parsed.type === 'tool_result') {
      toolCalls += 1;
    }
  }
  if (startedAt === '' || lastActivityAt === '') {
    return null;
  }
  const slug = path.basename(path.dirname(file));
  return {
    sessionId: path.basename(file, '.jsonl'),
    fileName: file,
    cwd: cwd.length > 0 ? cwd : slugToCwd(slug),
    startedAt,
    lastActivityAt,
    messageCount,
    toolCalls,
  };
}

/** Transcript detail: user/assistant text turns (read-only view). */
export interface ClaudeTurn {
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
}

export async function parseClaudeDetail(file: string): Promise<ClaudeTurn[]> {
  let content: string;
  try {
    content = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  const turns: ClaudeTurn[] = [];
  for (const line of content.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    let parsed: ClaudeLine;
    try {
      parsed = JSON.parse(line) as ClaudeLine;
    } catch {
      continue;
    }
    if (parsed.type !== 'user' && parsed.type !== 'assistant') {
      continue;
    }
    const text = textOfContent(parsed.message?.content).trim();
    if (text.length === 0) {
      continue;
    }
    turns.push({
      role: parsed.type,
      text: text.slice(0, 400),
      timestamp: parsed.timestamp ?? '',
    });
  }
  return turns;
}

/** Locates a transcript by session id. */
export async function findClaudeTranscript(sessionId: string): Promise<string | null> {
  const files: string[] = [];
  await collectTranscripts(files);
  const match = files.find((file) => path.basename(file, '.jsonl') === sessionId);
  return match ?? null;
}

/** Lists claude records, newest activity first. */
export async function listClaudeSessions(): Promise<ClaudeSessionMeta[]> {
  const files: string[] = [];
  await collectTranscripts(files);
  const sessions: ClaudeSessionMeta[] = [];
  for (const file of files) {
    const meta = await parseClaudeTranscript(file);
    if (meta !== null) {
      sessions.push(meta);
    }
  }
  sessions.sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1));
  return sessions;
}
