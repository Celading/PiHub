import type { AgentMessage, ContentBlock, RpcStreamEvent } from '../../shared/types.js';
import type { SseHub } from '../sse.js';
import type { SessionProvider } from '../providers/file-session-provider.js';
import { DEMO_RUNNING_ID } from '../providers/mock-session-provider.js';

export type ShowcasePhase = 'idle' | 'playing' | 'settled';

/**
 * Demo showcase player (showcase sprint): plays a full scripted conversation
 * over the STANDARD SSE event stream — a user message ("pretend to send"),
 * a thinking block, a chain of tool calls, typewriter-style text deltas and
 * a settle. Frames mirror the real pi protocol shapes exactly (message_start
 * / message_update carry the accumulated `message`; deltas ride along in
 * assistantMessageEvent), so the frontend has zero demo branches: the
 * typewriter reveal, the tool-chain collapse and the final summary line are
 * all production components reacting to ordinary events. Timers are tracked
 * so a new play or a stop cancels a half-finished run.
 */

const SESSION = DEMO_RUNNING_ID;
// The frontend reloads the (now empty) session right after calling play; the
// first broadcast is delayed so every event lands AFTER that reload — a
// reset that arrived between agent_start and the following frames would
// swallow the run clock and the settle summary.
const OFFSET_MS = 1500;
const T = {
  user: OFFSET_MS,
  assistantStart: OFFSET_MS + 300,
  thinking: OFFSET_MS + 500,
  tool1: OFFSET_MS + 1400,
  tool2: OFFSET_MS + 2400,
  tool3: OFFSET_MS + 3400,
  assistantEnd: OFFSET_MS + 4400,
  result1: OFFSET_MS + 4600,
  result2: OFFSET_MS + 5400,
  result3: OFFSET_MS + 6200,
  textStart: OFFSET_MS + 6800,
  text1: OFFSET_MS + 7000,
  text2: OFFSET_MS + 7900,
  text3: OFFSET_MS + 8800,
  settle: OFFSET_MS + 9700,
};

const USER_PROMPT = '看看 PiHub 能为我做什么';
const THINKING =
  '收到，我先盘点一下这台机器上的能力：本地会话、技能与工程流目录，以及最近的文件活动。';
const TOOL1 = { id: 'showcase-tool-1', name: 'bash', arguments: { command: 'pi --version' } };
const TOOL2 = { id: 'showcase-tool-2', name: 'get_commands', arguments: {} };
const TOOL3 = { id: 'showcase-tool-3', name: 'file_read', arguments: { path: 'README.md' } };
const TEXT_BLOCKS = [
  'PiHub 是 pi coding agent 的本地网页控制台——',
  '多标签并行对话、会话树一键分叉、成本洞察、文件工作台，',
  '还有 PiHub 独有的工程流编排：多步编排、审批闸门、实时时间线。',
  '全部运行在你的机器上：仅监听 127.0.0.1，绝不读取你的凭据。',
];
const FINAL_TEXT = TEXT_BLOCKS.join('');

const now = (): number => Date.now();

function assistantMessage(content: ContentBlock[]): AgentMessage {
  return { role: 'assistant', content, timestamp: now() };
}

function userMessage(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: now() };
}

function toolResultMessage(toolCallId: string, toolName: string, text: string): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName,
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: now(),
  };
}

export class DemoShowcase {
  private phase: ShowcasePhase = 'idle';
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private readonly hub: SseHub;
  private readonly provider: SessionProvider;

  constructor(hub: SseHub, provider: SessionProvider) {
    this.hub = hub;
    this.provider = provider;
  }

  getPhase(): ShowcasePhase {
    return this.phase;
  }

  private clearTimers(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers = [];
  }

  private at(ms: number, fn: () => void): void {
    this.timers.push(setTimeout(fn, ms));
  }

  private broadcast(event: RpcStreamEvent): void {
    this.hub.broadcast(event);
  }

  private setRunningStatus(status: 'done' | 'aborted'): void {
    (this.provider as { setDemoStatus?: (id: string, status: 'done' | 'aborted') => void })
      .setDemoStatus?.(SESSION, status);
  }

  private resetRunningConversation(): void {
    // Wipe the running demo session so the frontend reload sees an empty
    // conversation and the showcase events are the only data source.
    (this.provider as { clearDemoEntries?: (id: string) => void }).clearDemoEntries?.(SESSION);
    this.setRunningStatus('done');
  }

