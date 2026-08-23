import type {
  AgentMessage,
  EntriesResponse,
  ExtensionUiRequest,
  ExtensionUiResponse,
  FileListing,
  GitChange,
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
import { withPair } from './pairToken.js';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('Content-Type', 'application/json');
  // SPRINT-2 A1: attach the control token when the server injected one.
  for (const [name, value] of Object.entries(controlTokenHeader())) {
    headers.set(name, value);
  }
  // P2-02: remote peers present their pairing code as a query param.
  const response = await fetch(withPair(path), { ...init, headers });
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

/** Embedded dsh kernel settings surface (no credentials ever leave the server). */
export interface DshSettingsInfo {
  available: boolean;
  dshVersion: string;
  nodeVersion: string;
  home: string | null;
  provider: string | null;
  model: string | null;
  models: string[];
  baseURL: string | null;
  apiKeyEnv: string | null;
  hasKey: boolean;
  patchPath: string | null;
}

/** One external (terminal-side) agent session from the shared stream. */
export interface ExternalSessionEntry {
  agent: 'pi' | 'codex' | 'dsh';
  sessionId: string;
  workspace: string;
  lastActivity: number;
  lastText: string;
  file: string;
}

/** One dsh session row from the auto-discovered history. */
export interface DshSessionRow {
  sessionId: string;
  updatedAt: number;
  cwd: string;
  running: boolean;
  agentPreset?: string;
  source: 'web' | 'files';
}

/** One managed agent row (panel-side startup/config). */
export interface AgentManageRow {
  kind: 'pi' | 'codex' | 'dsh' | 'claude';
  available: boolean;
  enabled: boolean;
  running: boolean;
  binary: string | null;
  version: string | null;
  lifecycle: string;
  config: { binary?: string; enabled?: boolean };
}

/** One-click install status for an agent. */
export interface AgentInstallStatus {
  plan: { command: string[]; label: string } | null;
  running: boolean;
  exit: number | null;
  output: string;
}

export interface PiAgentSettingsInfo {
  settings: Record<string, unknown>;
  workspace: string | null;
  agentHome: string;
  settingsFile: string;
  nodeVersion: string;
  privateSpace: boolean;
  runtime: {
    kind: 'pi';
    available: boolean;
    binary: string | null;
    version: string | null;
    sessionDir: string | null;
    home: string | null;
  } | null;
  managed: AgentManageRow | null;
}

export type RuntimeCapabilityStatus = 'ready' | 'degraded' | 'blocked' | 'unavailable';
export type ServiceTargetId = 'builtin-pihub' | 'local-service' | 'remote-pihub' | 'nearby-pihub';

export interface RuntimeEngineCapability {
  engine: 'pi' | 'dsh';
  label: string;
  status: RuntimeCapabilityStatus;
  available: boolean;
  ready: boolean;
  canCreateSession: boolean;
  checks: string[];
  reason: string | null;
}

export interface RuntimeServiceCapability {
  id: ServiceTargetId;
  kind: 'builtin' | 'local' | 'remote' | 'nearby';
  label: string;
  status: RuntimeCapabilityStatus;
  sessionCreation: 'supported' | 'configuration-required' | 'connection-required';
  canCreateSession: boolean;
  reason: string | null;
  endpoint: string | null;
}

export interface RuntimeCapabilitiesResponse {
  mode: 'production' | 'debug' | 'demo';
  checkedAt: string;
  engines: RuntimeEngineCapability[];
  services: RuntimeServiceCapability[];
  defaultEngine: 'pi';
  fallbackEngine: 'dsh';
  debug: Record<string, unknown> | null;
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

  piAgentSettings(): Promise<PiAgentSettingsInfo> {
    return request<PiAgentSettingsInfo>('/api/pi-agent/settings');
  },

  savePiAgentSettings(
    settings: Record<string, unknown>,
  ): Promise<{
    success: boolean;
    settings: Record<string, unknown>;
    reload: 'reloaded' | 'deferred';
  }> {
    return request('/api/pi-agent/settings', {
      method: 'PUT',
      body: JSON.stringify({ settings }),
    });
  },

  // Settings system prompt: preview + edit + save (owner spec).
  systemPrompt(): Promise<{ prompt: string }> {
    return request<{ prompt: string }>('/api/system-prompt');
  },

  saveSystemPrompt(prompt: string): Promise<{ success: boolean; error?: string }> {
    return request('/api/system-prompt', {
      method: 'PUT',
      body: JSON.stringify({ prompt }),
    });
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

  runtimeCapabilities(): Promise<RuntimeCapabilitiesResponse> {
    return request<RuntimeCapabilitiesResponse>('/api/runtime/capabilities');
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

  /** New session with optional targeting (chosen folder + agent). */
  newSession(
    params?: { cwd?: string; agent?: string; serviceTarget?: ServiceTargetId },
  ): Promise<RpcResponse & { cwd?: string; agent?: string }> {
    return request<RpcResponse & { cwd?: string; agent?: string }>('/api/rpc/new_session', {
      method: 'POST',
      body: JSON.stringify({
        ...(params?.cwd !== undefined && params.cwd.length > 0 ? { cwd: params.cwd } : {}),
        ...(params?.agent !== undefined ? { agent: params.agent } : {}),
        ...(params?.serviceTarget !== undefined ? { serviceTarget: params.serviceTarget } : {}),
      }),
    });
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
  filePreview(
    path: string,
    session?: string,
  ): Promise<{ path: string; size: number; content: string }> {
    const params = new URLSearchParams({ path });
    if (session !== undefined && session.length > 0) {
      params.set('session', session);
    }
    return request<{ path: string; size: number; content: string }>(
      `/api/file/preview?${params.toString()}`,
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

  /** P1-08b: read-only git worktree status of the session's cwd. */
  gitStatus(session?: string): Promise<{
    root: string;
    repo: boolean;
    source: 'git' | 'snapshot' | 'none';
    changes: GitChange[];
  }> {
    const params = new URLSearchParams();
    if (session !== undefined && session.length > 0) {
      params.set('session', session);
    }
    const suffix = params.toString().length > 0 ? `?${params.toString()}` : '';
    return request<{
      root: string;
      repo: boolean;
      source: 'git' | 'snapshot' | 'none';
      changes: GitChange[];
    }>(`/api/git/status${suffix}`);
  },

  /** P1-08b: read-only diff of one path (staged or worktree). */
  gitDiff(path: string, session?: string, staged = false): Promise<{
    source: 'git' | 'snapshot' | 'none';
    diff: string;
  }> {
    const params = new URLSearchParams({ path });
    if (session !== undefined && session.length > 0) {
      params.set('session', session);
    }
    if (staged) {
      params.set('staged', '1');
    }
    return request<{ source: 'git' | 'snapshot' | 'none'; diff: string }>(
      `/api/git/diff?${params.toString()}`,
    );
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

  runPipeline(
    pipelineId: string,
    input?: string,
    targeting?: { cwd?: string; agent?: 'pi' | 'codex' },
  ): Promise<{ run: PipelineRunRecord }> {
    return request<{ run: PipelineRunRecord }>('/api/pipelines/run', {
      method: 'POST',
      body: JSON.stringify({
        pipelineId,
        ...(input === undefined || input.length === 0 ? {} : { input }),
        ...(targeting?.cwd !== undefined && targeting.cwd.length > 0 ? { cwd: targeting.cwd } : {}),
        ...(targeting?.agent !== undefined ? { agent: targeting.agent } : {}),
      }),
    });
  },

  /** Subdirectories of an absolute path (session/task folder targeting). */
  dirs(path?: string): Promise<{ path: string; dirs: string[] }> {
    const query = path === undefined || path.length === 0 ? '' : `?path=${encodeURIComponent(path)}`;
    return request<{ path: string; dirs: string[] }>(`/api/dirs${query}`);
  },

  /** Embedded dsh kernel settings (provider/model surface, no credentials). */
  dshSettings(): Promise<DshSettingsInfo> {
    return request<DshSettingsInfo>('/api/dsh/settings');
  },

  /** Terminal-side agent sessions visible through the shared session stream. */
  externalSessions(): Promise<{ sessions: ExternalSessionEntry[] }> {
    return request<{ sessions: ExternalSessionEntry[] }>('/api/external/sessions');
  },

  /** dsh web integration (stage 3): connection status. */
  dshWebStatus(): Promise<{
    connected: boolean;
    state: 'connected' | 'connecting' | 'reconnecting' | 'disconnected';
    url: string | null;
    protocol: 'dsh-web-rpc-v1';
    describe: unknown;
    lastError: string | null;
  }> {
    return request('/api/dsh/web/status');
  },

  /** dsh session history (auto-discovered; 503 when the form disables dsh). */
  dshSessions(): Promise<{ sessions: DshSessionRow[] }> {
    return request<{ sessions: DshSessionRow[] }>('/api/dsh/sessions');
  },

  dshWebConnect(url: string): Promise<{ success: boolean; status: { connected: boolean; url: string | null } }> {
    return request<{ success: boolean; status: { connected: boolean; url: string | null } }>('/api/dsh/web/connect', {
      method: 'POST',
      body: JSON.stringify({ url }),
    });
  },

  dshWebSessions(): Promise<{ sessions: unknown }> {
    return request<{ sessions: unknown }>('/api/dsh/web/sessions');
  },

  dshWebHistory(sessionId: string): Promise<{ history: unknown }> {
    return request<{ history: unknown }>(`/api/dsh/web/history?sessionId=${encodeURIComponent(sessionId)}`);
  },

  dshWebPrompt(
    sessionId: string,
    text: string,
    mode: 'queue' | 'steer' = 'queue',
  ): Promise<{ success: boolean; value?: unknown }> {
    return request<{ success: boolean; value?: unknown }>('/api/dsh/web/prompt', {
      method: 'POST',
      body: JSON.stringify({ sessionId, text, mode }),
    });
  },

  dshWebCancel(sessionId: string): Promise<{ success: boolean }> {
    return request<{ success: boolean }>('/api/dsh/web/cancel', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    });
  },

  dshWebApprove(
    rpcId: string,
    sessionId: string,
    approvalId: string,
    outcome: 'allowed-once' | 'rejected',
  ): Promise<{ success: boolean }> {
    return request<{ success: boolean }>('/api/dsh/web/approve', {
      method: 'POST',
      body: JSON.stringify({ rpcId, sessionId, approvalId, outcome }),
    });
  },

  dshWebCreateSession(cwd?: string): Promise<{ success: boolean; session: unknown }> {
    return request<{ success: boolean; session: unknown }>('/api/dsh/web/session', {
      method: 'POST',
      body: JSON.stringify(cwd === undefined ? {} : { cwd }),
    });
  },

  dshWebModels(): Promise<{ models: unknown }> {
    return request<{ models: unknown }>('/api/dsh/web/models');
  },

  dshWebApprovals(): Promise<{ approvals: unknown }> {
    return request<{ approvals: unknown }>('/api/dsh/web/approvals');
  },

  /** Claude exec adapter: headless per-prompt conversation. */
  claudePrompt(
    message: string,
    cwd?: string,
  ): Promise<{ success: boolean; data?: { answer?: string } }> {
    return request<{ success: boolean; data?: { answer?: string } }>('/api/claude/prompt', {
      method: 'POST',
      body: JSON.stringify({
        message,
        ...(cwd !== undefined && cwd.length > 0 ? { cwd } : {}),
      }),
    });
  },

  claudeAbort(): Promise<{ success: boolean }> {
    return request<{ success: boolean }>('/api/claude/abort', { method: 'POST' });
  },

  claudeState(): Promise<{ running: boolean }> {
    return request<{ running: boolean }>('/api/claude/state');
  },

  claudeMessages(): Promise<{ messages: unknown[] }> {
    return request<{ messages: unknown[] }>('/api/claude/messages');
  },

  /** Agent management (panel-side startup/config). */
  agents(): Promise<{ agents: AgentManageRow[] }> {
    return request<{ agents: AgentManageRow[] }>('/api/agents');
  },

  configureAgent(
    kind: 'pi' | 'codex' | 'dsh' | 'claude',
    patch: { binary?: string; enabled?: boolean },
  ): Promise<{ success: boolean; agents: AgentManageRow[] }> {
    return request<{ success: boolean; agents: AgentManageRow[] }>(`/api/agents/${kind}/configure`, {
      method: 'POST',
      body: JSON.stringify(patch),
    });
  },

  restartPiAgent(): Promise<{ success: boolean }> {
    return request<{ success: boolean }>('/api/agents/pi/restart', { method: 'POST' });
  },

  installAgent(
    kind: 'pi' | 'codex' | 'dsh' | 'claude',
  ): Promise<{ success: boolean; status: AgentInstallStatus }> {
    return request<{ success: boolean; status: AgentInstallStatus }>(`/api/agents/${kind}/install`, {
      method: 'POST',
    });
  },

  agentInstallStatus(kind: string): Promise<{ status: AgentInstallStatus }> {
    return request<{ status: AgentInstallStatus }>(`/api/agents/${encodeURIComponent(kind)}/install`);
  },

  /** Switch the dsh gateway model (rewrites the --patch layer). */
  updateDshSettings(model: string): Promise<{ success: boolean; model: string }> {
    return request<{ success: boolean; model: string }>('/api/dsh/settings', {
      method: 'PUT',
      body: JSON.stringify({ model }),
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

  /* ---- dsh (DeepSeek Harness) embedded kernel (D2) ---- */

  dshPrompt(
    message: string,
    cwd?: string,
  ): Promise<{ success: boolean; data?: { answer?: string; sessionId?: string; mode?: string } }> {
    return request<{ success: boolean; data?: { answer?: string; sessionId?: string; mode?: string } }>(
      '/api/dsh/prompt',
      {
        method: 'POST',
        body: JSON.stringify({
          message,
          ...(cwd !== undefined && cwd.length > 0 ? { cwd } : {}),
        }),
      },
    );
  },

  dshState(): Promise<{ running: boolean }> {
    return request<{ running: boolean }>('/api/dsh/state');
  },

  dshAbort(): Promise<{ success: boolean }> {
    return request<{ success: boolean }>('/api/dsh/abort', { method: 'POST' });
  },

  dshMessages(): Promise<{ messages: unknown[] }> {
    return request<{ messages: unknown[] }>('/api/dsh/messages');
  },

  codexState(): Promise<{ running: boolean; sessionId: string | null }> {
    return request<{ running: boolean; sessionId: string | null }>('/api/codex/state');
  },

  codexPrompt(message: string, cwd?: string): Promise<{ success: boolean }> {
    return request<{ success: boolean }>('/api/codex/prompt', {
      method: 'POST',
      body: JSON.stringify({
        message,
        ...(cwd !== undefined && cwd.length > 0 ? { cwd } : {}),
      }),
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

  health(): Promise<{ status: string; name: string; version: string; build?: string; time: string }> {
    return request<{ status: string; name: string; version: string; build?: string; time: string }>(
      '/api/health',
    );
  },
};
