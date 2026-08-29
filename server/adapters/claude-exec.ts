/**
 * Claude Code exec adapter — headless per-prompt conversation rendering in
 * the panel chat.
 *
 * CLI: `claude -p --output-format json [--continue] "prompt"` — print mode,
 * JSON result envelope. `--continue` keeps the most recent session per cwd
 * (conversation continuity across prompts); tool approval stays interactive
 * (no --dangerously-skip-permissions): headless runs answer through text
 * reasoning, tool calls the CLI cannot approve are honestly skipped by the
 * CLI itself.
 */
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { AgentAdapter, AgentCommand, AgentResponse } from './types.js';

export interface ClaudeExecOptions {
  binaryPath: string;
  cwd: string;
}

const MAX_ANSWER_BYTES = 256 * 1024;
const MAX_LOG_BYTES = 64 * 1024;

/** Resolve the claude binary: $CLAUDE_BINARY, then `which claude`. */
export function resolveClaudeBinary(): string {
  const fromEnv = process.env.CLAUDE_BINARY;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  try {
    const result = spawnSync('which', ['claude'], { encoding: 'utf8' });
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

/** Whether the claude CLI is resolvable. */
export function claudeAvailable(): boolean {
  return resolveClaudeBinary().length > 0;
}

export class ClaudeExecAdapter extends EventEmitter implements AgentAdapter {
  readonly meta = {
    kind: 'claude' as const,
    label: 'Claude',
    version: 'exec (per-prompt)',
    defaultColor: '#d97757',
  };

  private readonly binaryPath: string;
  private readonly cwd: string;
  private child: ReturnType<typeof spawn> | null = null;
  private stopped = false;
  private readonly liveMessages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: number }> = [];

  constructor(options: ClaudeExecOptions) {
    super();
    this.binaryPath = options.binaryPath;
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
      this.child?.kill('SIGINT');
      return { type: 'response', command: 'abort', success: true };
    }
    if (command.type === 'prompt' || command.type === 'steer') {
      return this.runPrompt(command.message, command.cwd);
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
      error: `claude adapter: unsupported command ${command.type}`,
    };
  }

  getMessages(): Array<{ role: string; content: Array<{ type: string; text: string }>; timestamp: number }> {
    return this.liveMessages.map((entry) => ({
      role: entry.role,
      content: [{ type: 'text', text: entry.content }],
      timestamp: entry.timestamp,
    }));
  }

  private runPrompt(message: string, cwd?: string): Promise<AgentResponse> {
    if (this.stopped) {
      return Promise.resolve({ type: 'response', command: 'prompt', success: false, error: 'claude adapter stopped' });
    }
    if (this.child !== null) {
      return Promise.resolve({
        type: 'response',
        command: 'prompt',
        success: false,
        error: 'claude is still running a previous prompt',
      });
    }
    return new Promise<AgentResponse>((resolve) => {
      const targetCwd = cwd ?? this.cwd;
      const args = ['-p', '--output-format', 'json', '--continue', message];
      console.log(`[adapter:claude] spawn ${this.binaryPath} ${JSON.stringify(args)} cwd=${targetCwd}`);
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(this.binaryPath, args, {
          cwd: targetCwd,
          env: { ...process.env },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {
        resolve({ type: 'response', command: 'prompt', success: false, error: `failed to spawn claude (${this.binaryPath})` });
        return;
      }
      this.child = child;
      let answer = '';
      let log = '';
      let logHead = '';
      let settled = false;
      const finish = (success: boolean, extra: { answer?: string; error?: string }): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.child = null;
        this.emit('event', { type: 'agent_settled', kind: 'claude' });
        resolve({
          type: 'response',
          command: 'prompt',
          success,
          ...(extra.answer !== undefined ? { data: { answer: extra.answer } } : {}),
          ...(extra.error !== undefined ? { error: extra.error } : {}),
        });
      };
      this.emit('event', { type: 'agent_start', kind: 'claude' });
      this.liveMessages.push({ role: 'user', content: message, timestamp: Date.now() });

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        if (answer.length < MAX_ANSWER_BYTES) {
          answer = (answer + chunk).slice(0, MAX_ANSWER_BYTES);
        }
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        if (logHead.length < 2048) {
          logHead = (logHead + chunk).slice(0, 2048);
        }
        if (log.length < MAX_LOG_BYTES) {
          log = (log + chunk).slice(0, MAX_LOG_BYTES);
        }
      });
      child.on('error', (error) => {
        this.emit('error', error);
        finish(false, { error: `claude spawn error: ${error.message}` });
      });
      child.on('exit', (code) => {
        // Parse the JSON result envelope: {type:"result", result:"..."} (or a
        // session-less text fallback when the envelope is missing).
        let text = answer.trim();
        try {
          const parsed = JSON.parse(answer) as { result?: unknown; type?: unknown };
          if (typeof parsed.result === 'string') {
            text = parsed.result.trim();
          }
        } catch {
          // plain text output — use as-is
        }
        if (text.length > 0) {
          this.liveMessages.push({ role: 'assistant', content: text, timestamp: Date.now() });
          this.emit('event', {
            type: 'message_update',
            kind: 'claude',
            message: { role: 'assistant', content: [{ type: 'text', text }] },
          });
        }
        if (code === 0) {
          finish(true, text.length > 0 ? { answer: text } : { answer: '' });
        } else {
          const lines = log.trim().split('\n');
          const reason =
            (logHead.trim().length > 0 ? `${logHead.trim().split('\n').slice(0, 8).join('\n')}\n` : '') +
            lines.slice(-25).join('\n');
          finish(false, {
            error: `claude task failed (exit ${String(code)})${reason.length > 0 ? `:\n${reason}` : ''}${text.length > 0 ? `\n[stdout] ${text.slice(0, 800)}` : ''}`,
          });
        }
      });
    });
  }
}
