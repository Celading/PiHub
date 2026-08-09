import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { extensionUiRequestSchema, rpcResponseSchema, rpcStreamEventSchema } from '../shared/schemas.js';
import type { ExtensionUiMethod, ExtensionUiRequest, ExtensionUiResponse, RpcResponse, RpcStreamEvent } from '../shared/types.js';

const MAX_RESTARTS = 3;
const RESTART_BACKOFF_MS = 1000;
const RESPONSE_TIMEOUT_MS = 30_000;

export type RpcCommand =
  | { type: 'prompt'; message: string; streamingBehavior?: 'steer' | 'followUp' }
  | { type: 'steer'; message: string }
  | { type: 'follow_up'; message: string }
  | { type: 'abort' }
  | { type: 'set_model'; provider: string; modelId: string }
  | { type: 'set_thinking_level'; level: string }
  | { type: 'switch_session'; sessionPath: string }
  | { type: 'new_session' }
  | { type: 'fork'; entryId: string }
  | { type: 'clone' }
  | { type: 'set_session_name'; name: string }
  | { type: 'bash'; command: string }
  | { type: 'abort_bash' }
  | { type: 'compact' }
  | { type: 'set_auto_compaction'; enabled: boolean }
  | { type: 'set_auto_retry'; enabled: boolean }
  | { type: 'get_session_stats' }
  | { type: 'export_html'; outputPath?: string }
  | { type: 'get_commands' }
  | { type: 'get_state' }
  | { type: 'get_messages' }
  | { type: 'get_entries'; since?: string }
  | { type: 'get_tree' }
  | { type: 'get_available_models' }
  | { type: 'cycle_model' }
  | { type: 'set_steering_mode'; mode: string }
  | { type: 'set_follow_up_mode'; mode: string }
  | { type: 'get_fork_messages' };

interface PendingRequest {
  resolve: (value: RpcResponse) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

/** Pending extension UI interaction awaiting a frontend answer. */
interface PendingUiRequest {
  request: ExtensionUiRequest;
  timer: NodeJS.Timeout | null;
}

interface RpcBridgeEvents {
  event: (event: RpcStreamEvent) => void;
  response: (response: RpcResponse) => void;
  /** Extension UI interaction (fire-and-forget and dialog requests). */
  'ui-request': (request: ExtensionUiRequest) => void;
  exit: (code: number | null) => void;
  error: (error: Error) => void;
}

/**
 * Manages a `pi --mode rpc` subprocess: JSONL over stdio.
 * - stdout is split strictly on `\n` (trailing `\r` stripped), per the
 *   documented framing (never use readline: U+2028/2029 are valid in JSON).
 * - requests are correlated by id; the response for prompt/steer/etc. arrives
 *   immediately after acceptance while events keep streaming afterwards.
 */
export class RpcBridge extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, PendingRequest>();
  private pendingUi = new Map<string, PendingUiRequest>();
  private nextId = 1;
  private buffer = '';
  private restartCount = 0;
  private stopped = false;
  /** SPRINT-2 B4: per-process monotonic event sequence (event envelope). */
  private sequence = 0;
  /** Current pi session id (from session header events), for the envelope. */
  private sessionId: string | null = null;
  /** Current pipeline run id, when a pipeline step is driving pi. */
  private runId: string | null = null;

  constructor(
    private readonly piBinary: string,
    private readonly cwd: string,
  ) {
    super();
  }

