/**
 * dsh web client — PiHub connects to a running `dsh --profile web` instance
 * (local or, with --trusted-host, remote) over its /api RPC transport.
 *
 * Protocol (from @deepseek-ai/dsh-host-apiproxy):
 *  - unary:   POST /api/<method>  body {type:"client-request", rpcId, method,
 *             payload} → JSON {type:"server-response", rpcId, result:
 *             {ok:true,value}|{ok:false,error}}
 *  - events:  WebSocket /api/events.mux (+ /api/events.host), carrying JSON
 *             `{type:"server-request", rpcId, method, payload:<frame>}` frames
 *
 * Security: this client NEVER calls credentials.* methods (key handling stays
 * host-side); the browser-trust fence passes loopback clients without extra
 * setup, and remote clients must be admitted via the host's --trusted-host.
 */
import { randomUUID } from 'node:crypto';

export interface DshWebClientOptions {
  /** Base URL of the dsh web instance, e.g. http://127.0.0.1:3080. */
  baseUrl: string;
  /** Per-request timeout (ms). Default 15s. */
  timeoutMs?: number;
}

export interface DshWebDescribe {
  version: string;
  cwd: string;
  provider?: string;
  model?: string;
  attachedSessions: number;
  canOpenPath: boolean;
}

export interface DshWebSessionRow {
  id: string;
  title?: string;
  cwd?: string;
  createdAt?: number;
  updatedAt?: number;
  [key: string]: unknown;
}

export interface DshWebMuxEvent {
  type: string;
  sessionId?: string;
  event?: Record<string, unknown>;
  [key: string]: unknown;
}

interface RpcResult {
  ok: boolean;
  value?: unknown;
  error?: { code?: string; message?: string };
}

