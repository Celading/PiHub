import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import type { AgentMessage } from '../../shared/types.js';
import { listCodexSessions, parseRolloutFile, type CodexSessionDetail } from './codex-history.js';
import {
  type AgentAdapter,
  type AgentAdapterEvents,
  type AgentCommand,
  type AgentEvent,
  type AgentMeta,
  type AgentResponse,
} from './types.js';

/**
 * P2-01c → ACTIVE (2026-08-12): codex as the second AgentAdapter.
 *
 * Spawns `codex exec --json` (stdio JSONL event stream — same framing family
 * as pi RPC) and normalizes the frames into semantic AgentEvents:
 *
 *   thread.started  -> agent_start (sessionId = thread_id)
 *   turn.started    -> agent_start (runId = turn)
 *   turn.completed  -> agent_settled (+ usage/tokens)
 *   item.completed  -> message_update (agent_message / command_execution ...)
 *
 * Session model: `codex exec` is one run per process, so every prompt spawns
 * a fresh process; the finished thread's id is remembered and the next
 * prompt resumes it (`codex exec resume <thread_id>`) — the conversation
 * keeps its context without keeping a process around. Rollouts are written
 * to the standard ~/.codex sessions store (codex's own persistence — the
 * panel never reads ~/.codex/auth.json); `PIHUB_CODEX_EPHEMERAL=1` restores
 * the ephemeral mode, where resume is impossible and a failed resume
 * degrades to a fresh thread automatically.
 *
 * Safety:
 *  - dedicated child per prompt, own cwd (`-C`), `--skip-git-repo-check`
 *  - never reads ~/.codex/auth.json (codex handles its own auth)
 *  - all emitted events carry `kind: 'codex'` so the panel can route them to
 *    the codex chat view without touching pi events
 */

const RESPONSE_TIMEOUT_MS = 120_000;

interface CodexFrame {
  type?: string;
  thread_id?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    name?: string;
    error?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number;
  };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
  [key: string]: unknown;
}

/** Resolve the codex binary: env override, then the known plugin-appserver
 *  path (probed 0.147.0-alpha.6.5), then PATH. */
export function resolveCodexBinary(): string {
  const fromEnv = process.env.CODEX_BINARY;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  const candidates = [path.join(os.homedir(), '.codex', 'plugins', '.plugin-appserver', 'codex')];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // keep looking
    }
  }
  return 'codex';
}

/** Converts parsed rollout entries into chat messages (session sync). */
export function rolloutEntriesToMessages(entries: CodexSessionDetail['entries']): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (const entry of entries) {
    const timestamp = Date.parse(entry.timestamp);
    const ts = Number.isNaN(timestamp) ? 0 : timestamp;
    if (entry.type === 'input_text' && entry.text !== undefined) {
      out.push({ role: 'user', content: entry.text, timestamp: ts });
    } else if (entry.type === 'agent_message' && entry.text !== undefined) {
      out.push({
        role: 'assistant',
        content: [{ type: 'text', text: entry.text }],
        timestamp: ts,
      });
    } else if (entry.type === 'command_execution') {
      out.push({
        role: 'bashExecution',
        command: '',
        output: entry.text ?? '',
        exitCode: 0,
        cancelled: false,
        truncated: false,
        fullOutputPath: null,
        timestamp: ts,
      });
    } else if (entry.type === 'error' && entry.text !== undefined) {
      out.push({
        role: 'toolResult',
        toolCallId: '',
        toolName: 'codex.error',
        content: [{ type: 'text', text: entry.text }],
        isError: true,
        timestamp: ts,
      });
    } else if (entry.toolName !== undefined && entry.text !== undefined) {
      out.push({
        role: 'toolResult',
        toolCallId: '',
        toolName: entry.toolName,
        content: [{ type: 'text', text: entry.text }],
        isError: entry.isError ?? false,
        timestamp: ts,
      });
    }
  }
  return out;
}

