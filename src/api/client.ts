import type {
  AgentMessage,
  EntriesResponse,
  ExtensionUiRequest,
  ExtensionUiResponse,
  FileListing,
  ModelInfo,
  PiCommand,
  Pipeline,
  PipelineRunRecord,
  RpcResponse,
  RpcState,
  SessionDetail,
  SessionStats,
  SessionSummary,
  SessionTreeResponse,
} from '../../shared/types.js';
import type { CodexSessionDetail, CodexSessionMeta } from '../../server/adapters/codex-history.js';
import type { ClaudeSessionMeta } from '../../server/adapters/claude-history.js';
import type { PromptRecord } from '../../server/prompts.js';
import type { AtomcodeSessionDetail } from '../../server/adapters/atomcode-history.js';
import type { ZcodeSessionDetail, ZcodeSessionMeta } from '../../server/adapters/zcode-history.js';
import { controlTokenHeader } from './controlToken.js';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('Content-Type', 'application/json');
  // SPRINT-2 A1: attach the control token when the server injected one.
  for (const [name, value] of Object.entries(controlTokenHeader())) {
    headers.set(name, value);
  }
  const response = await fetch(path, { ...init, headers });
  const raw = await response.text();
  const parsed = (raw.length === 0 ? null : (JSON.parse(raw) as unknown)) as
    | T
    | { error?: string }
    | null;
  if (!response.ok) {
    const errBody = parsed as { error?: string } | null;
    throw new Error(errBody?.error ?? `HTTP ${String(response.status)} ${response.statusText}`);
  }
  return (parsed ?? {}) as T;
}

export interface SessionListResponse {
  sessions: SessionSummary[];
}

export interface ModelsResponse {
  providers: Array<{ provider: string; models: ModelInfo[] }>;
}

/** One entry of the pi.dev official model catalog (P1-15 C). */
export interface CatalogModel {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  provider?: string;
  reasoning?: boolean;
  input?: string[];
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number;
  maxTokens?: number;
  compat?: Record<string, unknown>;
  thinkingLevelMap?: Record<string, string | null>;
}

export interface MessagesResponse {
  messages: unknown[];
}

export interface PromptImage {
  type: 'image';
  data: string;
  mimeType?: string;
}

