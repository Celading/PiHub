import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { AgentAdapter, AgentAdapterEvents, AgentCommand, AgentMeta, AgentResponse } from './types.js';

/**
 * ADAPTER2 A: atomcode as an AgentAdapter (opt-in).
 *
 * Spawns `atomcode -p <prompt> -v -C <cwd>` (headless, Claude Code -p
 * style): stdout is the assistant reply, stderr (with -v) carries tool
 * calls / token usage / turn summary. There is no --json stream, so the
 * adapter treats completion of the process as one settled turn.
 *
 * Safety (owner: atomcode is in active use — minimal impact):
 *  - opt-in, NOT started by default
 *  - never reads ~/.atomcode/auth.toml (atomcode handles its own auth)
 */

export class AtomcodeAdapter extends EventEmitter implements AgentAdapter {
  readonly meta: AgentMeta = {
    kind: 'atomcode',
    label: 'AtomCode',
    version: null,
    defaultColor: '#e4572e',
  };

  private child: ChildProcessWithoutNullStreams | null = null;
  private stopped = false;
  private sequence = 0;

  constructor(
    private readonly binaryPath: string,
    private readonly cwd: string,
  ) {
    super();
  }

  override on<K extends keyof AgentAdapterEvents>(
    event: K,
    listener: AgentAdapterEvents[K],
  ): this {
    return super.on(event, listener as never);
  }

  override off<K extends keyof AgentAdapterEvents>(
    event: K,
    listener: AgentAdapterEvents[K],
  ): this {
    return super.off(event, listener as never);
  }

  isRunning(): boolean {
    return this.child !== null;
  }

  start(): void {
    if (this.stopped || this.child !== null) {
      return;
    }
    // Idle process: atomcode exits after the headless run; keeping a child
    // alive here would leak. This adapter starts per-send instead.
    this.stopped = false;
  }

  stop(): void {
    this.stopped = true;
    this.child?.kill('SIGTERM');
    this.child = null;
  }

  restart(): void {
    this.stop();
    this.stopped = false;
  }

  async send(command: AgentCommand): Promise<AgentResponse> {
    if (command.type === 'abort') {
      this.child?.kill('SIGTERM');
      return { type: 'response', command: 'abort', success: true };
    }
    if (command.type === 'prompt' || command.type === 'steer') {
      return this.runHeadless(command.message);
    }
    if (command.type === 'get_state') {
      return { type: 'response', command: 'get_state', success: true, data: { isRunning: this.child !== null } };
    }
    return {
      type: 'response',
      command: command.type,
      success: false,
      error: `atomcode adapter: unsupported command ${command.type}`,
    };
  }

  /** Runs one headless prompt; stdout = reply, stderr(-v) = tool/usage noise. */
  private runHeadless(message: string): Promise<AgentResponse> {
    this.sequence += 1;
    const envelope = { sequence: this.sequence, sessionId: 'atomcode-headless' };
    this.emit('event', { type: 'agent_start', ...envelope });
    return new Promise<AgentResponse>((resolve) => {
      const child = spawn(this.binaryPath, ['-p', message, '-v', '-C', this.cwd], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;
      let reply = '';
      let toolText = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        reply += chunk;
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        toolText += chunk;
      });
      const exitedChild = child;
      child.on('exit', (code) => {
        if (this.child === exitedChild) {
          this.child = null;
        }
        if (reply.trim().length > 0) {
          this.emit('event', {
            type: 'message_update',
            ...envelope,
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: reply.trim() }],
            },
          });
        }
        if (toolText.trim().length > 0) {
          this.emit('event', {
            type: 'adapter_extension',
            kind: 'atomcode',
            payload: { type: 'atomcode.stderr', text: toolText.trim().slice(0, 2000) },
          });
        }
        this.emit('event', { type: 'agent_settled', ...envelope, runId: `atomcode#${String(this.sequence)}` });
        resolve({
          type: 'response',
          command: 'prompt',
          success: code === 0,
          ...(code !== 0 ? { error: `atomcode exited ${String(code)}` } : {}),
          data: { reply: reply.trim() },
        });
      });
      child.on('error', (error) => {
        this.child = null;
        this.emit('error', error);
        resolve({ type: 'response', command: 'prompt', success: false, error: error.message });
      });
    });
  }
}
