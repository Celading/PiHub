import { EventEmitter } from 'node:events';
import type { RpcBridge } from '../rpc-bridge.js';
import type { RpcStreamEvent } from '../../shared/types.js';
import {
  normalizePiEvent,
  type AgentAdapter,
  type AgentAdapterEvents,
  type AgentCommand,
  type AgentMeta,
  type AgentResponse,
} from './types.js';

/**
 * P2-01a: pi as the first AgentAdapter. Wraps the existing RpcBridge so the
 * current protocol surface (JSONL over stdio, LF framing, id-correlated
 * responses) is untouched — every raw RpcStreamEvent is ALSO emitted as a
 * normalized AgentEvent on this adapter's OWN emitter (raw payload preserved
 * via adapter_extension), so consumers never read raw frames directly.
 */
export class PiAdapter extends EventEmitter implements AgentAdapter {
  readonly meta: AgentMeta = {
    kind: 'pi',
    label: 'pi',
    version: null,
    defaultColor: '#005fb8',
  };

  constructor(private readonly bridge: RpcBridge) {
    super();
    bridge.on('event', (raw: RpcStreamEvent) => {
      for (const event of normalizePiEvent(raw)) {
        this.emit('event', event);
      }
    });
    // Re-broadcast lifecycle so adapter consumers stay protocol-neutral.
    bridge.on('exit', (code: number | null) => this.emit('exit', code));
    bridge.on('error', (error: Error) => this.emit('error', error));
    bridge.on('ui-request', (request) => this.emit('ui-request', request));
    bridge.on('response', (response) => this.emit('response', response));
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
    return this.bridge.isRunning();
  }

  start(): void {
    this.bridge.start();
  }

  stop(): void {
    this.bridge.stop();
  }

  restart(): void {
    this.bridge.restart();
  }

  async send(command: AgentCommand): Promise<AgentResponse> {
    switch (command.type) {
      case 'prompt':
        return this.bridge.send({
          type: 'prompt',
          message: command.message,
          ...(command.streamingBehavior !== undefined
            ? { streamingBehavior: command.streamingBehavior }
            : {}),
        });
      case 'steer':
        return this.bridge.send({ type: 'steer', message: command.message });
      case 'abort':
        return this.bridge.send({ type: 'abort' });
      case 'switch_session':
        return this.bridge.send({ type: 'switch_session', sessionPath: command.sessionId });
      case 'set_model':
        return this.bridge.send({
          type: 'set_model',
          provider: command.provider,
          modelId: command.modelId,
        });
      case 'set_thinking_level':
        return this.bridge.send({ type: 'set_thinking_level', level: command.level });
      case 'get_state':
        return this.bridge.send({ type: 'get_state' });
      case 'get_messages':
        return this.bridge.send({ type: 'get_messages' });
      case 'get_tree':
        return this.bridge.send({ type: 'get_tree' });
      default:
        // Exhaustive switch: unreachable with the current union, kept for
        // future command additions.
        return {
          type: 'response',
          command: (command as AgentCommand).type,
          success: false,
          error: 'pi adapter: unsupported command',
        };
    }
  }
}