  /** Start the showcase from scratch. Idempotent while already playing. */
  play(): ShowcasePhase {
    if (this.phase === 'playing') {
      return this.phase;
    }
    this.clearTimers();
    this.resetRunningConversation();
    this.phase = 'playing';

    // 1. Pretend the user sends a message (full round-trip: start + end).
    this.at(T.user, () => {
      this.broadcast({ type: 'agent_start', sessionId: SESSION });
      const user = userMessage(USER_PROMPT);
      this.broadcast({
        type: 'message_start',
        sessionId: SESSION,
        messageId: 'showcase-user',
        message: user,
      });
      this.broadcast({
        type: 'message_end',
        sessionId: SESSION,
        messageId: 'showcase-user',
        message: user,
      });
    });

    // 2. Assistant: empty start, then thinking + a chain of tool calls
    //    (each update carries the accumulated message, like real pi frames).
    this.at(T.assistantStart, () => {
      this.broadcast({
        type: 'message_start',
        sessionId: SESSION,
        messageId: 'showcase-1',
        message: assistantMessage([]),
      });
    });
    this.at(T.thinking, () => {
      this.broadcast({
        type: 'message_update',
        sessionId: SESSION,
        messageId: 'showcase-1',
        message: assistantMessage([{ type: 'thinking', thinking: THINKING }]),
        assistantMessageEvent: { id: 'showcase-1', thinking_delta: { delta: THINKING } },
      });
    });
    this.at(T.tool1, () => {
      this.broadcast({
        type: 'message_update',
        sessionId: SESSION,
        messageId: 'showcase-1',
        message: assistantMessage([
          { type: 'thinking', thinking: THINKING },
          { type: 'toolCall', ...TOOL1 },
        ]),
        assistantMessageEvent: {
          id: 'showcase-1',
          toolcall_delta: { delta: JSON.stringify(TOOL1) },
        },
      });
    });
    this.at(T.tool2, () => {
      this.broadcast({
        type: 'message_update',
        sessionId: SESSION,
        messageId: 'showcase-1',
        message: assistantMessage([
          { type: 'thinking', thinking: THINKING },
          { type: 'toolCall', ...TOOL1 },
          { type: 'toolCall', ...TOOL2 },
        ]),
        assistantMessageEvent: {
          id: 'showcase-1',
          toolcall_delta: { delta: JSON.stringify(TOOL2) },
        },
      });
    });
    this.at(T.tool3, () => {
      this.broadcast({
        type: 'message_update',
        sessionId: SESSION,
        messageId: 'showcase-1',
        message: assistantMessage([
          { type: 'thinking', thinking: THINKING },
          { type: 'toolCall', ...TOOL1 },
          { type: 'toolCall', ...TOOL2 },
          { type: 'toolCall', ...TOOL3 },
        ]),
        assistantMessageEvent: {
          id: 'showcase-1',
          toolcall_delta: { delta: JSON.stringify(TOOL3) },
        },
      });
    });
    this.at(T.assistantEnd, () => {
      this.broadcast({
        type: 'message_end',
        sessionId: SESSION,
        messageId: 'showcase-1',
        id: 'showcase-1',
        message: assistantMessage([
          { type: 'thinking', thinking: THINKING },
          { type: 'toolCall', ...TOOL1 },
          { type: 'toolCall', ...TOOL2 },
          { type: 'toolCall', ...TOOL3 },
        ]),
      });
    });

    // 3. Tool results stream back one by one.
    const results: Array<[string, string, string, string]> = [
      ['showcase-r1', 'showcase-tool-1', 'bash', 'pi 0.83.0 (local)'],
      [
        'showcase-r2',
        'showcase-tool-2',
        'get_commands',
        '42 commands · skills 12 · prompt templates 18 · extensions 12',
      ],
      ['showcase-r3', 'showcase-tool-3', 'file_read', 'PiHub — local web console for the pi coding agent.'],
    ];
    const resultTimes = [T.result1, T.result2, T.result3];
    results.forEach(([messageId, toolCallId, toolName, text], index) => {
      const when = resultTimes[index];
      if (when === undefined) {
        return;
      }
      this.at(when, () => {
        const result = toolResultMessage(toolCallId, toolName, text);
        this.broadcast({
          type: 'message_start',
          sessionId: SESSION,
          messageId,
          message: result,
        });
        this.broadcast({ type: 'message_end', sessionId: SESSION, messageId, message: result });
      });
    });

    // 4. The final reply types out in deltas (frontend typewriter reveal).
    this.at(T.textStart, () => {
      this.broadcast({
        type: 'message_start',
        sessionId: SESSION,
        messageId: 'showcase-2',
        message: assistantMessage([{ type: 'text', text: '' }]),
      });
    });
    const blockTimes = [T.text1, T.text2, T.text3, T.settle - 500];
    TEXT_BLOCKS.forEach((block, index) => {
      const when = blockTimes[index];
      if (when === undefined) {
        return;
      }
      this.at(when, () => {
        const accumulated = TEXT_BLOCKS.slice(0, index + 1).join('');
        this.broadcast({
          type: 'message_update',
          sessionId: SESSION,
          messageId: 'showcase-2',
          message: assistantMessage([{ type: 'text', text: accumulated }]),
          assistantMessageEvent: {
            id: 'showcase-2',
            text_delta: { delta: block },
          },
        });
      });
    });
    this.at(T.settle, () => {
      this.broadcast({
        type: 'message_end',
        sessionId: SESSION,
        messageId: 'showcase-2',
        id: 'showcase-2',
        message: assistantMessage([{ type: 'text', text: FINAL_TEXT }]),
      });
      this.setRunningStatus('done');
      this.broadcast({ type: 'agent_settled', sessionId: SESSION });
      this.phase = 'settled';
    });
    return this.phase;
  }

  /** Cancel any half-finished play and return to idle. */
  stop(): ShowcasePhase {
    this.clearTimers();
    this.phase = 'idle';
    return this.phase;
  }
}
