import type {
  AgentMessage,
  ContentBlock,
  DayStatRow,
  DirectoryStatRow,
  ModelStatRow,
  ProviderStatRow,
  SessionDetail,
  SessionEntry,
  SessionStats,
  SessionSummary,
  SessionTreeNode,
  TokenTotals,
} from '../../shared/types.js';
import type { SessionProvider } from './file-session-provider.js';

/**
 * Demo-mode session provider (KMODE-001 K3): a fully fictional, de-identified
 * dataset. Shapes are built from the shared zod-derived types so they cannot
 * drift from the real parser output. Never references real ~/.pi content.
 */

const ts = (dayOffset: number, hour: number, minute: number): string => {
  const date = new Date('2026-08-06T00:00:00Z');
  date.setUTCDate(date.getUTCDate() - dayOffset);
  date.setUTCHours(hour, minute, 0, 0);
  return date.toISOString();
};

const totals = (input: number, output: number, cacheRead = 0, cacheWrite = 0): TokenTotals => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  total: input + output + cacheRead + cacheWrite,
});

interface MockSessionSpec {
  id: string;
  name: string;
  cwd: string;
  startedAt: string;
  lastActivityAt: string;
  status: 'running' | 'done' | 'aborted';
  models: string[];
  providers: string[];
  tokens: TokenTotals;
  cost: number;
  entries: SessionEntry[];
}

function message(
  role: Extract<AgentMessage, { role: 'user' | 'assistant' }>['role'],
  content: string | ContentBlock[],
  timestamp: number,
): AgentMessage {
  // user/assistant variants share role+content+timestamp; the union return
  // needs the cast because variants carry distinct optional fields.
  return { role, content, timestamp } as AgentMessage;
}

const runningSpec: MockSessionSpec = {
  id: 'demo-001',
  name: 'demo workflow run',
  cwd: '~/demo/pi-project',
  startedAt: ts(0, 8, 12),
  lastActivityAt: ts(0, 8, 13),
  status: 'running',
  models: ['deepseek-v4-flash'],
  providers: ['demo-provider'],
  tokens: totals(3450, 620, 1200),
  cost: 0.0042,
  entries: [
    {
      id: 'demo-001-e1',
      parentId: null,
      timestamp: ts(0, 8, 12),
      type: 'message',
      message: message('user', 'how does PiHub connect to pi?', Date.parse(ts(0, 8, 12))),
    },
    {
      id: 'demo-001-e2',
      parentId: 'demo-001-e1',
      timestamp: ts(0, 8, 12),
      type: 'message',
      thinkingLevel: 'high',
      provider: 'demo-provider',
      modelId: 'deepseek-v4-flash',
      message: message(
        'assistant',
        [
          {
            type: 'thinking',
            thinking: 'The user asks about the connection architecture. PiHub spawns a local pi --mode rpc process over JSONL stdio and bridges it with HTTP/SSE.',
          },
        ],
        Date.parse(ts(0, 8, 12)),
      ),
    },
    {
      id: 'demo-001-e3',
      parentId: 'demo-001-e2',
      timestamp: ts(0, 8, 13),
      type: 'message',
      message: message('assistant', [
        {
          type: 'toolCall',
          id: 'demo-tool-1',
          name: 'bash',
          arguments: { command: 'ls ~/.pi/agent/sessions' },
        },
      ], Date.parse(ts(0, 8, 13))),
    },
    {
      id: 'demo-001-e4',
      parentId: 'demo-001-e3',
      timestamp: ts(0, 8, 13),
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'demo-tool-1',
        toolName: 'bash',
        content: [
          {
            type: 'text',
            text: '2026-08-06-demo-workflow.jsonl\n2026-08-05-demo-site-check.jsonl',
          },
        ],
        isError: false,
        timestamp: Date.parse(ts(0, 8, 13)),
      },
    },
    {
      id: 'demo-001-e5',
      parentId: 'demo-001-e4',
      timestamp: ts(0, 8, 13),
      type: 'message',
      message: message('assistant', [
        {
          type: 'text',
          text: 'PiHub talks to a local `pi --mode rpc` process through a small Node bridge. Everything stays on your machine — no cloud, no accounts.',
        },
      ], Date.parse(ts(0, 8, 13))),
    },
  ],
};

