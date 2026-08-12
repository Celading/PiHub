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
  extensionUiRequestSchema,
  modelInfoSchema,
  pipelineSchema,
  pipelineStepSchema,
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
  name?: string;
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
  name?: string;
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
  /** P1-04: daily usage series bucketed by the session's last activity date. */
  byDay: DayStatRow[];
  /** P1-04: most expensive sessions, sorted by cost descending. */
  topSessions: SessionCostRow[];
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
  tokens: TokenTotals;
  cost: number;
}

/** P1-04: one day of usage, bucketed by last activity date (UTC). */
export interface DayStatRow {
  day: string;
  sessions: number;
  messages: number;
  tokens: TokenTotals;
  cost: number;
}

/** P1-04: per-session cost row for the top-cost drill-down. */
export interface SessionCostRow {
  fileName: string;
  cwd: string;
  startedAt: string;
  lastActivityAt: string;
  messages: number;
  tokens: TokenTotals;
  cost: number;
}

export interface RpcState {
  model: ModelInfo | null;
  thinkingLevel: string;
  isStreaming: boolean;
  isCompacting?: boolean;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  autoCompactionEnabled?: boolean;
  messageCount?: number;
  pendingMessageCount?: number;
  /** P1-02 S2: run-mode switches (pi get_state fields). */
  steeringMode?: string;
  followUpMode?: string;
}

/** RPC events streamed to stdout (loosely typed; frequently used shapes). */
export interface RpcStreamEvent {
  type: string;
  [key: string]: unknown;
}

export type PiCommandSource = 'extension' | 'prompt' | 'skill';

/** One node of the current RPC session entry tree (get_entries). */
export interface EntryItem {
  id: string;
  parentId: string | null;
  type: string;
  timestamp?: string;
  message?: AgentMessage;
}

export interface EntriesResponse {
  entries: EntryItem[];
  leafId?: string;
}

/** P1-05: session tree DAG of the current RPC session (get_tree passthrough). */
export interface SessionTreeResponse {
  tree: SessionTreeNode[];
  leafId: string | null;
}

export interface PiCommand {
  name: string;
  description?: string;
  source: PiCommandSource;
  location?: string;
  path?: string;
  /** Raw get_commands entry (sourceInfo etc.); skill conversion reads path. */
  sourceInfo?: { path?: string; source?: string; scope?: string };
}

/* ---- extension UI protocol (phase-3 P1-01) ---- */

/** Extension UI interaction methods (server-normalized from pi frames). */
export type ExtensionUiMethod =
  | 'select'
  | 'confirm'
  | 'input'
  | 'editor'
  | 'notify'
  | 'setStatus'
  | 'setWidget'
  | 'setTitle'
  | 'set_editor_text';

/** Extension UI request (schema-derived, exactOptionalPropertyTypes-safe). */
export type ExtensionUiRequest = z.infer<typeof extensionUiRequestSchema>;

/** Response sent back to pi on stdin (extension_ui_response frame). */
export interface ExtensionUiResponse {
  id: string;
  value?: string | undefined;
  confirmed?: boolean | undefined;
  cancelled?: boolean | undefined;
}

/* ---- pipelines (phase-3 P1-02-C) ---- */

export type PipelineStep = z.infer<typeof pipelineStepSchema>;
export type Pipeline = z.infer<typeof pipelineSchema>;

/** Engine run/step state machine (server-owned; shared for the run view). */
export type PipelineStepStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'awaiting-approval';

export type PipelineRunStatus = 'idle' | 'running' | 'completed' | 'aborted' | 'failed' | 'uncertain';

export interface PipelineStepRecord {
  stepId: string;
  name: string;
  type: PipelineStep['type'];
  status: PipelineStepStatus;
  startedAt?: number;
  finishedAt?: number;
  /** Expanded template text sent to the session (prompt/steer steps). */
  input?: string;
  /** Last assistant text produced by this step (for match and vars). */
  output?: string;
  /** Last tool output text produced while this step was running. */
  toolOutput?: string;
  error?: string;
  attempts?: number;
}

export interface PipelineRunRecord {
  runId: string;
  pipelineId: string;
  pipelineName: string;
  status: PipelineRunStatus;
  input: string;
  startedAt: number;
  finishedAt?: number;
  steps: PipelineStepRecord[];
}

/* ---- P1-08b: right workbench file listing ---- */
export interface FileEntry {
  name: string;
  path: string;
  kind: 'dir' | 'file' | 'other';
  size?: number;
  mtime?: number;
}

export interface FileListing {
  root: string;
  entries: FileEntry[];
  recent: Array<{ path: string; action: string }>;
}

/* ---- P1-08b: git worktree changes ---- */
export interface GitChange {
  path: string;
  index: string;
  worktree: string;
  kind: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted' | 'other';
  staged: boolean;
}
