import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { sessionEventSchema } from '../shared/schemas.js';
import type {
  AgentMessage,
  SessionDetail,
  SessionEntry,
  SessionHeaderEvent,
  SessionStats,
  SessionSummary,
  SessionTreeNode,
  TokenTotals,
} from '../shared/types.js';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_LINES = 20_000;
export const SESSION_DIR = path.join(os.homedir(), '.pi', 'agent', 'sessions');
/** P1-04: how many top-cost sessions the stats endpoint reports. */
const TOP_SESSIONS_LIMIT = 5;

export const emptyTotals = (): TokenTotals => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
});

export function addTotals(target: TokenTotals, usage: TokenTotals | undefined): void {
  if (usage === undefined) {
    return;
  }
  target.input += usage.input;
  target.output += usage.output;
  target.cacheRead += usage.cacheRead;
  target.cacheWrite += usage.cacheWrite;
  target.total += usage.total;
}

function usageOf(message: AgentMessage): TokenTotals | undefined {
  if (message.role !== 'assistant' && message.role !== 'toolResult') {
    return undefined;
  }
  const usage = message.usage;
  if (usage === undefined) {
    return undefined;
  }
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    total:
      usage.totalTokens ??
      usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
  };
}

function costOf(message: AgentMessage): number {
  if (message.role !== 'assistant' && message.role !== 'toolResult') {
    return 0;
  }
  return message.usage?.cost?.total ?? 0;
}

export async function collectSessionFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSessionFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(fullPath);
    }
  }
  return files;
}

export async function parseSessionFile(fileName: string): Promise<SessionDetail | null> {
  let info;
  try {
    info = await stat(fileName);
  } catch {
    return null;
  }
  if (info.size > MAX_FILE_BYTES) {
    return null;
  }
  let content: string;
  try {
    content = await readFile(fileName, 'utf8');
  } catch {
    return null;
  }
  if (content.length === 0) {
    return null;
  }

  const entries: SessionEntry[] = [];
  let header: SessionHeaderEvent | null = null;
  let sessionName: string | undefined;
  let lineCount = 0;

  for (const line of content.split('\n')) {
    lineCount += 1;
    if (lineCount > MAX_LINES) {
      break;
    }
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      continue;
    }
    const result = sessionEventSchema.safeParse(parsed);
    if (!result.success) {
      continue;
    }
    const event = result.data;
    if (event.type === 'session') {
      header = event;
      continue;
    }
    if (event.type === 'session_info') {
      // Display name; the latest entry wins (explicit clears are empty).
      if (event.name.trim().length > 0) {
        sessionName = event.name;
      } else {
        sessionName = undefined;
      }
      continue;
    }
    const entry: SessionEntry = {
      id: event.id,
      parentId: event.parentId,
      timestamp: event.timestamp,
      type: event.type,
    };
    if (event.type === 'message') {
      entry.message = event.message;
    } else if (event.type === 'thinking_level_change') {
      entry.thinkingLevel = event.thinkingLevel;
    } else {
      entry.provider = event.provider;
      entry.modelId = event.modelId;
    }
    entries.push(entry);
  }

  if (header === null) {
    return null;
  }

  const tree = buildTree(entries);
  return {
    id: header.id,
    fileName,
    cwd: header.cwd,
    ...(sessionName !== undefined ? { name: sessionName } : {}),
    startedAt: header.timestamp,
    entries,
    tree,
    leafId: leafOf(entries),
    totals: aggregateTotals(entries),
    totalCost: aggregateCost(entries),
  };
}

function buildTree(entries: SessionEntry[]): SessionTreeNode[] {
  const byId = new Map<string, SessionTreeNode>();
  for (const entry of entries) {
    byId.set(entry.id, { entry, children: [] });
  }
  const roots: SessionTreeNode[] = [];
  for (const node of byId.values()) {
    const parent = node.entry.parentId === null ? undefined : byId.get(node.entry.parentId);
    if (parent === undefined) {
      roots.push(node);
    } else {
      parent.children.push(node);
    }
  }
  return roots;
}

function leafOf(entries: SessionEntry[]): string | null {
  if (entries.length === 0) {
    return null;
  }
  return entries[entries.length - 1]?.id ?? null;
}

function aggregateTotals(entries: SessionEntry[]): TokenTotals {
  const totals = emptyTotals();
  for (const entry of entries) {
    if (entry.type !== 'message' || entry.message === undefined) {
      continue;
    }
    addTotals(totals, usageOf(entry.message));
  }
  return totals;
}

function aggregateCost(entries: SessionEntry[]): number {
  let cost = 0;
  for (const entry of entries) {
    if (entry.type === 'message' && entry.message !== undefined) {
      cost += costOf(entry.message);
    }
  }
  return cost;
}

function summarize(detail: SessionDetail): SessionSummary {
  const models = new Set<string>();
  const providers = new Set<string>();
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let toolResults = 0;
  let lastActivityAt = detail.startedAt;

  for (const entry of detail.entries) {
    if (entry.timestamp > lastActivityAt) {
      lastActivityAt = entry.timestamp;
    }
    if (entry.type === 'message' && entry.message !== undefined) {
      const message = entry.message;
      switch (message.role) {
        case 'user':
          userMessages += 1;
          break;
        case 'assistant':
          assistantMessages += 1;
          if (message.model !== undefined) {
            models.add(message.model);
          }
          if (message.provider !== undefined) {
            providers.add(message.provider);
          }
          break;
        case 'toolResult':
          toolResults += 1;
          break;
        case 'bashExecution':
          break;
      }
      for (const block of message.role === 'assistant' ? message.content : []) {
        if (block.type === 'toolCall') {
          toolCalls += 1;
        }
      }
    }
  }

  return {
    id: detail.id,
    fileName: detail.fileName,
    cwd: detail.cwd,
    ...(detail.name !== undefined ? { name: detail.name } : {}),
    startedAt: detail.startedAt,
    messageCount: detail.entries.filter((entry) => entry.type === 'message').length,
    userMessages,
    assistantMessages,
    toolCalls,
    toolResults,
    tokens: detail.totals,
    cost: detail.totalCost,
    models: [...models].sort(),
    providers: [...providers].sort(),
    lastActivityAt,
  };
}

