import type {
  ModelInfo,
  PiCommand,
  RpcResponse,
  RpcState,
  SessionDetail,
  SessionStats,
  SessionSummary,
} from '../../shared/types.js';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `HTTP ${String(response.status)} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

export interface SessionListResponse {
  sessions: SessionSummary[];
}

export interface ModelsResponse {
  providers: Array<{ provider: string; models: ModelInfo[] }>;
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

  commands(): Promise<PiCommand[]> {
    return request<{ commands: PiCommand[] }>('/api/rpc/commands').then((response) => response.commands);
  },
};
