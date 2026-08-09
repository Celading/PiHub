import { readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * ADAPTER2 A: atomcode read-only session records.
 *
 * atomcode persists conversation history as `~/.atomcode/history.json`
 * (array of { role, content: { Text } } messages) plus per-day logs under
 * `~/.atomcode/datalog/`. This module parses those records WITHOUT spawning
 * atomcode and without touching `~/.atomcode/auth.toml`.
 */

const MAX_BYTES = 8 * 1024 * 1024;

/** Resolved at call time so tests can override ATOMCODE_HOME. */
function atomcodeHome(): string {
  return process.env.ATOMCODE_HOME ?? path.join(os.homedir(), '.atomcode');
}

export interface AtomcodeMessage {
  role: 'user' | 'assistant' | 'tool';
  text: string;
}

export interface AtomcodeSessionMeta {
  id: string;
  fileName: string;
  startedAt: string;
  messageCount: number;
  lastText: string;
}

export interface AtomcodeSessionDetail extends AtomcodeSessionMeta {
  messages: AtomcodeMessage[];
}

interface RawHistoryEntry {
  role?: string;
  content?: { Text?: string } | string;
}

function textOf(entry: RawHistoryEntry): string {
  const content = entry.content;
  if (typeof content === 'string') {
    return content;
  }
  if (typeof content === 'object' && typeof content.Text === 'string') {
    return content.Text;
  }
  return '';
}

function roleOf(entry: RawHistoryEntry): AtomcodeMessage['role'] {
  const role = entry.role?.toLowerCase() ?? 'assistant';
  if (role === 'user' || role === 'tool') {
    return role;
  }
  return 'assistant';
}

/** Parses history.json into a message list. */
export async function readAtomcodeHistory(): Promise<AtomcodeMessage[]> {
  let raw: string;
  try {
    raw = await readFile(path.join(atomcodeHome(), 'history.json'), 'utf8');
  } catch {
    return [];
  }
  if (raw.length > MAX_BYTES) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const out: AtomcodeMessage[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const text = textOf(entry as RawHistoryEntry);
    if (text.length === 0) {
      continue;
    }
    out.push({ role: roleOf(entry as RawHistoryEntry), text });
  }
  return out;
}

/** Lists per-day datalog files (metadata only). */
export async function listAtomcodeDatalogs(): Promise<Array<{ fileName: string; size: number }>> {
  let entries: string[];
  try {
    entries = await readdir(path.join(atomcodeHome(), 'datalog'));
  } catch {
    return [];
  }
  const out: Array<{ fileName: string; size: number }> = [];
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl') && !entry.endsWith('.md')) {
      continue;
    }
    try {
      const info = await stat(path.join(atomcodeHome(), 'datalog', entry));
      if (info.size <= MAX_BYTES) {
        out.push({ fileName: entry, size: info.size });
      }
    } catch {
      // skip unreadable entries
    }
  }
  return out.sort((a, b) => (a.fileName < b.fileName ? 1 : -1));
}

/** Builds the atomcode session record (history.json is the single session). */
export async function getAtomcodeSession(): Promise<AtomcodeSessionDetail | null> {
  const messages = await readAtomcodeHistory();
  if (messages.length === 0) {
    return null;
  }
  const last = messages[messages.length - 1];
  return {
    id: 'atomcode-history',
    fileName: path.join(atomcodeHome(), 'history.json'),
    startedAt: '',
    messageCount: messages.length,
    lastText: last?.text.slice(0, 200) ?? '',
    messages,
  };
}
