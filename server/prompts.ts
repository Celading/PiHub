import type { AgentMessage } from '../shared/types.js';
import {
  collectSessionFiles,
  parseSessionFile,
  SESSION_DIR,
} from './sessions.js';
import { listCodexSessionsFast } from './adapters/codex-history.js';
import { loadRolloutMessages } from './adapters/codex-adapter.js';
import {
  findClaudeTranscript,
  listClaudeSessions,
  parseClaudeDetail,
} from './adapters/claude-history.js';
import { getAtomcodeSession } from './adapters/atomcode-history.js';

/**
 * Universal prompt index (2026-08-12): every agent adapter registers a
 * prompt extractor; the index aggregates them into one searchable surface.
 * NOT hard-coded to codex/claude — adding an adapter later means adding an
 * extractor here (and in the frontend filter).
 */

export interface PromptRecord {
  agent: string;
  sessionId: string;
  cwd: string;
  timestamp: number;
  text: string;
}

export type PromptExtractor = (limit: number) => Promise<PromptRecord[]>;

function agentCwdOf(fileName: string, fallback: string): string {
  return fallback.length > 0 ? fallback : fileName;
}

/** Extracts the prompt text of a message (string or text blocks). */
function promptTextOf(message: AgentMessage): string {
  if (message.role !== 'user' && message.role !== 'assistant') {
    return '';
  }
  if (typeof message.content === 'string') {
    return message.content.trim();
  }
  const parts: string[] = [];
  for (const block of message.content) {
    // Array blocks are always objects (ContentBlock | generic record).
    const record = block as Record<string, unknown>;
    if (String(record['type']) === 'text' && typeof record['text'] === 'string') {
      parts.push(record['text']);
    }
  }
  return parts.join('\n').trim();
}

/** pi: user messages of the newest session files. */
const piExtractor: PromptExtractor = async (limit) => {
  const files = await collectSessionFiles(SESSION_DIR);
  const newest = files.slice(-Math.max(limit, 8));
  const records: PromptRecord[] = [];
  for (const file of newest) {
    const detail = await parseSessionFile(file);
    if (detail === null) {
      continue;
    }
    for (const entry of detail.entries) {
      const message = entry.message;
      if (message === undefined || message.role !== 'user') {
        continue;
      }
      const text = promptTextOf(message);
      if (text.length === 0) {
        continue;
      }
      records.push({
        agent: 'pi',
        sessionId: detail.id,
        cwd: detail.cwd,
        timestamp: typeof message.timestamp === 'number' ? message.timestamp : 0,
        text: text.slice(0, 500),
      });
    }
  }
  return records;
};

/** codex: user turns of the newest rollout records. */
const codexExtractor: PromptExtractor = async (limit) => {
  const sessions = await listCodexSessionsFast();
  const records: PromptRecord[] = [];
  let scanned = 0;
  for (const meta of sessions) {
    if (meta.placeholder === true || scanned >= limit) {
      continue;
    }
    scanned += 1;
    const messages = await loadRolloutMessages(meta.sessionId);
    if (messages === null) {
      continue;
    }
    for (const message of messages) {
      if (message.role !== 'user') {
        continue;
      }
      const text = typeof message.content === 'string' ? message.content : '';
      if (text.trim().length === 0) {
        continue;
      }
      records.push({
        agent: 'codex',
        sessionId: meta.sessionId,
        cwd: meta.cwd,
        timestamp: message.timestamp,
        text: text.slice(0, 500),
      });
    }
  }
  return records;
};

/** claude: user turns of the newest transcripts. */
const claudeExtractor: PromptExtractor = async (limit) => {
  const sessions = await listClaudeSessions();
  const records: PromptRecord[] = [];
  for (const meta of sessions.slice(0, Math.max(limit, 8))) {
    const file = await findClaudeTranscript(meta.sessionId);
    if (file === null) {
      continue;
    }
    const turns = await parseClaudeDetail(file);
    for (const turn of turns) {
      if (turn.role !== 'user') {
        continue;
      }
      records.push({
        agent: 'claude',
        sessionId: meta.sessionId,
        cwd: meta.cwd,
        timestamp: Date.parse(turn.timestamp) || 0,
        text: turn.text.slice(0, 500),
      });
    }
  }
  return records;
};

/** atomcode: user messages of the history record. */
const atomcodeExtractor: PromptExtractor = async () => {
  const session = await getAtomcodeSession();
  if (session === null) {
    return [];
  }
  const records: PromptRecord[] = [];
  for (const message of session.messages) {
    if (message.role !== 'user') {
      continue;
    }
    records.push({
      agent: 'atomcode',
      sessionId: session.id,
      cwd: agentCwdOf(session.fileName, ''),
      timestamp: 0,
      text: message.text.slice(0, 500),
    });
  }
  return records;
};

/** zcode: no user-prompt payload in the model-I/O records — honest empty. */
const zcodeExtractor: PromptExtractor = () => Promise.resolve([]);

/** Registered extractors; the frontend filter mirrors these agents. */
export const PROMPT_EXTRACTORS: ReadonlyArray<{ agent: string; extract: PromptExtractor }> = [
  { agent: 'pi', extract: piExtractor },
  { agent: 'codex', extract: codexExtractor },
  { agent: 'claude', extract: claudeExtractor },
  { agent: 'atomcode', extract: atomcodeExtractor },
  { agent: 'zcode', extract: zcodeExtractor },
];

export interface PromptQuery {
  q?: string;
  agent?: string;
  limit?: number;
}

/** Aggregates, filters and sorts prompts across all registered extractors. */
export async function collectPrompts(query: PromptQuery): Promise<PromptRecord[]> {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const perAgent = Math.max(Math.ceil(limit / PROMPT_EXTRACTORS.length), 6);
  const records: PromptRecord[] = [];
  for (const entry of PROMPT_EXTRACTORS) {
    if (query.agent !== undefined && query.agent !== entry.agent) {
      continue;
    }
    try {
      records.push(...(await entry.extract(perAgent)));
    } catch {
      // one extractor failing must not blank the whole index
    }
  }
  const needle = (query.q ?? '').trim().toLowerCase();
  const filtered =
    needle.length === 0
      ? records
      : records.filter((record) => record.text.toLowerCase().includes(needle));
  filtered.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  return filtered.slice(0, limit);
}
