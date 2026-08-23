import type { DshWebDescribe, DshWebMuxEvent } from './dsh-web-client.js';
import { DshWebClient } from './dsh-web-client.js';

export const DEFAULT_DSH_WEB_URL = 'http://127.0.0.1:3080';

export interface DshWebRuntimeStatus {
  connected: boolean;
  state: 'connected' | 'connecting' | 'reconnecting' | 'disconnected';
  url: string | null;
  protocol: 'dsh-web-rpc-v1';
  describe: DshWebDescribe | null;
  lastError: string | null;
}

export interface DshPendingApproval {
  rpcId: string;
  sessionId: string;
  approvalId: string;
  summary: string;
  timestamp: number;
}

interface DshWebRuntimeOptions {
  onFrame: (frame: DshWebMuxEvent, rpcId: string) => void;
  onError?: (error: Error) => void;
  reconnectDelayMs?: number;
  clientFactory?: (url: string) => DshWebClient;
}

/**
 * Owns one resilient connection to the DSH Web RPC gateway. Unary calls and
 * event sockets deliberately share the same probed client so callers never
 * report "connected" from configuration alone.
 */
export class DshWebRuntime {
  private readonly onFrame: DshWebRuntimeOptions['onFrame'];
  private readonly onError: NonNullable<DshWebRuntimeOptions['onError']>;
  private readonly reconnectDelayMs: number;
  private readonly clientFactory: NonNullable<DshWebRuntimeOptions['clientFactory']>;
  private clientValue: DshWebClient | null = null;
  private desiredUrl: string | null = null;
  private describeValue: DshWebDescribe | null = null;
  private lastErrorValue: string | null = null;
  private disposeEvents: (() => void) | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private generation = 0;
  private connecting = false;
  private reconnecting = false;
  private closed = false;
  private readonly pendingApprovalValues = new Map<string, DshPendingApproval>();

  constructor(options: DshWebRuntimeOptions) {
    this.onFrame = options.onFrame;
    this.onError = options.onError ?? (() => undefined);
    this.reconnectDelayMs = options.reconnectDelayMs ?? 2_500;
    this.clientFactory = options.clientFactory ?? ((url) => new DshWebClient({ baseUrl: url }));
  }

  client(): DshWebClient | null {
    return this.clientValue;
  }

  pendingApprovals(): DshPendingApproval[] {
    return [...this.pendingApprovalValues.values()];
  }

  resolveApproval(rpcId: string): void {
    this.pendingApprovalValues.delete(rpcId);
  }

  status(): DshWebRuntimeStatus {
    const state = this.clientValue !== null
      ? 'connected'
      : this.connecting
        ? this.reconnecting
          ? 'reconnecting'
          : 'connecting'
        : 'disconnected';
    return {
      connected: this.clientValue !== null,
      state,
      url: this.desiredUrl,
      protocol: 'dsh-web-rpc-v1',
      describe: this.describeValue,
      lastError: this.lastErrorValue,
    };
  }

  start(url = DEFAULT_DSH_WEB_URL): void {
    this.desiredUrl = normalizeUrl(url);
    void this.connect(this.desiredUrl).then((result) => {
      if (!result.ok) {
        this.scheduleReconnect();
      }
    });
  }

