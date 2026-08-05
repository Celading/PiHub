import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { rpcResponseSchema, rpcStreamEventSchema } from '../shared/schemas.js';
import type { RpcResponse, RpcStreamEvent } from '../shared/types.js';

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
  | { type: 'get_state' }
  | { type: 'get_messages' }
  | { type: 'get_entries'; since?: string }
  | { type: 'get_tree' }
  | { type: 'get_available_models' }
  | { type: 'get_session_stats' }
  | { type: 'get_fork_messages' };

interface PendingRequest {
  resolve: (value: RpcResponse) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface RpcBridgeEvents {
  event: (event: RpcStreamEvent) => void;
  response: (response: RpcResponse) => void;
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
  private nextId = 1;
  private buffer = '';
  private restartCount = 0;
  private stopped = false;

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
    this.child.on('exit', (code) => {
      this.child = null;
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

  isRunning(): boolean {
    return this.child !== null;
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
    this.emit('event', event.data);
  }
}