const doneSpec: MockSessionSpec = {
  id: 'demo-002',
  name: 'demo site check',
  cwd: '~/demo/site',
  startedAt: ts(1, 14, 5),
  lastActivityAt: ts(1, 14, 9),
  status: 'done',
  models: ['deepseek-v4-flash', 'gpt-5.6'],
  providers: ['demo-provider'],
  tokens: totals(12900, 2150, 4800),
  cost: 0.0187,
  entries: [
    {
      id: 'demo-002-e1',
      parentId: null,
      timestamp: ts(1, 14, 5),
      type: 'message',
      message: message('user', 'check the landing page for broken links', Date.parse(ts(1, 14, 5))),
    },
    {
      id: 'demo-002-e2',
      parentId: 'demo-002-e1',
      timestamp: ts(1, 14, 6),
      type: 'message',
      thinkingLevel: 'medium',
      provider: 'demo-provider',
      modelId: 'deepseek-v4-flash',
      message: message(
        'assistant',
        [
          {
            type: 'thinking',
            thinking: 'Crawl the homepage, collect href targets, verify each returns 200.',
          },
        ],
        Date.parse(ts(1, 14, 6)),
      ),
    },
    {
      id: 'demo-002-e3',
      parentId: 'demo-002-e2',
      timestamp: ts(1, 14, 7),
      type: 'message',
      message: message('assistant', [
        {
          type: 'text',
          text: 'Checked 24 links — all reachable. The hero CTA and footer mirrors are fine.',
        },
      ], Date.parse(ts(1, 14, 7))),
    },
  ],
};

const abortedSpec: MockSessionSpec = {
  id: 'demo-003',
  name: 'demo refactor plan',
  cwd: '~/demo/pi-project',
  startedAt: ts(2, 10, 40),
  lastActivityAt: ts(2, 10, 41),
  status: 'aborted',
  models: ['deepseek-v4-flash'],
  providers: ['demo-provider'],
  tokens: totals(1800, 90),
  cost: 0.0011,
  entries: [
    {
      id: 'demo-003-e1',
      parentId: null,
      timestamp: ts(2, 10, 40),
      type: 'message',
      message: message('user', 'plan the composer refactor', Date.parse(ts(2, 10, 40))),
    },
    {
      id: 'demo-003-e2',
      parentId: 'demo-003-e1',
      timestamp: ts(2, 10, 41),
      type: 'message',
      thinkingLevel: 'high',
      provider: 'demo-provider',
      modelId: 'deepseek-v4-flash',
      message: message(
        'assistant',
        [
          {
            type: 'thinking',
            thinking: 'Refactor plan: split composer into input, actions, model row…',
          },
        ],
        Date.parse(ts(2, 10, 41)),
      ),
    },
  ],
};

const SPECS: MockSessionSpec[] = [runningSpec, doneSpec, abortedSpec];

function summarize(spec: MockSessionSpec): SessionSummary {
  const messages = spec.entries.filter((entry) => entry.type === 'message');
  const toolCalls = messages.filter(
    (entry) =>
      entry.message?.role === 'assistant' &&
      entry.message.content.some((block) => block.type === 'toolCall'),
  ).length;
  const toolResults = messages.filter((entry) => entry.message?.role === 'toolResult').length;
  return {
    id: spec.id,
    fileName: `${spec.id}.jsonl`,
    cwd: spec.cwd,
    name: spec.name,
    startedAt: spec.startedAt,
    messageCount: messages.length,
    userMessages: messages.filter((entry) => entry.message?.role === 'user').length,
    assistantMessages: messages.filter((entry) => entry.message?.role === 'assistant').length,
    toolCalls,
    toolResults,
    tokens: spec.tokens,
    cost: spec.cost,
    models: spec.models,
    providers: spec.providers,
    lastActivityAt: spec.lastActivityAt,
  };
}

function buildTree(spec: MockSessionSpec): SessionTreeNode[] {
  const byId = new Map<string, SessionTreeNode>(
    spec.entries.map((entry) => [entry.id, { entry, children: [] }]),
  );
  const roots: SessionTreeNode[] = [];
  for (const entry of spec.entries) {
    const node = byId.get(entry.id);
    if (node === undefined) {
      continue;
    }
    if (entry.parentId === null) {
      roots.push(node);
    } else {
      const parent = byId.get(entry.parentId);
      if (parent !== undefined) {
        parent.children.push(node);
      }
    }
  }
  return roots;
}

function detail(spec: MockSessionSpec): SessionDetail {
  return {
    id: spec.id,
    fileName: `${spec.id}.jsonl`,
    cwd: spec.cwd,
    name: spec.name,
    startedAt: spec.startedAt,
    entries: spec.entries,
    tree: buildTree(spec),
    leafId: spec.entries.length > 0 ? spec.entries[spec.entries.length - 1]?.id ?? null : null,
    totals: spec.tokens,
    totalCost: spec.cost,
  };
}

