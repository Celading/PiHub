import type { RpcStreamEvent } from '../../shared/types.js';
import type { SseHub } from '../sse.js';
import type { SessionProvider } from '../providers/file-session-provider.js';
import { DEMO_RUNNING_ID } from '../providers/mock-session-provider.js';

export type DemoPhase = 'idle' | 'thinking' | 'tool' | 'streaming' | 'settled' | 'aborted';

/**
 * Demo state machine (KMODE-001 K4): drives a scripted run over the mock
 * dataset. Phases map 1:1 onto the real event stream so the frontend renders
 * the demo with zero mode-specific branches. Broadcasts go through the same
 * SSE hub as production events.
 *
 *   idle → thinking → tool → streaming → settled → idle (via reset)
 *     └──────────────────────────← abort → aborted
 */
export class DemoStateMachine {
  private phase: DemoPhase = 'idle';
  private readonly hub: SseHub;
  private readonly provider: SessionProvider;

  constructor(hub: SseHub, provider: SessionProvider) {
    this.hub = hub;
    this.provider = provider;
  }

  getPhase(): DemoPhase {
    return this.phase;
  }

  private broadcast(event: RpcStreamEvent): void {
    this.hub.broadcast(event);
  }

  private setRunningStatus(status: 'done' | 'aborted'): void {
    // The mock provider derives the demo session's status light from the
    // machine; flip it when the run settles or aborts.
    (this.provider as { setDemoStatus?: (id: string, status: 'done' | 'aborted') => void })
      .setDemoStatus?.(DEMO_RUNNING_ID, status);
  }

  /** idle → thinking: start a scripted run. */
  start(): DemoPhase {
    if (this.phase !== 'idle') {
      return this.phase;
    }
    this.phase = 'thinking';
    this.broadcast({ type: 'agent_start', sessionId: DEMO_RUNNING_ID });
    this.broadcast({
      type: 'message_start',
      sessionId: DEMO_RUNNING_ID,
      messageId: 'demo-msg-1',
    });
    this.broadcast({
      type: 'message_update',
      sessionId: DEMO_RUNNING_ID,
      messageId: 'demo-msg-1',
      assistantMessageEvent: {
        thinking_delta: { delta: 'Setting up the demo run…' },
      },
    });
    return this.phase;
  }

  /** Advance one phase along thinking → tool → streaming → settled. */
  step(): DemoPhase {
    switch (this.phase) {
      case 'thinking': {
        this.phase = 'tool';
        this.broadcast({
          type: 'message_update',
          sessionId: DEMO_RUNNING_ID,
          messageId: 'demo-msg-1',
          assistantMessageEvent: {
            toolcall_delta: { delta: '{"name":"bash","arguments":{"command":"ls ~/.pi/agent/sessions"}}' },
          },
        });
        break;
      }
      case 'tool': {
        this.phase = 'streaming';
        this.broadcast({
          type: 'message_update',
          sessionId: DEMO_RUNNING_ID,
          messageId: 'demo-msg-2',
          assistantMessageEvent: {
            text_delta: { delta: 'PiHub talks to a local `pi --mode rpc` process through a small Node bridge. Everything stays on your machine — no cloud, no accounts.' },
          },
        });
        break;
      }
      case 'streaming': {
        this.phase = 'settled';
        this.setRunningStatus('done');
        this.broadcast({ type: 'message_end', sessionId: DEMO_RUNNING_ID, messageId: 'demo-msg-2' });
        this.broadcast({ type: 'agent_settled', sessionId: DEMO_RUNNING_ID });
        break;
      }
      default:
        break;
    }
    return this.phase;
  }

  /** Any active phase → aborted. */
  abort(): DemoPhase {
    if (this.phase === 'idle' || this.phase === 'settled' || this.phase === 'aborted') {
      return this.phase;
    }
    this.phase = 'aborted';
    this.setRunningStatus('aborted');
    this.broadcast({ type: 'agent_settled', sessionId: DEMO_RUNNING_ID, aborted: true });
    return this.phase;
  }

  reset(): DemoPhase {
    this.phase = 'idle';
    (this.provider as { setDemoStatus?: (id: string, status: 'done' | 'aborted') => void })
      .setDemoStatus?.(DEMO_RUNNING_ID, 'done');
    return this.phase;
  }
}