export interface SessionStore {
  list(): Promise<SessionSummary[]>;
  get(id: string): Promise<SessionDetail | null>;
  stats(): Promise<SessionStats>;
}

export function createSessionStore(dir: string = SESSION_DIR): SessionStore {
  return {
    async list(): Promise<SessionSummary[]> {
      const files = await collectSessionFiles(dir);
      const details = await Promise.all(files.map((file) => parseSessionFile(file)));
      const summaries = details
        .filter((detail): detail is SessionDetail => detail !== null)
        .map((detail) => summarize(detail));
      summaries.sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1));
      return summaries;
    },

    async get(id: string): Promise<SessionDetail | null> {
      const files = await collectSessionFiles(dir);
      for (const file of files) {
        const detail = await parseSessionFile(file);
        if (detail !== null && detail.id === id) {
          return detail;
        }
      }
      return null;
    },

    async stats(): Promise<SessionStats> {
      const summaries = await this.list();
      const totals = emptyTotals();
      const byModel = new Map<string, SessionStats['byModel'][number]>();
      const byProvider = new Map<string, SessionStats['byProvider'][number]>();
      const byDirectory = new Map<string, SessionStats['byDirectory'][number]>();
      const byDay = new Map<string, SessionStats['byDay'][number]>();

      let totalUserMessages = 0;
      let totalAssistantMessages = 0;
      let totalToolCalls = 0;
      let totalCost = 0;

      for (const summary of summaries) {
        addTotals(totals, summary.tokens);
        totalUserMessages += summary.userMessages;
        totalAssistantMessages += summary.assistantMessages;
        totalToolCalls += summary.toolCalls;
        totalCost += summary.cost;

        for (const model of summary.models) {
          const existing = byModel.get(model);
          if (existing === undefined) {
            byModel.set(model, {
              model,
              provider: summary.providers[0] ?? 'unknown',
              sessions: 1,
              messages: summary.assistantMessages,
              tokens: { ...summary.tokens },
              cost: summary.cost,
            });
          } else {
            existing.sessions += 1;
            existing.messages += summary.assistantMessages;
            addTotals(existing.tokens, summary.tokens);
            existing.cost += summary.cost;
          }
        }

        for (const provider of summary.providers) {
          const existing = byProvider.get(provider);
          if (existing === undefined) {
            byProvider.set(provider, {
              provider,
              sessions: 1,
              messages: summary.assistantMessages,
              tokens: { ...summary.tokens },
              cost: summary.cost,
            });
          } else {
            existing.sessions += 1;
            existing.messages += summary.assistantMessages;
            addTotals(existing.tokens, summary.tokens);
            existing.cost += summary.cost;
          }
        }

        const dir = summary.cwd || '(unknown)';
        const dirRow = byDirectory.get(dir);
        if (dirRow === undefined) {
          byDirectory.set(dir, {
            cwd: dir,
            sessions: 1,
            messages: summary.messageCount,
            tokens: { ...summary.tokens },
            cost: summary.cost,
          });
        } else {
          dirRow.sessions += 1;
          dirRow.messages += summary.messageCount;
          addTotals(dirRow.tokens, summary.tokens);
          dirRow.cost += summary.cost;
        }

        const day = summary.lastActivityAt.slice(0, 10);
        const dayRow = byDay.get(day);
        if (dayRow === undefined) {
          byDay.set(day, {
            day,
            sessions: 1,
            messages: summary.messageCount,
            tokens: { ...summary.tokens },
            cost: summary.cost,
          });
        } else {
          dayRow.sessions += 1;
          dayRow.messages += summary.messageCount;
          addTotals(dayRow.tokens, summary.tokens);
          dayRow.cost += summary.cost;
        }
      }

      const sortByCost = <T extends { cost: number }>(rows: T[]): T[] =>
        [...rows].sort((a, b) => b.cost - a.cost);

      const topSessions: SessionStats['topSessions'] = summaries
        .map((summary) => ({
          fileName: path.basename(summary.fileName),
          cwd: summary.cwd,
          startedAt: summary.startedAt,
          lastActivityAt: summary.lastActivityAt,
          messages: summary.messageCount,
          tokens: { ...summary.tokens },
          cost: summary.cost,
        }))
        .sort((a, b) => b.cost - a.cost)
        .slice(0, TOP_SESSIONS_LIMIT);

      return {
        totalSessions: summaries.length,
        totalUserMessages,
        totalAssistantMessages,
        totalToolCalls,
        totals,
        totalCost,
        byModel: sortByCost([...byModel.values()]),
        byProvider: sortByCost([...byProvider.values()]),
        byDirectory: sortByCost([...byDirectory.values()]),
        byDay: [...byDay.entries()].map(([, row]) => row).sort((a, b) => (a.day < b.day ? -1 : 1)),
        topSessions,
      };
    },
  };
}
