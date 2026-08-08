import type { RpcStreamEvent, RpcResponse, ExtensionUiRequest } from '../../shared/types.js';

/**
 * P2-01: AgentAdapter — the protocol-neutral control surface for a coding
 * agent backend. pi is the first adapter (wraps the existing RpcBridge
 * semantics without breaking the current protocol surface); a codex adapter
 * (spawn `codex exec --json`, stdio JSONL frames) and read-only codex
 * history integration follow in this sprint.
 *
 * Design rules:
 *  - Commands are the SMALLEST common set; agent-specific power stays in
 *    typed extension fields (pi.* / codex.*) instead of being flattened.
 *  - Raw protocol payloads are always preserved (never normalized away) —
 *    normalization happens in the semantic layer on top.
 *  - The adapter never touches credentials (auth.json of either agent).
 */

/** Which agent backend a session/message belongs to (for UI coloring). */
export type AgentKind = 'pi' | 'codex';

export interface AgentMeta {
  kind: AgentKind;
  /** Human label, e.g. "pi" / "Codex". */
  label: string;
  /** Detected CLI version (probe at startup), or null when unknown. */
  version: string | null;
  /** Default accent color for this adapter (overridable in settings). */
  defaultColor: string;
}

/** Minimal common command surface. Extension fields keep agent power. */
export type AgentCommand =
  | { type: 'prompt'; message: string; streamingBehavior?: 'steer' | 'followUp' }
  | { type: 'steer'; message: string }
  | { type: 'abort' }
  | { type: 'switch_session'; sessionId: string }
  | { type: 'set_model'; provider: string; modelId: string }
  | { type: 'set_thinking_level'; level: string }
  | { type: 'get_state' }
  | { type: 'get_messages' }
  | { type: 'get_tree' };

/** Adapter responses keep the raw shape (success/error + optional data). */
export type AgentResponse = RpcResponse;

/**
 * Semantic events emitted by adapters. This is the P2-01b normalization
 * layer's input: UI consumes these instead of raw per-agent frames, so a
 * second backend does not force UI rewrites.
 */
export type AgentEvent =
  | { type: 'agent_start'; runId?: string; sessionId?: string }
  | { type: 'agent_end'; runId?: string; sessionId?: string }
  | { type: 'agent_settled'; runId?: string; sessionId?: string }
  | { type: 'message_update'; runId?: string; sessionId?: string; message: unknown }
  | { type: 'model_change'; runId?: string; sessionId?: string; provider: string; modelId: string }
  | { type: 'thinking_level_change'; runId?: string; sessionId?: string; level: string }
  | { type: 'compaction_start' }
  | { type: 'compaction_end' }
  | { type: 'pipeline_step'; run: unknown }
  /** Adapter extension frames relayed untouched (e.g. pi extension UI). */
  | { type: 'adapter_extension'; kind: AgentKind; payload: unknown };

export interface AgentAdapterEvents {
  event: (event: AgentEvent) => void;
  'ui-request': (request: ExtensionUiRequest) => void;
  response: (response: RpcResponse) => void;
  exit: (code: number | null) => void;
  error: (error: Error) => void;
}

/** Protocol-neutral lifecycle + command surface (P2-01a). */
export interface AgentAdapter {
  readonly meta: AgentMeta;
  isRunning(): boolean;
  start(): void;
  stop(): void;
  restart(): void;
  send(command: AgentCommand): Promise<AgentResponse>;
  on<K extends keyof AgentAdapterEvents>(
    event: K,
    listener: AgentAdapterEvents[K],
  ): unknown;
  off<K extends keyof AgentAdapterEvents>(
    event: K,
    listener: AgentAdapterEvents[K],
  ): unknown;
}

/** Bridges one raw RpcStreamEvent frame into semantic AgentEvent(s). */
export function normalizePiEvent(raw: RpcStreamEvent): AgentEvent[] {
  const envelope = {
    ...(typeof raw.sessionId === 'string' ? { sessionId: raw.sessionId } : {}),
    ...(typeof raw.runId === 'string' ? { runId: raw.runId } : {}),
  };
  switch (raw.type) {
    case 'agent_start':
      return [{ type: 'agent_start', ...envelope }];
    case 'agent_end':
      return [{ type: 'agent_end', ...envelope }];
    case 'agent_settled':
      return [{ type: 'agent_settled', ...envelope }];
    case 'message_update':
      return [{ type: 'message_update', ...envelope, message: raw.message }];
    case 'model_change':
      return [
        {
          type: 'model_change',
          ...envelope,
          provider: typeof raw.provider === 'string' ? raw.provider : '',
          modelId: typeof raw.modelId === 'string' ? raw.modelId : '',
        },
      ];
    case 'thinking_level_change':
      return [
        {
          type: 'thinking_level_change',
          ...envelope,
          level: typeof raw.thinkingLevel === 'string' ? raw.thinkingLevel : '',
        },
      ];
    case 'compaction_start':
      return [{ type: 'compaction_start' }];
    case 'compaction_end':
      return [{ type: 'compaction_end' }];
    case 'pipeline_step':
      return [{ type: 'pipeline_step', run: raw.run }];
    default:
      // Unknown extension frames are relayed untouched so nothing is lost.
      return [{ type: 'adapter_extension', kind: 'pi', payload: raw }];
  }
}
