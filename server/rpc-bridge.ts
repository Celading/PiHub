import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { extensionUiRequestSchema, rpcResponseSchema, rpcStreamEventSchema } from '../shared/schemas.js';
import type { ExtensionUiMethod, ExtensionUiRequest, ExtensionUiResponse, RpcResponse, RpcStreamEvent } from '../shared/types.js';

const MAX_RESTARTS = 3;
const RESTART_BACKOFF_MS = 1000;
const RESPONSE_TIMEOUT_MS = 30_000;
/** P2-2: bound the stdout framing buffer (a runaway pi with no newlines
 *  must not grow memory without limit). */
const MAX_STDOUT_BUFFER_BYTES = 1024 * 1024;
/** P2-2: restart budget is a sliding 60s window — a long-stable process
 *  resets it instead of counting restarts forever. */
const RESTART_WINDOW_MS = 60_000;

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
  /** P2-2: sliding window of crash timestamps (see RESTART_WINDOW_MS). */
  private restartTimes: number[] = [];
  private stopped = false;
  /** SPRINT-2 B4: per-process monotonic event sequence (event envelope). */
  private sequence = 0;
  /** Current pi session id (from session header events), for the envelope. */
  private sessionId: string | null = null;
  /** Current pipeline run id, when a pipeline step is driving pi. */
  private runId: string | null = null;

  constructor(
    private readonly piBinary: string,
    private cwd: string,
    options?: { systemPrompt?: () => string; baseArgs?: string[] },
  ) {
    super();
    this.systemPrompt = options?.systemPrompt ?? null;
    this.baseArgs = options?.baseArgs ?? [];
  }

  /** Settings system prompt, appended to pi's default coding assistant
   *  prompt at spawn time (owner spec: system prompt setting). Read lazily
   *  so a save followed by restart() picks up the new text. */
  private readonly systemPrompt: (() => string) | null;
  /** Arguments placed before `--mode rpc`. Device builds use this to run
   *  the vendored Pi CLI through the HNP Node executable. */
  private readonly baseArgs: string[];

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
    // Framing state belongs to one child process. A deliberate restart must
    // not let a partial line from the retired child prefix the replacement's
    // first JSON frame.
    this.buffer = '';
    const args = [...this.baseArgs, '--mode', 'rpc'];
    const systemPromptText = this.systemPrompt?.() ?? '';
    if (systemPromptText.trim().length > 0) {
      args.push('--append-system-prompt', systemPromptText);
    }
    this.child = spawn(this.piBinary, args, {
      cwd: this.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exitedChild = this.child;
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      if (this.child !== exitedChild) {
        return;
      }
      this.buffer += chunk;
      // P2-2: a runaway pi (no newlines) must not grow the buffer unbounded.
      if (this.buffer.length > MAX_STDOUT_BUFFER_BYTES) {
        this.emit('error', new Error('pi stdout exceeded the framing buffer limit; restarting'));
        this.buffer = '';
        if (this.child === exitedChild) {
          this.child.kill('SIGKILL'); // the exit handler owns the restart
        }
        return;
      }
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
      if (this.child !== exitedChild) {
        return;
      }
      this.emit('error', new Error(`pi stderr: ${chunk.trimEnd()}`));
    });
    this.child.on('exit', (code) => {
      // SPRINT-2 A2: only clear the reference if this is still the current
      // child. A deliberate restart() kills the old process and spawns a new
      // one; if the old process's exit event fires AFTER the new child was
      // assigned, unconditionally nulling this.child would drop the new
      // process (orphan + duplicate pi).
      if (this.child !== exitedChild) {
        return;
      }
      this.child = null;
      this.emit('exit', code);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`pi process exited with code ${String(code)}`));
      }
      this.pending.clear();
      if (!this.stopped) {
        // P2-2: sliding restart window — a long-stable process resets the
        // budget instead of exhausting it forever.
        const now = Date.now();
        this.restartTimes = this.restartTimes.filter((t) => now - t < RESTART_WINDOW_MS);
        this.restartTimes.push(now);
        if (this.restartTimes.length <= MAX_RESTARTS) {
          setTimeout(() => {
            if (!this.stopped) {
              this.start();
            }
          }, RESTART_BACKOFF_MS * this.restartTimes.length);
        }
      }
    });
    this.child.on('error', (error) => {
      if (this.child === exitedChild) {
        this.emit('error', error);
      }
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
   *
   * An optional cwd re-targets the process (new session in a chosen folder):
   * the child is respawned with the new working directory.
   */
  restart(cwd?: string): void {
    if (this.stopped) {
      return;
    }
    if (cwd !== undefined && cwd.length > 0) {
      this.cwd = cwd;
    }
    if (this.child === null) {
      // Not running (crash loop / stopped) — just (re)start with the target.
      this.start();
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

  /** The pi child's working directory (spawn target). */
  getCwd(): string {
    return this.cwd;
  }

  /** Resolves after the child accepts a real RPC request, not merely spawn(). */
  async waitReady(timeoutMs: number = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      if (this.child === null) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      const remaining = Math.max(100, deadline - Date.now());
      try {
        await this.sendRaw(
          { id: `pi-panel-ready-${String(this.nextId++)}`, type: 'get_state' },
          Math.min(1000, remaining),
        );
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw new Error('pi process did not become RPC-ready in time');
  }

  isRunning(): boolean {
    return this.child !== null;
  }

  /** Current pi session file (from get_state responses; null before the
   *  first state read). Consumers use it to correlate events to a session. */
  getSessionId(): string | null {
    return this.sessionId;
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

  sendRaw(payload: Record<string, unknown>, timeoutMs: number = RESPONSE_TIMEOUT_MS): Promise<RpcResponse> {
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
        }, timeoutMs);
        this.once('response', (response: RpcResponse) => {
          clearTimeout(timer);
          resolve(response);
        });
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC response timeout for ${id}`));
      }, timeoutMs);
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
      // Correlation entry (audit P1 fix): pi RPC events carry NO session/run
      // ids (probe-verified), so the session id is captured from the
      // get_state response instead — every subsequent event envelope gets it
      // injected (handleLine below), which lets consumers (pipeline engine)
      // filter events per session. runId has no protocol source yet; it is a
      // Run Kernel concern (next phase).
      const data = response.data.data as { sessionFile?: unknown } | undefined;
      if (
        typeof data?.sessionFile === 'string' &&
        data.sessionFile.length > 0 &&
        data.sessionFile !== this.sessionId
      ) {
        this.sessionId = data.sessionFile;
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
