import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  type AgentAdapter,
  type AgentAdapterEvents,
  type AgentCommand,
  type AgentEvent,
  type AgentMeta,
  type AgentResponse,
} from './types.js';

/**
 * P2-01c: codex as the second AgentAdapter.
 *
 * Spawns `codex exec --json` (stdio JSONL event stream — same framing family
 * as pi RPC) and normalizes the frames into semantic AgentEvents:
 *
 *   thread.started  -> agent_start (sessionId = thread_id)
 *   turn.started    -> agent_start (runId = turn)
 *   turn.completed  -> agent_settled (+ usage/tokens)
 *   item.completed  -> message_update (agent_message / command_execution ...)
 *
 * Safety (owner: codex is actively used — minimal impact):
 *  - the adapter is a separate child process with its own cwd/env
 *  - `--ephemeral` by default: no session files written to ~/.codex
 *  - never reads ~/.codex/auth.json (codex handles its own auth)
 *  - `--skip-git-repo-check` so non-git workspaces do not block
 */

const RESPONSE_TIMEOUT_MS = 30_000;

interface CodexFrame {
  type?: string;
  thread_id?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    name?: string;
    error?: string;
  };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
  [key: string]: unknown;
}

export class CodexAdapter extends EventEmitter implements AgentAdapter {
  readonly meta: AgentMeta = {
    kind: 'codex',
    label: 'Codex',
    version: null,
    defaultColor: '#10a37f',
  };

  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private stopped = false;
  /** Current thread/session id (from thread.started), for the envelope. */
  private threadId: string | null = null;
  /** Per-process monotonic sequence for the event envelope. */
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
    const child = spawn(
      this.binaryPath,
      ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '-C', this.cwd],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.child = child;
    this.sequence = 0;
    this.threadId = null;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let newlineIndex = this.buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = this.buffer.slice(0, newlineIndex);
        this.buffer = this.buffer.slice(newlineIndex + 1);
        this.handleLine(line);
        newlineIndex = this.buffer.indexOf('\n');
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // codex logs MCP noise to stderr; only surface non-empty lines.
      const line = chunk.trimEnd();
      if (line.length > 0 && !line.includes('rmcp::') && !line.includes('MCP')) {
        this.emit('error', new Error(`codex stderr: ${line.slice(0, 300)}`));
      }
    });
    const exitedChild = child;
    child.on('exit', (code) => {
      if (this.child === exitedChild) {
        this.child = null;
      }
      this.emit('exit', code);
    });
    child.on('error', (error) => {
      this.emit('error', error);
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.child !== null) {
      this.child.kill('SIGTERM');
    }
  }

  restart(): void {
    if (this.stopped) {
      return;
    }
    this.stop();
    this.stopped = false;
    this.start();
  }

  async send(command: AgentCommand): Promise<AgentResponse> {
    if (command.type === 'abort') {
      // codex exec has no mid-turn abort command; SIGINT is the sanctioned
      // cancellation. Best effort.
      this.child?.kill('SIGINT');
      return { type: 'response', command: 'abort', success: true };
    }
    if (command.type === 'prompt' || command.type === 'steer') {
      return this.sendPrompt(command.message);
    }
    if (command.type === 'switch_session') {
      // Resume an existing session by id: prompt "continue" into that thread.
      return this.sendResume(command.sessionId);
    }
    if (command.type === 'get_state') {
      return { type: 'response', command: 'get_state', success: true, data: { isStreaming: this.child !== null } };
    }
    return {
      type: 'response',
      command: command.type,
      success: false,
      error: `codex adapter: unsupported command ${command.type}`,
    };
  }

  private sendPrompt(message: string): Promise<AgentResponse> {
    if (this.child === null) {
      return Promise.resolve({
        type: 'response',
        command: 'prompt',
        success: false,
        error: 'codex adapter not running',
      });
    }
    return new Promise<AgentResponse>((resolve) => {
      const timer = setTimeout(() => {
        resolve({ type: 'response', command: 'prompt', success: true, data: { accepted: true, timeout: true } });
      }, RESPONSE_TIMEOUT_MS);
      const onSettled = (event: AgentEvent): void => {
        if (event.type === 'agent_settled') {
          clearTimeout(timer);
          this.off('event', onSettled);
          resolve({ type: 'response', command: 'prompt', success: true, data: { accepted: true } });
        }
      };
      this.on('event', onSettled);
      this.child?.stdin.write(`${message}\n`);
    });
  }

  private sendResume(sessionId: string): Promise<AgentResponse> {
    void sessionId; // v2: dedicated process per session
    if (this.child === null) {
      return Promise.resolve({
        type: 'response',
        command: 'switch_session',
        success: false,
        error: 'codex adapter not running',
      });
    }
    // codex exec resume needs a subprocess per session; the simplest honest
    // path for v1: report unsupported so the UI surfaces it, rather than
    // half-implementing a wrong resume.
    return Promise.resolve({
      type: 'response',
      command: 'switch_session',
      success: false,
      error: 'codex exec resume requires a dedicated process per session (v2)',
    });
  }

  private handleLine(line: string): void {
    const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (trimmed.length === 0) {
      return;
    }
    let parsed: CodexFrame;
    try {
      parsed = JSON.parse(trimmed) as CodexFrame;
    } catch {
      return;
    }
    this.sequence += 1;
    const envelope = {
      sequence: this.sequence,
      ...(this.threadId !== null ? { sessionId: this.threadId } : {}),
    };
    switch (parsed.type) {
      case 'thread.started':
        if (typeof parsed.thread_id === 'string') {
          this.threadId = parsed.thread_id;
        }
        this.emit('event', { type: 'agent_start', ...envelope, sessionId: this.threadId ?? undefined });
        break;
      case 'turn.started':
        this.emit('event', { type: 'agent_start', ...envelope });
        break;
      case 'turn.completed': {
        const usage = parsed.usage;
        const runId = `${this.threadId ?? 'codex'}#${String(this.sequence)}`;
        this.emit('event', { type: 'agent_settled', ...envelope, runId });
        if (usage !== undefined) {
          this.emit('event', {
            type: 'message_update',
            ...envelope,
            runId,
            message: {
              role: 'toolResult',
              toolName: 'codex.usage',
              content: [
                {
                  type: 'text',
                  text: `tokens in=${String(usage.input_tokens ?? 0)} out=${String(usage.output_tokens ?? 0)} reasoning=${String(usage.reasoning_output_tokens ?? 0)}`,
                },
              ],
            },
          });
        }
        break;
      }
      case 'item.started':
        // no semantic mapping needed for v1
        break;
      case 'item.completed': {
        const item = parsed.item;
        const itemType = item?.type ?? 'unknown';
        if (itemType === 'agent_message' && typeof item?.text === 'string') {
          this.emit('event', {
            type: 'message_update',
            ...envelope,
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: item.text }],
            },
          });
        } else if (itemType === 'command_execution') {
          // Real frame shape (probe): { command, aggregated_output,
          // exit_code, status } — not name/text.
          const record = item as {
            command?: unknown;
            aggregated_output?: unknown;
            exit_code?: unknown;
          };
          this.emit('event', {
            type: 'message_update',
            ...envelope,
            message: {
              role: 'bashExecution',
              toolName: 'command',
              output:
                typeof record.aggregated_output === 'string' ? record.aggregated_output : '',
              exitCode: typeof record.exit_code === 'number' ? record.exit_code : 0,
            },
          });
          // The command itself rides along as a toolResult frame so the UI
          // shows what was executed.
          if (typeof record.command === 'string') {
            this.emit('event', {
              type: 'message_update',
              ...envelope,
              message: {
                role: 'toolResult',
                toolName: 'codex.command',
                content: [{ type: 'text', text: record.command }],
                isError: false,
              },
            });
          }
        } else if (itemType === 'error') {
          this.emit('event', {
            type: 'message_update',
            ...envelope,
            message: {
              role: 'toolResult',
              toolName: 'codex.error',
              content: [{ type: 'text', text: item?.text ?? item?.error ?? 'codex error' }],
              isError: true,
            },
          });
        } else {
          this.emit('event', {
            type: 'adapter_extension',
            kind: 'codex',
            payload: parsed,
          });
        }
        break;
      }
      default:
        this.emit('event', { type: 'adapter_extension', kind: 'codex', payload: parsed });
    }
  }
}