  override on<K extends keyof RpcBridgeEvents>(
    event: K,
    listener: RpcBridgeEvents[K],
  ): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof RpcBridgeEvents>(
    event: K,
    ...args: Parameters<RpcBridgeEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  start(): void {
    if (this.stopped || this.child !== null) {
      return;
    }
    this.child = spawn(this.piBinary, ['--mode', 'rpc'], {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let newlineIndex = this.buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = this.buffer.slice(0, newlineIndex);
        this.buffer = this.buffer.slice(newlineIndex + 1);
        this.handleLine(line);
        newlineIndex = this.buffer.indexOf('\n');
      }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.emit('error', new Error(`pi stderr: ${chunk.trimEnd()}`));
    });
    const exitedChild = this.child;
    this.child.on('exit', (code) => {
      // SPRINT-2 A2: only clear the reference if this is still the current
      // child. A deliberate restart() kills the old process and spawns a new
      // one; if the old process's exit event fires AFTER the new child was
      // assigned, unconditionally nulling this.child would drop the new
      // process (orphan + duplicate pi).
      if (this.child === exitedChild) {
        this.child = null;
      }
      this.emit('exit', code);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`pi process exited with code ${String(code)}`));
      }
      this.pending.clear();
      if (!this.stopped && this.restartCount < MAX_RESTARTS) {
        this.restartCount += 1;
        setTimeout(() => {
          if (!this.stopped) {
            this.start();
          }
        }, RESTART_BACKOFF_MS * this.restartCount);
      }
    });
    this.child.on('error', (error) => {
      this.emit('error', error);
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.child !== null) {
      this.child.kill('SIGTERM');
    }
  }

  /**
   * Deliberate restart of the pi child (P1-15): pi loads models.json once at
   * process start, so a channel-config save must respawn the runtime to
   * compose updated providers. The panel is session-path-driven — every
   * prompt/steer re-switches to the current session file — so a restart does
   * not detach the active session.
   */
  restart(): void {
    if (this.stopped || this.child === null) {
      return;
    }
    const child = this.child;
    this.child = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('pi process restarted for model config reload'));
    }
    this.pending.clear();
    child.kill('SIGTERM');
    this.start();
  }

  isRunning(): boolean {
    return this.child !== null;
  }

  /** Number of in-flight RPC requests awaiting a response (debug channel). */
  pendingRequestCount(): number {
    return this.pending.size;
  }

  /** Fire-and-forget command with response correlation. */
  send(command: RpcCommand): Promise<RpcResponse> {
    const id = `pi-panel-${String(this.nextId)}`;
    this.nextId += 1;
    return this.sendRaw({ id, ...command });
  }

  sendRaw(payload: Record<string, unknown>): Promise<RpcResponse> {
    if (this.child === null) {
      return Promise.reject(new Error('pi process is not running'));
    }
    const id = payload['id'];
    const hasId = typeof id === 'string';
    const promise = new Promise<RpcResponse>((resolve, reject) => {
      if (!hasId) {
        // No correlation possible; resolve once the next response arrives.
        const timer = setTimeout(() => {
          reject(new Error('RPC response timeout'));
        }, RESPONSE_TIMEOUT_MS);
        this.once('response', (response: RpcResponse) => {
          clearTimeout(timer);
          resolve(response);
        });
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC response timeout for ${id}`));
      }, RESPONSE_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    return promise;
  }

  /** Pending dialog requests the frontend still owes an answer for. */
  getPendingUiRequests(): ExtensionUiRequest[] {
    return [...this.pendingUi.values()].map((entry) => entry.request);
  }

  /** Answer an extension UI dialog request back on stdin. */
  sendUiResponse(response: ExtensionUiResponse): boolean {
    if (this.child === null) {
      return false;
    }
    const pending = this.pendingUi.get(response.id);
    if (pending === undefined) {
      return false;
    }
    if (pending.timer !== null) {
      clearTimeout(pending.timer);
    }
    this.pendingUi.delete(response.id);
    const payload: Record<string, unknown> = {
      type: 'extension_ui_response',
      id: response.id,
    };
    if (response.cancelled === true) {
      payload['cancelled'] = true;
    } else if (response.confirmed !== undefined) {
      payload['confirmed'] = response.confirmed;
    } else {
      payload['value'] = response.value ?? '';
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    return true;
  }

  private handleLine(line: string): void {
    const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (trimmed.length === 0) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      this.emit('error', new Error('invalid JSON line from pi stdout'));
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return;
    }
    const record = parsed as Record<string, unknown>;
    if (record['type'] === 'extension_ui_request') {
      const request = extensionUiRequestSchema.safeParse(record);
      if (!request.success) {
        this.emit('error', new Error('invalid extension_ui_request shape from pi'));
        return;
      }
      const data = request.data;
      const dialogMethods: ExtensionUiMethod[] = ['select', 'confirm', 'input', 'editor'];
      if (dialogMethods.includes(data.method)) {
        // Dialog: hold until the frontend answers (agent auto-resolves on
        // timeout — we only relay the timeout hint to the UI).
        const timeout = 'timeout' in data ? data.timeout : undefined;
        const timer =
          typeof timeout === 'number'
            ? setTimeout(() => {
                this.pendingUi.delete(data.id);
              }, timeout)
            : null;
        this.pendingUi.set(data.id, { request: data, timer });
      }
      this.emit('ui-request', data);
      return;
    }
    if (record['type'] === 'response') {
      const response = rpcResponseSchema.safeParse(record);
      if (!response.success) {
        this.emit('error', new Error('invalid response shape from pi'));
        return;
      }
      const id = response.data.id;
      if (typeof id === 'string') {
        const pending = this.pending.get(id);
        if (pending !== undefined) {
          clearTimeout(pending.timer);
          this.pending.delete(id);
          pending.resolve(response.data);
        }
      }
      this.emit('response', response.data);
      return;
    }
    const event = rpcStreamEventSchema.safeParse(record);
    if (!event.success) {
      return;
    }
    // SPRINT-2 B4: stable event envelope — a per-process monotonic sequence
    // plus optional session/run ids, so parallel runs and replay tooling can
    // order and correlate frames without guessing from `type` alone. Original
    // protocol payload is preserved untouched (loose schema).
    const data = event.data;
    this.sequence += 1;
    data.sequence = this.sequence;
    if (data.sessionId === undefined && this.sessionId !== null) {
      data.sessionId = this.sessionId;
    }
    if (data.runId === undefined && this.runId !== null) {
      data.runId = this.runId;
    }
    this.emit('event', data);
  }
}