/** Locates the rollout file for a thread and parses it. */
export async function loadRolloutMessages(threadId: string): Promise<AgentMessage[] | null> {
  const sessions = await listCodexSessions();
  const match = sessions.find((session) => session.sessionId === threadId);
  if (match === undefined) {
    return null;
  }
  const detail = await parseRolloutFile(match.fileName);
  return detail === null ? null : rolloutEntriesToMessages(detail.entries);
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
  /** Thread to resume on the next spawn (switch_session sets it). */
  private resumeId: string | null = null;
  /** Per-process monotonic sequence for the event envelope. */
  private sequence = 0;
  /** Rollout-loaded history for the current thread (session sync). */
  private loadedMessages: AgentMessage[] = [];
  /** Messages of the live (in-process) turns, appended as events arrive. */
  private liveMessages: AgentMessage[] = [];

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

  /** Adapter lifecycle: idempotent — codex processes are spawned per prompt,
   *  so start() just clears the stopped flag (a running child survives). */
  start(): void {
    if (this.stopped) {
      this.stopped = false;
    }
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
  }

  private spawnOnce(): ChildProcessWithoutNullStreams | null {
    const args = ['exec', '--json', '--skip-git-repo-check', '-C', this.cwd];
    if (process.env.PIHUB_CODEX_EPHEMERAL === '1') {
      args.push('--ephemeral');
    }
    if (this.resumeId !== null) {
      args.push('resume', this.resumeId);
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.binaryPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      return null;
    }
    this.child = child;
    this.buffer = '';
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
    return child;
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
      // Remember the thread to resume on the next prompt — codex keeps its
      // conversation context across processes via `exec resume`. Also load
      // its rollout history so the chat view can show the full conversation.
      this.resumeId = command.sessionId;
      const history = await loadRolloutMessages(command.sessionId);
      if (history !== null) {
        this.loadedMessages = history;
        this.threadId = command.sessionId;
        this.liveMessages = [];
      }
      return { type: 'response', command: 'switch_session', success: true };
    }
    if (command.type === 'get_state') {
      return {
        type: 'response',
        command: 'get_state',
        success: true,
        data: { isStreaming: this.child !== null, sessionId: this.threadId },
      };
    }
    return {
      type: 'response',
      command: command.type,
      success: false,
      error: `codex adapter: unsupported command ${command.type}`,
    };
  }

  /** Session sync: rollout history + live turns for the current thread. */
  async getMessages(threadId?: string): Promise<AgentMessage[]> {
    if (threadId !== undefined && threadId !== this.threadId && threadId !== this.resumeId) {
      const history = await loadRolloutMessages(threadId);
      if (history !== null) {
        this.loadedMessages = history;
        this.threadId = threadId;
        this.resumeId = threadId;
        this.liveMessages = [];
      }
    }
    return [...this.loadedMessages, ...this.liveMessages];
  }

  private async sendPrompt(message: string): Promise<AgentResponse> {
    if (this.stopped) {
      return Promise.resolve({
        type: 'response',
        command: 'prompt',
        success: false,
        error: 'codex adapter stopped',
      });
    }
    if (this.child !== null) {
      // The previous turn is still winding down (codex lingers while MCP
      // clients clean up, ~seconds after settle). Wait for the process to
      // exit instead of rejecting consecutive prompts.
      const deadline = Date.now() + 30_000;
      // Read through a function so the type checker cannot narrow `child`
      // across awaits (the exit handler may clear it at any time).
      const busy = (): boolean => this.child !== null;
      while (busy() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (busy()) {
        return Promise.resolve({
          type: 'response',
          command: 'prompt',
          success: false,
          error: 'codex is still running a previous turn',
        });
      }
    }
    const child = this.spawnOnce();
    if (child === null) {
      return Promise.resolve({
        type: 'response',
        command: 'prompt',
        success: false,
        error: `failed to spawn codex (${this.binaryPath})`,
      });
    }
    return new Promise<AgentResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.off('event', onSettled);
        resolve({
          type: 'response',
          command: 'prompt',
          success: true,
          data: { accepted: true, timeout: true },
        });
      }, RESPONSE_TIMEOUT_MS);
      const onSettled = (event: AgentEvent): void => {
        if (event.type === 'agent_settled') {
          clearTimeout(timer);
          this.off('event', onSettled);
          resolve({ type: 'response', command: 'prompt', success: true, data: { accepted: true } });
        }
      };
      this.on('event', onSettled);
      this.liveMessages.push({ role: 'user', content: message, timestamp: Date.now() });
      child.stdin.write(`${message}\n`);
      // codex exec reads the whole prompt from stdin — EOF triggers the run.
      child.stdin.end();
    });
  }

  /** Broadcasts a message_update AND appends it to the live session list. */
  private emitUpdate(envelope: Record<string, unknown>, message: AgentMessage): void {
    this.liveMessages.push(message);
    this.emit('event', { type: 'message_update', ...envelope, message });
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
      kind: 'codex' as const,
      ...(this.threadId !== null ? { sessionId: this.threadId } : {}),
    };
    switch (parsed.type) {
      case 'thread.started':
        if (typeof parsed.thread_id === 'string') {
          this.threadId = parsed.thread_id;
          // The resumed thread becomes the new baseline for the next prompt.
          this.resumeId = parsed.thread_id;
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
          this.emitUpdate(envelope, {
            role: 'toolResult',
            toolCallId: '',
            toolName: 'codex.usage',
            timestamp: Date.now(),
            content: [
              {
                type: 'text',
                text: `tokens in=${String(usage.input_tokens ?? 0)} out=${String(usage.output_tokens ?? 0)} reasoning=${String(usage.reasoning_output_tokens ?? 0)}`,
              },
            ],
            isError: false,
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
          this.emitUpdate(envelope, {
            role: 'assistant',
            content: [{ type: 'text', text: item.text }],
            timestamp: Date.now(),
          });
        } else if (itemType === 'command_execution') {
          // Real frame shape (probe): { command, aggregated_output,
          // exit_code, status } — not name/text.
          this.emitUpdate(envelope, {
            role: 'bashExecution',
            command: '',
            output: typeof item?.aggregated_output === 'string' ? item.aggregated_output : '',
            exitCode: typeof item?.exit_code === 'number' ? item.exit_code : 0,
            cancelled: false,
            truncated: false,
            fullOutputPath: null,
            timestamp: Date.now(),
          });
          // The command itself rides along as a toolResult frame so the UI
          // shows what was executed.
          if (typeof item?.command === 'string') {
            this.emitUpdate(envelope, {
              role: 'toolResult',
              toolCallId: '',
              toolName: 'codex.command',
              content: [{ type: 'text', text: item.command }],
              isError: false,
              timestamp: Date.now(),
            });
          }
        } else if (itemType === 'error') {
          // A failed resume (e.g. ephemeral mode with no rollout on disk)
          // must not wedge the adapter: drop the resume target so the next
          // prompt starts a fresh thread.
          const errorText = item?.text ?? item?.error ?? '';
          if (errorText.includes('no rollout found')) {
            this.resumeId = null;
          }
          this.emitUpdate(envelope, {
            role: 'toolResult',
            toolCallId: '',
            toolName: 'codex.error',
            content: [{ type: 'text', text: errorText }],
            isError: true,
            timestamp: Date.now(),
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