  async connect(url: string): Promise<{ ok: boolean; error?: string }> {
    const normalized = normalizeUrl(url);
    const previousUrl = this.desiredUrl;
    this.closed = false;
    this.desiredUrl = normalized;
    this.connecting = true;
    const attempt = ++this.generation;
    const candidate = this.clientFactory(normalized);
    const describe = await candidate.describe();
    if (attempt !== this.generation) {
      return { ok: false, error: 'connection attempt superseded' };
    }
    this.connecting = false;
    this.reconnecting = false;
    if (!describe.ok) {
      const message = describe.error?.message ?? 'dsh web unreachable';
      this.lastErrorValue = message;
      if (this.clientValue !== null) {
        this.desiredUrl = previousUrl;
      }
      return { ok: false, error: message };
    }
    const parsed = parseDescribe(describe.value);
    if (parsed === null) {
      const message = 'host.describe returned an incompatible payload';
      this.lastErrorValue = message;
      if (this.clientValue !== null) {
        this.desiredUrl = previousUrl;
      }
      return { ok: false, error: message };
    }
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearConnection(false);
    this.clientValue = candidate;
    this.describeValue = parsed;
    this.lastErrorValue = null;
    const activeGeneration = this.generation;
    this.disposeEvents = candidate.openEvents((frame, rpcId) => {
      const approval = parsePendingApproval(frame, rpcId);
      if (approval !== null) {
        this.pendingApprovalValues.set(approval.rpcId, approval);
      }
      this.onFrame(frame, rpcId);
    }, (error) => {
      if (activeGeneration !== this.generation || this.closed) {
        return;
      }
      this.lastErrorValue = error.message;
      this.onError(error);
      this.clearConnection(false);
      this.scheduleReconnect();
    });
    return { ok: true };
  }

  disconnect(): void {
    this.closed = true;
    this.desiredUrl = null;
    this.generation += 1;
    this.clearConnection(true);
  }

  close(): void {
    this.disconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.desiredUrl === null || this.reconnectTimer !== null) {
      return;
    }
    this.reconnecting = true;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      const url = this.desiredUrl;
      if (url === null || this.closed) {
        return;
      }
      void this.connect(url).then((result) => {
        if (!result.ok) {
          this.scheduleReconnect();
        }
      });
    }, this.reconnectDelayMs);
    this.reconnectTimer.unref();
  }

  private clearConnection(clearTimer: boolean): void {
    this.disposeEvents?.();
    this.disposeEvents = null;
    this.clientValue = null;
    this.describeValue = null;
    if (clearTimer && this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (clearTimer) {
      this.pendingApprovalValues.clear();
      this.connecting = false;
      this.reconnecting = false;
    }
  }
}

export function parsePendingApproval(
  frame: DshWebMuxEvent,
  rpcId: string,
): DshPendingApproval | null {
  const eventRecord = frame.event ?? null;
  const data = eventRecord?.['data'];
  const dataRecord = data !== null && typeof data === 'object'
    ? data as Record<string, unknown>
    : null;
  const eventType = typeof eventRecord?.['type'] === 'string' ? eventRecord['type'] : '';
  if (frame.type !== 'approval/requested' && eventType !== 'approval/requested') {
    return null;
  }
  if (rpcId.length === 0) {
    return null;
  }
  const sessionId = typeof frame['sessionId'] === 'string'
    ? frame['sessionId']
    : typeof dataRecord?.['sessionId'] === 'string'
      ? dataRecord['sessionId']
      : '';
  const approvalId = typeof frame['approvalId'] === 'string'
    ? frame['approvalId']
    : typeof dataRecord?.['approvalId'] === 'string'
      ? dataRecord['approvalId']
      : '';
  if (sessionId.length === 0 || approvalId.length === 0) {
    return null;
  }
  const summaryValue = dataRecord?.['summary'] ?? dataRecord?.['description'] ?? frame['message'];
  return {
    rpcId,
    sessionId,
    approvalId,
    summary: typeof summaryValue === 'string' ? summaryValue : 'DSH 请求执行受保护操作',
    timestamp: typeof frame['timestamp'] === 'number' ? frame['timestamp'] : Date.now(),
  };
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function parseDescribe(value: unknown): DshWebDescribe | null {
  if (value === null || typeof value !== 'object') {
    return null;
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row['version'] !== 'string' ||
    typeof row['cwd'] !== 'string' ||
    typeof row['attachedSessions'] !== 'number' ||
    typeof row['canOpenPath'] !== 'boolean'
  ) {
    return null;
  }
  return {
    version: row['version'],
    cwd: row['cwd'],
    attachedSessions: row['attachedSessions'],
    canOpenPath: row['canOpenPath'],
    ...(typeof row['provider'] === 'string' ? { provider: row['provider'] } : {}),
    ...(typeof row['model'] === 'string' ? { model: row['model'] } : {}),
  };
}
