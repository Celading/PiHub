/**
 * dsh (DeepSeek Harness) adapter — the embedded harness kernel.
 *
 * Executes one task per invocation through the dsh headless profile:
 *
 *   node <dsh>/lib/bin.js --profile headless "<task>"
 *
 * The headless bundle runs a fresh persisted session, prints the final
 * assistant text on stdout, and exits. The panel spawns it with the chosen
 * working folder (cwd) and an isolated DSH_HOME, so
 * the harness state never leaks between environments.
 *
 * Semantics (honest boundaries):
 *  - one task = one fresh session; there is no in-process conversation
 *    continuity (dsh persists sessions in DSH_HOME for later listing);
 *  - the adapter never reads provider credentials — dsh loads its own
 *    profile config from DSH_HOME;
 *  - missing profile/model config surfaces as the real spawn/exit error.
 */
import fs from 'node:fs';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type {
  AgentAdapter,
  AgentAdapterEvents,
  AgentCommand,
  AgentMeta,
  AgentResponse,
} from './types.js';

export interface DshAdapterOptions {
  /** dsh CLI entry (lib/bin.js). */
  binaryPath: string;
  /** Node binary used to spawn dsh. */
  nodeBin?: string;
  /** DSH_HOME override. */
  home?: string;
  /** Optional Node --import preload. */
  preload?: string;
  /** Working directory for spawned tasks. */
  cwd: string;
}

const MAX_ANSWER_BYTES = 256 * 1024;
const MAX_LOG_BYTES = 64 * 1024;

/** Resolves the dsh CLI entry: $DSH_BIN, then `which dsh` (npm global). */
export function resolveDshBinary(): string {
  const fromEnv = process.env.DSH_BIN;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  try {
    const result = spawnSync('which', ['dsh'], { encoding: 'utf8' });
    if (result.status === 0 && typeof result.stdout === 'string') {
      const candidate = result.stdout.trim().split('\n')[0];
      if (candidate !== undefined && candidate.length > 0) {
        return candidate;
      }
    }
  } catch {
    // not on PATH
  }
  return '';
}

/** Whether the dsh CLI is resolvable (used for UI availability hints). */
export function dshAvailable(): boolean {
  return resolveDshBinary().length > 0;
}

export class DshAdapter extends EventEmitter implements AgentAdapter {
  readonly meta: AgentMeta = {
    kind: 'dsh',
    label: 'DeepSeek Harness',
    version: 'headless',
    defaultColor: '#7c3aed',
  };