function stats(): SessionStats {
  const summaries = SPECS.map(summarize);
  const byModelMap = new Map<string, ModelStatRow>();
  const byProviderMap = new Map<string, ProviderStatRow>();
  const byDirectoryMap = new Map<string, DirectoryStatRow>();
  const byDayMap = new Map<string, DayStatRow>();
  let totalUser = 0;
  let totalAssistant = 0;
  let totalToolCalls = 0;
  let totalCost = 0;
  const totalsAcc = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

  for (const summary of summaries) {
    totalUser += summary.userMessages;
    totalAssistant += summary.assistantMessages;
    totalToolCalls += summary.toolCalls;
    totalCost += summary.cost;
    totalsAcc.input += summary.tokens.input;
    totalsAcc.output += summary.tokens.output;
    totalsAcc.cacheRead += summary.tokens.cacheRead;
    totalsAcc.cacheWrite += summary.tokens.cacheWrite;
    totalsAcc.total += summary.tokens.total;

    for (const model of summary.models) {
      const provider = summary.providers[0] ?? 'demo-provider';
      const row = byModelMap.get(model);
      if (row !== undefined) {
        row.sessions += 1;
        row.messages += summary.messageCount;
        row.tokens.input += summary.tokens.input;
        row.tokens.output += summary.tokens.output;
        row.cost += summary.cost;
      } else {
        byModelMap.set(model, {
          model,
          provider,
          sessions: 1,
          messages: summary.messageCount,
          tokens: { ...summary.tokens },
          cost: summary.cost,
        });
      }
    }
    const providerRow = byProviderMap.get(summary.providers[0] ?? 'demo-provider');
    if (providerRow !== undefined) {
      providerRow.sessions += 1;
      providerRow.messages += summary.messageCount;
      providerRow.cost += summary.cost;
    } else {
      byProviderMap.set(summary.providers[0] ?? 'demo-provider', {
        provider: summary.providers[0] ?? 'demo-provider',
        sessions: 1,
        messages: summary.messageCount,
        tokens: { ...summary.tokens },
        cost: summary.cost,
      });
    }
    const dirRow = byDirectoryMap.get(summary.cwd);
    if (dirRow !== undefined) {
      dirRow.sessions += 1;
      dirRow.messages += summary.messageCount;
      dirRow.tokens.input += summary.tokens.input;
      dirRow.tokens.output += summary.tokens.output;
      dirRow.cost += summary.cost;
    } else {
      byDirectoryMap.set(summary.cwd, {
        cwd: summary.cwd,
        sessions: 1,
        messages: summary.messageCount,
        tokens: { ...summary.tokens },
        cost: summary.cost,
      });
    }

    const day = summary.lastActivityAt.slice(0, 10);
    const dayRow = byDayMap.get(day);
    if (dayRow !== undefined) {
      dayRow.sessions += 1;
      dayRow.messages += summary.messageCount;
      dayRow.tokens.input += summary.tokens.input;
      dayRow.tokens.output += summary.tokens.output;
      dayRow.cost += summary.cost;
    } else {
      byDayMap.set(day, {
        day,
        sessions: 1,
        messages: summary.messageCount,
        tokens: { ...summary.tokens },
        cost: summary.cost,
      });
    }
  }

  const sortByCost = <T extends { cost: number }>(rows: T[]): T[] =>
    [...rows].sort((a, b) => b.cost - a.cost);

  const topSessions: SessionStats['topSessions'] = summaries
    .map((summary) => ({
      fileName: summary.fileName,
      cwd: summary.cwd,
      startedAt: summary.startedAt,
      lastActivityAt: summary.lastActivityAt,
      messages: summary.messageCount,
      tokens: { ...summary.tokens },
      cost: summary.cost,
    }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 5);

  return {
    totalSessions: summaries.length,
    totalUserMessages: totalUser,
    totalAssistantMessages: totalAssistant,
    totalToolCalls,
    totals: totalsAcc,
    totalCost,
    byModel: sortByCost([...byModelMap.values()]),
    byProvider: sortByCost([...byProviderMap.values()]),
    byDirectory: sortByCost([...byDirectoryMap.values()]),
    byDay: [...byDayMap.entries()].map(([, row]) => row).sort((a, b) => (a.day < b.day ? -1 : 1)),
    topSessions,
  };
}

/** The active demo session id (driven by the state machine). */
export const DEMO_RUNNING_ID = runningSpec.id;

/** Demo-mode provider: static fictional dataset + status-light hook for the
 *  state machine (KMODE-001 K3/K4). */
export interface DemoSessionProvider extends SessionProvider {
  setDemoStatus: (id: string, status: 'done' | 'aborted') => void;
}

export function createMockSessionProvider(): DemoSessionProvider {
  return {
    list(): Promise<SessionSummary[]> {
      return Promise.resolve(
        SPECS.map(summarize).sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1)),
      );
    },
    get(id: string): Promise<SessionDetail | null> {
      const spec = SPECS.find((entry) => entry.id === id);
      return Promise.resolve(spec === undefined ? null : detail(spec));
    },
    stats(): Promise<SessionStats> {
      return Promise.resolve(stats());
    },
    setDemoStatus(id: string, status: 'done' | 'aborted'): void {
      const spec = SPECS.find((entry) => entry.id === id);
      if (spec !== undefined) {
        spec.status = status;
      }
    },
  };
}
