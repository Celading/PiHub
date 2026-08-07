import type {
  EntriesResponse,
  ExtensionUiRequest,
  ExtensionUiResponse,
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('Content-Type', 'application/json');
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
};