export class DshWebClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: DshWebClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /** POST a unary RPC and parse the server-response envelope. */
  async call(method: string, payload: Record<string, unknown> = {}): Promise<RpcResult> {
    const message = {
      type: 'client-request',
      rpcId: randomUUID(),
      method,
      payload,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      return {
        ok: false,
        error: {
          code: 'transport',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    clearTimeout(timer);
    if (!response.ok) {
      return {
        ok: false,
        error: { code: 'http', message: `HTTP ${String(response.status)} from dsh web` },
      };
    }
    let full: unknown;
    try {
      full = await response.json();
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'parse',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    if (full === null || typeof full !== 'object') {
      return { ok: false, error: { code: 'parse', message: 'server-response is not an object' } };
    }
    const record = full as Record<string, unknown>;
    if (record['type'] !== 'server-response') {
      return { ok: false, error: { code: 'parse', message: `unexpected envelope: ${String(record['type'])}` } };
    }
    const result = record['result'];
    if (result === null || typeof result !== 'object') {
      return { ok: false, error: { code: 'parse', message: 'server-response has no result' } };
    }
    const resultRecord = result as Record<string, unknown>;
    if (resultRecord['ok'] === true) {
      return { ok: true, value: resultRecord['value'] };
    }
    const errorRecord =
      resultRecord['error'] !== null && typeof resultRecord['error'] === 'object'
        ? (resultRecord['error'] as Record<string, unknown>)
        : {};
    return {
      ok: false,
      error: {
        code: typeof errorRecord['code'] === 'string' ? errorRecord['code'] : 'rpc',
        message:
          typeof errorRecord['message'] === 'string'
            ? errorRecord['message']
            : 'dsh web RPC failed',
      },
    };
  }

  async describe(): Promise<RpcResult> {
    return this.call('host.describe');
  }

  async listSessions(cursor?: string): Promise<RpcResult> {
    return this.call('session.list', cursor === undefined ? {} : { cursor });
  }

  async sessionHistory(sessionId: string): Promise<RpcResult> {
    const result = await this.call('session.history', { sessionId });
    if (!result.ok) {
      return result;
    }
    return { ok: true, value: normalizeDshHistory(result.value) };
  }

  /** Queue a prompt on an existing session (mode queue = the agent picks it
   *  up in order; steer = immediate interject). */
  async prompt(sessionId: string, text: string, mode: 'queue' | 'steer' = 'queue'): Promise<RpcResult> {
    return this.call('session.prompt', {
      sessionId,
      mode,
      content: [{ type: 'text', text }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  }

  async cancel(sessionId: string): Promise<RpcResult> {
    return this.call('session.cancel', { sessionId });
  }

  /** Create a real dsh session (cwd optional; server default). */
  async createSession(cwd?: string): Promise<RpcResult> {
    return this.call('session.create', cwd === undefined ? {} : { cwd });
  }

  /** Answer a pending approval: POST /api/respond with a client-response
   *  envelope echoing the server-request rpcId (approval/requested frame). */
  async respond(
    rpcId: string,
    sessionId: string,
    approvalId: string,
    outcome: 'allowed-once' | 'rejected',
  ): Promise<{ accepted: boolean; reason?: string }> {
    const message = {
      type: 'client-response',
      rpcId,
      result: { ok: true, value: { sessionId, approvalId, outcome } },
    };
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/api/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      if (!response.ok) {
        return { accepted: false, reason: `HTTP ${String(response.status)}` };
      }
      const parsed = (await response.json()) as { accepted?: boolean; reason?: string };
      if (parsed.accepted === true) {
        return { accepted: true };
      }
      return { accepted: false, reason: parsed.reason ?? 'not accepted' };
    } catch (error) {
      return {
        accepted: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async models(): Promise<RpcResult> {
    return this.call('llm.models');
  }

  /** Open the real-time event streams (mux + host) via WebSocket (the /api
   *  gateway answers plain GET with 426 "upgrade required"). Returns a
   *  disposer. Frames arrive as `{type:"server-request", rpcId, method,
   *  payload:<frame>}` JSON messages; the payload + envelope rpcId (needed
   *  to answer approvals via /api/respond) are handed to onFrame. */
  openEvents(
    onFrame: (frame: DshWebMuxEvent, rpcId: string) => void,
    onError?: (error: Error) => void,
  ): () => void {
    if (typeof WebSocket !== 'function') {
      onError?.(new Error('WebSocket is not available in this Node runtime'));
      return () => undefined;
    }
    const sockets: WebSocket[] = [];
    const openStream = (path: string): void => {
      const wsUrl = this.baseUrl.replace(/^http/, 'ws') + path;
      let socket: WebSocket;
      try {
        socket = new WebSocket(wsUrl);
      } catch (error) {
        onError?.(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      sockets.push(socket);
      socket.addEventListener('message', (event) => {
        const raw = typeof event.data === 'string' ? event.data : null;
        if (raw === null) {
          return;
        }
        let envelope: unknown;
        try {
          envelope = JSON.parse(raw) as unknown;
        } catch {
          return;
        }
        if (envelope === null || typeof envelope !== 'object') {
          return;
        }
        const payload = (envelope as Record<string, unknown>)['payload'];
        const rpcId =
          typeof (envelope as Record<string, unknown>)['rpcId'] === 'string'
            ? String((envelope as Record<string, unknown>)['rpcId'])
            : '';
        if (payload !== null && typeof payload === 'object') {
          onFrame(payload as DshWebMuxEvent, rpcId);
        }
      });
      socket.addEventListener('error', () => {
        onError?.(new Error(`events stream ${path}: websocket error`));
      });
      socket.addEventListener('close', (event) => {
        if (event.code !== 1000 && event.code !== 1005) {
          onError?.(new Error(`events stream ${path}: closed (${String(event.code)})`));
        }
      });
    };
    openStream('/api/events.mux');
    openStream('/api/events.host');
    return () => {
      for (const socket of sockets) {
        socket.close();
      }
    };
  }
}

/** Convert DSH's append-only event ledger into the stable transcript shape
 * consumed by both pi-panel and PiHub-CHUI. Protocol-specific event records
 * never leak across the PiHub backend boundary. */
export function normalizeDshHistory(value: unknown): Array<{
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
}> {
  if (value === null || typeof value !== 'object') {
    return [];
  }
  const events = (value as { events?: unknown }).events;
  if (!Array.isArray(events)) {
    return [];
  }
  const transcript: Array<{
    id: string;
    role: 'user' | 'assistant';
    text: string;
    timestamp: number;
  }> = [];
  for (const row of events) {
    if (row === null || typeof row !== 'object') {
      continue;
    }
    const event = (row as { event?: unknown }).event;
    if (event === null || typeof event !== 'object') {
      continue;
    }
    const record = event as Record<string, unknown>;
    const type = record['type'];
    const data = record['data'];
    if ((type !== 'user/message' && type !== 'assistant/message') || data === null || typeof data !== 'object') {
      continue;
    }
    const dataRecord = data as Record<string, unknown>;
    const message = type === 'assistant/message' ? dataRecord['message'] : dataRecord;
    if (message === null || typeof message !== 'object') {
      continue;
    }
    const messageRecord = message as Record<string, unknown>;
    const content = messageRecord['content'];
    if (!Array.isArray(content)) {
      continue;
    }
    const text = content
      .filter((part): part is Record<string, unknown> => part !== null && typeof part === 'object')
      .filter((part) => part['type'] === 'text' && typeof part['text'] === 'string')
      .map((part) => String(part['text']))
      .join('\n');
    if (text.length === 0) {
      continue;
    }
    const sequence = typeof record['seq'] === 'number' || typeof record['seq'] === 'string'
      ? String(record['seq'])
      : String(transcript.length);
    transcript.push({
      id: typeof messageRecord['id'] === 'string'
        ? messageRecord['id']
        : `dsh-${sequence}`,
      role: type === 'user/message' ? 'user' : 'assistant',
      text,
      timestamp: typeof record['time'] === 'number' ? record['time'] : Date.now(),
    });
  }
  return transcript;
}
