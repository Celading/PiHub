/**
 * pi agent protocol types (shared frontend/backend).
 *
 * Protocol shapes are derived from the zod boundary schemas in schemas.ts
 * (single source of truth; exactOptionalPropertyTypes-safe). Panel API shapes
 * below are plain interfaces computed by the server.
 */
import type { z } from 'zod';
import type {
  agentMessageSchema,
  contentBlockSchema,
  modelInfoSchema,
  rpcResponseSchema,
  sessionEventSchema,
  sessionHeaderEventSchema,
} from './schemas.js';

export type ContentBlock = z.infer<typeof contentBlockSchema>;
export type AgentMessage = z.infer<typeof agentMessageSchema>;
export type SessionEvent = z.infer<typeof sessionEventSchema>;
export type SessionHeaderEvent = z.infer<typeof sessionHeaderEventSchema>;
export type ModelInfo = z.infer<typeof modelInfoSchema>;
export type RpcResponse = z.infer<typeof rpcResponseSchema>;

export type Role = 'user' | 'assistant' | 'toolResult' | 'bashExecution';

export interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens?: number;
  cost?: CostBreakdown;
}

export interface Attachment {
  id: string;
  type: string;
  fileName?: string;
  mimeType?: string;
  size?: number;
  content?: string;
}

/* ---- panel API response shapes ---- */

export interface SessionSummary {
  id: string;
  fileName: string;
  cwd: string;
  startedAt: string;
  messageCount: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  tokens: TokenTotals;
  cost: number;
  models: string[];
  providers: string[];
  lastActivityAt: string;
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface SessionDetail {
  id: string;
  fileName: string;
  cwd: string;
  startedAt: string;
  entries: SessionEntry[];
  tree: SessionTreeNode[];
  leafId: string | null;
  totals: TokenTotals;
  totalCost: number;
}

export interface SessionEntry {
  id: string;
  parentId: string | null;
  timestamp: string;
  type: string;
  message?: AgentMessage;
  thinkingLevel?: string;
  provider?: string;
  modelId?: string;
}

export interface SessionTreeNode {
  entry: SessionEntry;
  children: SessionTreeNode[];
}

export interface SessionStats {
  totalSessions: number;
  totalUserMessages: number;
  totalAssistantMessages: number;
  totalToolCalls: number;
  totals: TokenTotals;
  totalCost: number;
  byModel: ModelStatRow[];
  byProvider: ProviderStatRow[];
  byDirectory: DirectoryStatRow[];
}

export interface ModelStatRow {
  model: string;
  provider: string;
  sessions: number;
  messages: number;
  tokens: TokenTotals;
  cost: number;
}

export interface ProviderStatRow {
  provider: string;
  sessions: number;
  messages: number;
  tokens: TokenTotals;
  cost: number;
}

export interface DirectoryStatRow {
  cwd: string;
  sessions: number;
  messages: number;
  cost: number;
}

export interface RpcState {
  model: ModelInfo | null;
  thinkingLevel: string;
  isStreaming: boolean;
  sessionFile?: string;
  sessionId?: string;
  messageCount?: number;
  pendingMessageCount?: number;
}

/** RPC events streamed to stdout (loosely typed; frequently used shapes). */
export interface RpcStreamEvent {
  type: string;
  [key: string]: unknown;
}

export type PiCommandSource = 'extension' | 'prompt' | 'skill';

export interface PiCommand {
  name: string;
  description?: string;
  source: PiCommandSource;
  location?: string;
  path?: string;
}