  private readonly binaryPath: string;
  private readonly nodeBin: string;
  private readonly home: string | undefined;
  /** Optional Node --import preload. */
  private readonly preload: string | undefined;
  private readonly cwd: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private stopped = false;
  private readonly liveMessages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: number }> = [];

  constructor(options: DshAdapterOptions) {
    super();
    this.binaryPath = options.binaryPath;
    this.nodeBin = options.nodeBin ?? process.execPath;
    this.home = options.home;
    this.preload = options.preload;
    this.cwd = options.cwd;
  }

  isRunning(): boolean {
    return this.child !== null;
  }

  start(): void {
    this.stopped = false;
  }

  stop(): void {
    this.stopped = true;
    if (this.child !== null) {
      this.child.kill('SIGTERM');
    }
  }

  restart(): void {
    this.stop();
    this.stopped = false;
  }

  async send(command: AgentCommand): Promise<AgentResponse> {
    if (command.type === 'abort') {
      // dsh headless has no mid-task abort command; SIGINT is the sanctioned
      // cancellation (the headless runner flushes its session on exit).
      this.child?.kill('SIGINT');
      return { type: 'response', command: 'abort', success: true };
    }
    if (command.type === 'prompt' || command.type === 'steer') {
      return this.runTask(command.message, command.cwd);
    }
    if (command.type === 'get_state') {
      return {
        type: 'response',
        command: 'get_state',
        success: true,
        data: { isStreaming: this.child !== null },
      };
    }
    if (command.type === 'get_messages') {
      return {
        type: 'response',
        command: 'get_messages',
        success: true,
        data: { messages: [...this.liveMessages] },
      };
    }
    return {
      type: 'response',
      command: command.type,
      success: false,
      error: `dsh adapter: unsupported command ${command.type}`,
    };
  }

  /** Current live messages (user prompts + final answers). */
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

  getMessages(): AgentMessageLike[] {
    return this.liveMessages.map((entry) => ({
      role: entry.role,
      content: [{ type: 'text', text: entry.content }],
      timestamp: entry.timestamp,
    }));
  }

  private runTask(message: string, cwd?: string): Promise<AgentResponse> {
    if (this.stopped) {
      return Promise.resolve({
        type: 'response',
        command: 'prompt',
        success: false,
        error: 'dsh adapter stopped',
      });
    }
    if (this.child !== null) {
      return Promise.resolve({
        type: 'response',
        command: 'prompt',
        success: false,
        error: 'dsh is still running a previous task',
      });
    }
    return new Promise<AgentResponse>((resolve) => {
      const args = [
        ...(this.preload !== undefined ? ['--import', this.preload] : []),
        // The cordis loader reaches Node internals either through
        // --expose-internals or the node-addon-require-builtin native addon
        // when the native addon is not present. Pass the flag so the HMR
        // service and loader internals work in a plain Node installation.
        '--expose-internals',
        this.binaryPath,
        '--profile',
        'headless',
        ...(process.env.PIHUB_DSH_PATCH !== undefined && process.env.PIHUB_DSH_PATCH.length > 0
          ? ['--patch', process.env.PIHUB_DSH_PATCH]
          : []),
        message,
      ];
      console.log(
        `[adapter:dsh] spawn node=${this.nodeBin} args=${JSON.stringify(args)} cwd=${cwd ?? this.cwd} DSH_BIN=${String(process.env.DSH_BIN)}`,
      );
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(this.nodeBin, args, {
          cwd: cwd ?? this.cwd,
          env: {
            ...process.env,
            ...(this.home !== undefined ? { DSH_HOME: this.home } : {}),
            ...(process.env.PIHUB_LLM_KEY !== undefined && process.env.PIHUB_LLM_KEY.length > 0
              ? { PIHUB_LLM_KEY: process.env.PIHUB_LLM_KEY }
              : {}),
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {
        resolve({
          type: 'response',
          command: 'prompt',
          success: false,
          error: `failed to spawn dsh (${this.binaryPath})`,
        });
        return;
      }
      this.child = child;
      let answer = '';
      let log = '';
      let logHead = '';
      let settled = false;
      const finish = (success: boolean, extra: { answer?: string; error?: string; diagnostics?: string }): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.child = null;
        this.emit('event', { type: 'agent_settled', kind: 'dsh' });
        resolve({
          type: 'response',
          command: 'prompt',
          success,
          ...(extra.answer !== undefined ? { data: { answer: extra.answer } } : {}),
          ...(extra.error !== undefined ? { error: extra.error } : {}),
        });
      };

      this.emit('event', { type: 'agent_start', kind: 'dsh' });
      this.liveMessages.push({ role: 'user', content: message, timestamp: Date.now() });

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (answer.length < MAX_ANSWER_BYTES) {
          answer = (answer + chunk).slice(0, MAX_ANSWER_BYTES);
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        if (logHead.length < 2048) {
          logHead = (logHead + chunk).slice(0, 2048);
        }
        if (log.length < MAX_LOG_BYTES) {
          log = (log + chunk).slice(0, MAX_LOG_BYTES);
        }
      });
      child.on('error', (error) => {
        this.emit('error', error);
        finish(false, { error: `dsh spawn error: ${error.message}` });
      });
      child.on('exit', (code) => {
        const trimmed = answer.trim();
        if (trimmed.length > 0) {
          this.liveMessages.push({ role: 'assistant', content: trimmed, timestamp: Date.now() });
          this.emit('event', {
            type: 'message_update',
            kind: 'dsh',
            message: { role: 'assistant', content: [{ type: 'text', text: trimmed }] },
          });
        }
        if (code === 0) {
          if (trimmed.length > 0) {
            finish(true, { answer: trimmed });
          } else {
            // Exit 0 with no stdout is a silent failure (e.g. an exception
            // swallowed by the device preload wrapper draining the loop).
            // Surface the captured stderr so the failure is not invisible.
            const lines = log.trim().split('\n');
            const reason =
              (logHead.trim().length > 0 ? `${logHead.trim().split('\n').slice(0, 8).join('\n')}\n` : '') +
              lines.slice(-25).join('\n');
            this.dumpDiagnostics(code, log, answer);
            finish(true, {
              answer: '',
              diagnostics: `dsh exited 0 without an answer${reason.length > 0 ? `:\n${reason}` : ''}`,
            });
          }
        } else {
          const lines = log.trim().split('\n');
          const reason =
            (logHead.trim().length > 0 ? `${logHead.trim().split('\n').slice(0, 8).join('\n')}\n` : '') +
            lines.slice(-25).join('\n');
          const answerNote = trimmed.length > 0 ? `\n[stdout] ${trimmed.slice(0, 800)}` : '';
          // Diagnostic dump: full streams land beside DSH_HOME for off-device
          // inspection (the HTTP error keeps only head+tail).
          this.dumpDiagnostics(code, log, answer);
          finish(false, {
            error: `dsh task failed (exit ${String(code)})${reason.length > 0 ? `:\n${reason}` : ''}${answerNote}`,
          });
        }
      });
    });
  }

  /** Diagnostic dump: full streams land beside DSH_HOME for off-device
   *  inspection (the HTTP error keeps only head+tail). Runs on every
   *  settle, not just failures — silent exit-0 failures need the same
   *  visibility. */
  private dumpDiagnostics(code: number | null, log: string, stdout: string): void {
    try {
      const dumpDir = process.env.DSH_HOME;
      if (dumpDir !== undefined && dumpDir.length > 0) {
        fs.mkdirSync(dumpDir, { recursive: true });
        fs.appendFileSync(
          `${dumpDir}/dsh-last-error.log`,
          `=== exit ${String(code)} ${new Date().toISOString()} ===\n${log}\n`,
          'utf8',
        );
        fs.appendFileSync(
          `${dumpDir}/dsh-last-stdout.log`,
          `=== exit ${String(code)} ${new Date().toISOString()} ===\n${stdout}\n`,
          'utf8',
        );
      }
    } catch {
      // diagnostics are best-effort
    }
  }
}

/** Message shape the panel chat renders (subset of AgentMessage). */
interface AgentMessageLike {
  role: string;
  content: Array<{ type: string; text: string }>;
  timestamp: number;
}