export const api = {
  sessions(): Promise<SessionListResponse> {
    return request<SessionListResponse>('/api/sessions');
  },

  sessionDetail(id: string): Promise<SessionDetail> {
    return request<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`);
  },

  stats(): Promise<SessionStats> {
    return request<SessionStats>('/api/stats');
  },

  settings(): Promise<Record<string, unknown>> {
    return request<Record<string, unknown>>('/api/settings');
  },

  // P2-02: LAN access modes + capability scope.
  net(): Promise<{
    mode: 'local' | 'pair' | 'lan';
    caps: { remoteApprove: boolean; remotePrompt: boolean; remoteShell: boolean };
    pairs: Array<{ code: string; expiresAt: number }>;
  }> {
    return request('/api/net');
  },

  netPair(): Promise<{ code: string }> {
    return request('/api/net/pair', { method: 'POST' });
  },

  netRevokePair(code: string): Promise<{ success: boolean }> {
    return request('/api/net/pair/revoke', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
  },

  netSetCap(key: string, value: boolean): Promise<{ success: boolean; caps: unknown }> {
    return request('/api/net/caps', {
      method: 'POST',
      body: JSON.stringify({ key, value }),
    });
  },

  // P2-01: registered agent adapters (metadata for the appearance section).
  adapters(): Promise<{
    adapters: Array<{ kind: string; label: string; version: string | null; defaultColor: string }>;
  }> {
    return request('/api/adapters');
  },

  // P2-01: read-only codex session records (never spawns codex).
  codexSessions(): Promise<{ sessions: CodexSessionMeta[] }> {
    return request('/api/codex/sessions');
  },

  codexSessionDetail(id: string): Promise<CodexSessionDetail> {
    return request(`/api/codex/sessions/${encodeURIComponent(id)}`);
  },

  // ADAPTER2: atomcode + zcode read-only history.
  atomcodeSession(): Promise<{ session: AtomcodeSessionDetail | null }> {
    return request('/api/atomcode/sessions');
  },

  zcodeSessions(): Promise<{ sessions: ZcodeSessionMeta[] }> {
    return request('/api/zcode/sessions');
  },

  zcodeSessionDetail(id: string): Promise<ZcodeSessionDetail> {
    return request(`/api/zcode/sessions/${encodeURIComponent(id)}`);
  },

  models(): Promise<ModelsResponse> {
    return request<ModelsResponse>('/api/models');
  },

  rpcState(): Promise<RpcState> {
    return request<RpcState>('/api/rpc/state');
  },

  rpcMessages(): Promise<MessagesResponse> {
    return request<MessagesResponse>('/api/rpc/messages');
  },

  rpcEntries(): Promise<EntriesResponse> {
    return request<EntriesResponse>('/api/rpc/entries');
  },

  // P1-05: session tree DAG of the current RPC session (get_tree passthrough).
  rpcTree(): Promise<SessionTreeResponse> {
    return request<SessionTreeResponse>('/api/rpc/tree');
  },

  // Extension UI protocol (P1-01)
  uiRequests(): Promise<{ requests: ExtensionUiRequest[] }> {
    return request<{ requests: ExtensionUiRequest[] }>('/api/rpc/ui-requests');
  },

  respondUi(response: ExtensionUiResponse): Promise<{ success: boolean }> {
    return request<{ success: boolean }>('/api/rpc/ui-respond', {
      method: 'POST',
      body: JSON.stringify(response),
    });
  },

  prompt(
    message: string,
    streamingBehavior?: 'steer' | 'followUp',
    images?: PromptImage[],
  ): Promise<RpcResponse> {
    return request<RpcResponse>('/api/rpc/prompt', {
      method: 'POST',
      body: JSON.stringify({
        message,
        ...(streamingBehavior === undefined ? {} : { streamingBehavior }),
        ...(images === undefined || images.length === 0 ? {} : { images }),
      }),
    });
  },

  steer(message: string): Promise<RpcResponse> {
    return request<RpcResponse>('/api/rpc/steer', {
      method: 'POST',
      body: JSON.stringify({ message }),
    });
  },

  abort(): Promise<RpcResponse> {
    return request<RpcResponse>('/api/rpc/abort', { method: 'POST' });
  },

  setModel(provider: string, modelId: string): Promise<RpcResponse> {
    return request<RpcResponse>('/api/rpc/model', {
      method: 'POST',
      body: JSON.stringify({ provider, modelId }),
    });
  },

  setThinkingLevel(level: string): Promise<RpcResponse> {
    return request<RpcResponse>('/api/rpc/thinking', {
      method: 'POST',
      body: JSON.stringify({ level }),
    });
  },

  switchSession(sessionPath: string): Promise<RpcResponse> {
    return request<RpcResponse>('/api/rpc/switch_session', {
      method: 'POST',
      body: JSON.stringify({ sessionPath }),
    });
  },

  newSession(): Promise<RpcResponse> {
    return request<RpcResponse>('/api/rpc/new_session', { method: 'POST' });
  },

  forkSession(entryId: string): Promise<RpcResponse> {
    return request<RpcResponse>('/api/rpc/fork', {
      method: 'POST',
      body: JSON.stringify({ entryId }),
    });
  },

  cloneSession(): Promise<RpcResponse> {
    return request<RpcResponse>('/api/rpc/clone', { method: 'POST' });
  },

  cycleModel(): Promise<RpcResponse> {
    return request<RpcResponse>('/api/rpc/cycle-model', { method: 'POST' });
  },

  setSteeringMode(mode: string): Promise<RpcResponse> {
    return request<RpcResponse>('/api/rpc/steering-mode', {
      method: 'POST',
      body: JSON.stringify({ mode }),
    });
  },

  setFollowUpMode(mode: string): Promise<RpcResponse> {
    return request<RpcResponse>('/api/rpc/follow-up-mode', {
      method: 'POST',
      body: JSON.stringify({ mode }),
    });
  },

  deleteSession(fileName: string): Promise<{ success: boolean; error?: string }> {
    return request<{ success: boolean; error?: string }>('/api/sessions/delete', {
      method: 'POST',
      body: JSON.stringify({ fileName }),
    });
  },

  renameSession(name: string): Promise<RpcResponse> {
    return request<RpcResponse>('/api/rpc/rename', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  },

  bash(command: string): Promise<RpcResponse> {
    return request<RpcResponse>('/api/rpc/bash', {
      method: 'POST',
      body: JSON.stringify({ command }),
    });
  },

  abortBash(): Promise<RpcResponse> {
    return request<RpcResponse>('/api/rpc/abort-bash', { method: 'POST' });
  },

  compact(): Promise<RpcResponse> {
    return request<RpcResponse>('/api/rpc/compact', { method: 'POST' });
  },

  setAutoCompaction(enabled: boolean): Promise<RpcResponse> {
    return request<RpcResponse>('/api/rpc/auto-compaction', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    });
  },

  /** P1-02 S2: auto-retry toggle (pi set_auto_retry). */
  setAutoRetry(enabled: boolean): Promise<RpcResponse> {
    return request<RpcResponse>('/api/rpc/auto-retry', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    });
  },

  sessionStats(): Promise<unknown> {
    return request<unknown>('/api/rpc/session-stats');
  },

  exportHtml(): Promise<RpcResponse> {
    return request<RpcResponse>('/api/rpc/export-html', { method: 'POST' });
  },

  saveModel(provider: string, modelId: string): Promise<{ success: boolean }> {
    return request<{ success: boolean }>('/api/settings/model', {
      method: 'POST',
      body: JSON.stringify({ provider, modelId }),
    });
  },

  modelsConfig(): Promise<Record<string, unknown>> {
    return request<Record<string, unknown>>('/api/models-config');
  },

  saveModelsConfig(config: Record<string, unknown>): Promise<{ success: boolean; reload?: 'reloaded' | 'deferred' }> {
    return request<{ success: boolean; reload?: 'reloaded' | 'deferred' }>('/api/models-config', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  },

  /** P1-03: read-only file preview within the workspace root. */
  filePreview(path: string): Promise<{ path: string; size: number; content: string }> {
    return request<{ path: string; size: number; content: string }>(
      `/api/file/preview?path=${encodeURIComponent(path)}`,
    );
  },

  /** P1-08b: read-only directory listing of the session's workspace. */
  listFiles(path: string, session?: string): Promise<FileListing> {
    const params = new URLSearchParams({ path });
    if (session !== undefined && session.length > 0) {
      params.set('session', session);
    }
    return request<FileListing>(`/api/files?${params.toString()}`);
  },

  /** pi.dev official per-provider model catalog (P1-15 C). */
  catalogModels(provider: string): Promise<CatalogModel[]> {
    return request<Record<string, unknown>>(`/api/models/catalog/${encodeURIComponent(provider)}`).then(
      (data) =>
        Object.values(data).filter(
          (value): value is CatalogModel =>
            typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string',
        ),
    );
  },

  /** P1-17 C: fetch the channel's OWN model list (`{baseUrl}/models`). */
  fetchChannelModels(params: {
    baseUrl: string;
    apiKey: string;
    api: string;
  }): Promise<CatalogModel[]> {
    return request<{ models: CatalogModel[] }>('/api/models/fetch', {
      method: 'POST',
      body: JSON.stringify(params),
    }).then((response) => response.models);
  },

  commands(): Promise<PiCommand[]> {
    return request<{ commands: PiCommand[] }>('/api/rpc/commands').then((response) => response.commands);
  },

  /* ---- pipelines (P1-02-C) ---- */

  pipelines(): Promise<{ pipelines: Pipeline[] }> {
    return request<{ pipelines: Pipeline[] }>('/api/pipelines');
  },

  savePipeline(pipeline: Pipeline): Promise<{ pipeline: Pipeline }> {
    return request<{ pipeline: Pipeline }>('/api/pipelines', {
      method: 'POST',
      body: JSON.stringify({ pipeline }),
    });
  },

  deletePipeline(id: string): Promise<{ success: boolean }> {
    return request<{ success: boolean }>(`/api/pipelines/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  pipelineRuns(): Promise<{ runs: PipelineRunRecord[] }> {
    return request<{ runs: PipelineRunRecord[] }>('/api/pipelines/runs');
  },

  runPipeline(pipelineId: string, input?: string): Promise<{ run: PipelineRunRecord }> {
    return request<{ run: PipelineRunRecord }>('/api/pipelines/run', {
      method: 'POST',
      body: JSON.stringify({
        pipelineId,
        ...(input === undefined || input.length === 0 ? {} : { input }),
      }),
    });
  },

  abortPipelineRun(runId: string): Promise<{ success: boolean }> {
    return request<{ success: boolean }>(`/api/pipelines/runs/${encodeURIComponent(runId)}/abort`, {
      method: 'POST',
    });
  },

  approvePipelineRun(runId: string, approve: boolean): Promise<{ success: boolean }> {
    return request<{ success: boolean }>(`/api/pipelines/runs/${encodeURIComponent(runId)}/approve`, {
      method: 'POST',
      body: JSON.stringify({ approve }),
    });
  },

  /* ---- skill → pipeline conversion (P1-10 A) ---- */

  convertPipelineHard(commandName: string): Promise<{ pipeline: Pipeline }> {
    return request<{ pipeline: Pipeline }>('/api/pipelines/convert/hard', {
      method: 'POST',
      body: JSON.stringify({ commandName }),
    });
  },

  convertPipelineSoft(commandName: string): Promise<{ pipeline: Pipeline }> {
    return request<{ pipeline: Pipeline }>('/api/pipelines/convert/soft', {
      method: 'POST',
      body: JSON.stringify({ commandName }),
    });
  },

  /* ---- demo showcase player (showcase sprint) ---- */

  demoPlay(): Promise<{ phase: string }> {
    return request<{ phase: string }>('/api/demo/play', { method: 'POST' });
  },

  demoStop(): Promise<{ phase: string }> {
    return request<{ phase: string }>('/api/demo/stop', { method: 'POST' });
  },

  /* ---- codex exec adapter (ACTIVE) ---- */

  claudeSessionDetail(sessionId: string): Promise<{ turns: Array<{ role: string; text: string; timestamp: string }> }> {
    return request<{ turns: Array<{ role: string; text: string; timestamp: string }> }>(
      `/api/claude/sessions/${encodeURIComponent(sessionId)}`,
    );
  },

  prompts(query?: { q?: string; agent?: string; limit?: number }): Promise<{ prompts: PromptRecord[] }> {
    const params = new URLSearchParams();
    if (query?.q !== undefined) {
      params.set('q', query.q);
    }
    if (query?.agent !== undefined) {
      params.set('agent', query.agent);
    }
    if (query?.limit !== undefined) {
      params.set('limit', String(query.limit));
    }
    const suffix = params.toString().length > 0 ? `?${params.toString()}` : '';
    return request<{ prompts: PromptRecord[] }>(`/api/prompts${suffix}`);
  },

  claudeSessions(): Promise<{ sessions: ClaudeSessionMeta[] }> {
    return request<{ sessions: ClaudeSessionMeta[] }>('/api/claude/sessions');
  },

  codexState(): Promise<{ running: boolean; sessionId: string | null }> {
    return request<{ running: boolean; sessionId: string | null }>('/api/codex/state');
  },

  codexPrompt(message: string): Promise<{ success: boolean }> {
    return request<{ success: boolean }>('/api/codex/prompt', {
      method: 'POST',
      body: JSON.stringify({ message }),
    });
  },

  codexAbort(): Promise<{ success: boolean }> {
    return request<{ success: boolean }>('/api/codex/abort', { method: 'POST' });
  },

  codexMessages(threadId?: string): Promise<{ messages: AgentMessage[] }> {
    const query = threadId === undefined ? '' : `?thread=${encodeURIComponent(threadId)}`;
    return request<{ messages: AgentMessage[] }>(`/api/codex/messages${query}`);
  },

  codexSwitchSession(sessionId: string): Promise<{ success: boolean }> {
    return request<{ success: boolean }>('/api/codex/session', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    });
  },

  /* ---- about (published version) ---- */

  health(): Promise<{ status: string; name: string; version: string; time: string }> {
    return request<{ status: string; name: string; version: string; time: string }>('/api/health');
  },
};
