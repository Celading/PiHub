import { useCallback, useEffect, useReducer } from 'react';
import type { AgentMessage, RpcState, RpcStreamEvent } from '../../shared/types.js';
import { api, type PromptImage } from '../api/client.js';
import { eventsUrl } from '../api/controlToken.js';

/** Which agent the chat view is talking to. Switching agents remounts the
 *  chat (clean message list); SSE events carry `kind` so each agent's stream
 *  only renders in its own view. */
export type PanelAgent = 'pi' | 'codex';

export interface ChatMessage {
  key: string;
  message: AgentMessage;
  isStreaming: boolean;
  /** pi session-tree node id (get_entries / runtime events); used to fork
   *  a branch at this message. Absent for history reloads without a tree. */
  entryId?: string;
}

export interface RunSummary {
  /** Duration of the last completed run, computed from the prompt message
   *  timestamp (or agent start as fallback) to agent settle. */
  durationMs: number;
  aborted: boolean;
}

interface ChatState {
  messages: ChatMessage[];
  isAgentRunning: boolean;
  pendingSteer: string[];
  pendingFollowUp: string[];
  rpcState: RpcState | null;
  error: string | null;
  /** Start of the current run (epoch ms). Null when idle. */
  runStartedAt: number | null;
  /** Summary of the most recent completed run. */
  lastRun: RunSummary | null;
  /** Set when the user aborts the current run (cleared on settle). */
  runAbortedFlag: boolean;
  /** True while pi is auto-retrying after a failure (banner). */
  retrying: boolean;
  /** P1-17 D: initial session load finished (drives the chat skeleton). */
  hasLoaded: boolean;
}

type ChatAction =
  | { type: 'reset'; messages: ChatMessage[]; rpcState: RpcState | null }
  | { type: 'push'; message: AgentMessage }
  | { type: 'updateLast'; message: AgentMessage; entryId?: string }
  | { type: 'markStreaming'; streaming: boolean }
  | { type: 'agentRunning'; running: boolean }
  | { type: 'queue'; steer: string[]; followUp: string[] }
  | { type: 'rpcState'; rpcState: RpcState }
  | { type: 'error'; error: string }
  | { type: 'runSettled'; at: number }
  | { type: 'runAborted' }
  | { type: 'retrying'; retrying: boolean }
  | { type: 'clearAfter'; key: string };

let nextKey = 0;

const makeKey = (): string => {
  const key = `m${String(nextKey)}`;
  nextKey += 1;
  return key;
};

function initialState(): ChatState {
  return {
    messages: [],
    isAgentRunning: false,
    pendingSteer: [],
    pendingFollowUp: [],
    rpcState: null,
    error: null,
    runStartedAt: null,
    lastRun: null,
    runAbortedFlag: false,
    retrying: false,
    hasLoaded: false,
  };
}

function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'reset':
      return {
        ...state,
        messages: action.messages,
        rpcState: action.rpcState,
        error: null,
        runStartedAt: null,
        lastRun: null,
        runAbortedFlag: false,
        hasLoaded: true,
      };
    case 'push': {
      const next: ChatMessage[] = [
        ...state.messages,
        { key: makeKey(), message: action.message, isStreaming: false },
      ];
      const runStartedAt =
        action.message.role === 'user' &&
        typeof action.message.timestamp === 'number' &&
        action.message.timestamp > 0 &&
        state.runStartedAt === null
          ? action.message.timestamp
          : state.runStartedAt;
      return { ...state, messages: next, runStartedAt };
    }
    case 'updateLast': {
      if (state.messages.length === 0) {
        return {
          ...state,
          messages: [
            {
              key: makeKey(),
              message: action.message,
              isStreaming: state.isAgentRunning,
              ...(action.entryId === undefined ? {} : { entryId: action.entryId }),
            },
          ],
        };
      }
      const messages = [...state.messages];
      const last = messages[messages.length - 1];
      // Same-role → replace in place (covers user message_end after
      // message_start, and assistant streaming updates). Different role →
      // append. Previously only assistant was updated, so user message_end
      // pushed a duplicate of the just-started user turn.
      if (last !== undefined && last.message.role === action.message.role) {
        messages[messages.length - 1] = {
          ...last,
          message: action.message,
          isStreaming: state.isAgentRunning && action.message.role === 'assistant',
          ...(action.entryId === undefined ? {} : { entryId: action.entryId }),
        };
      } else {
        messages.push({
          key: makeKey(),
          message: action.message,
          isStreaming: state.isAgentRunning && action.message.role === 'assistant',
          ...(action.entryId === undefined ? {} : { entryId: action.entryId }),
        });
      }
      return { ...state, messages };
    }
    case 'markStreaming': {
      const messages = [...state.messages];
      const last = messages[messages.length - 1];
      if (last !== undefined && last.message.role === 'assistant') {
        messages[messages.length - 1] = { ...last, isStreaming: action.streaming };
      }
      return { ...state, messages };
    }
    case 'agentRunning': {
      if (action.running) {
        // Anchor the run clock at the prompt message timestamp when known;
        // fall back to the agent-start moment.
        const runStartedAt = state.runStartedAt ?? Date.now();
        return { ...state, isAgentRunning: true, runStartedAt, lastRun: null };
      }
      return { ...state, isAgentRunning: false };
    }
    case 'runSettled':
      if (state.runStartedAt !== null) {
        return {
          ...state,
          isAgentRunning: false,
          runStartedAt: null,
          lastRun: {
            durationMs: Math.max(0, action.at - state.runStartedAt),
            aborted: state.runAbortedFlag,
          },
          runAbortedFlag: false,
        };
      }
      return { ...state, isAgentRunning: false };
    case 'runAborted':
      return { ...state, runAbortedFlag: true };
    case 'retrying':
      return { ...state, retrying: action.retrying };
    case 'queue':
      return { ...state, pendingSteer: action.steer, pendingFollowUp: action.followUp };
    case 'rpcState':
      return { ...state, rpcState: action.rpcState };
    case 'error':
      return { ...state, error: action.error, hasLoaded: true };
    case 'clearAfter': {
      // P1-13 D: resending an edited prompt drops everything from that
      // message onward (panel-side display; the pi session file is not
      // rewritten).
      const index = state.messages.findIndex((message) => message.key === action.key);
      if (index === -1) {
        return state;
      }
      return {
        ...state,
        messages: state.messages.slice(0, index),
        isAgentRunning: false,
        runStartedAt: null,
        lastRun: null,
        runAbortedFlag: false,
      };
    }
  }
}

export function isAgentMessage(value: unknown): value is AgentMessage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record['role'] === 'user' ||
    record['role'] === 'assistant' ||
    record['role'] === 'toolResult' ||
    record['role'] === 'bashExecution'
  );
}

function eventToAction(event: RpcStreamEvent): ChatAction | null {
  switch (event.type) {
    case 'agent_start':
      return { type: 'agentRunning', running: true };
    case 'agent_end':
    case 'agent_settled':
      return { type: 'runSettled', at: Date.now() };
    case 'message_start':
      if (isAgentMessage(event['message'])) {
        return { type: 'push', message: event['message'] };
      }
      return null;
    case 'message_update':
      if (isAgentMessage(event['message'])) {
        const assistantEvent = event['assistantMessageEvent'] as { id?: unknown } | undefined;
        const entryId = typeof assistantEvent?.id === 'string' ? assistantEvent.id : undefined;
        return { type: 'updateLast', message: event['message'], ...(entryId === undefined ? {} : { entryId }) };
      }
      return null;
    case 'message_end':
      if (isAgentMessage(event['message'])) {
        const endId = event['id'];
        return {
          type: 'updateLast',
          message: event['message'],
          ...(typeof endId === 'string' ? { entryId: endId } : {}),
        };
      }
      return null;
    case 'queue_update': {
      const steer = event['steering'];
      const followUp = event['followUp'];
      return {
        type: 'queue',
        steer: Array.isArray(steer) ? (steer as string[]) : [],
        followUp: Array.isArray(followUp) ? (followUp as string[]) : [],
      };
    }
    case 'auto_retry_start':
      return { type: 'retrying', retrying: true };
    case 'auto_retry_end':
      return { type: 'retrying', retrying: false };
    default:
      return null;
  }
}

export interface ChatSession {
  messages: ChatMessage[];
  isAgentRunning: boolean;
  pendingSteer: string[];
  pendingFollowUp: string[];
  rpcState: RpcState | null;
  error: string | null;
  retrying: boolean;
  /** Epoch ms when the current run started (null when idle). */
  runStartedAt: number | null;
  /** Duration + abort status of the most recent completed run. */
  lastRun: RunSummary | null;
  /** P1-17 D: initial session load finished (drives the chat skeleton). */
  hasLoaded: boolean;
  sendPrompt: (text: string, images?: PromptImage[]) => Promise<void>;
  sendSteer: (text: string) => Promise<void>;
  abort: () => Promise<void>;
  setModel: (provider: string, modelId: string) => Promise<void>;
  setThinkingLevel: (level: string) => Promise<void>;
  refreshState: () => Promise<void>;
  /** Reloads the session's message list from the server (demo showcase
   *  uses this after resetting the mock conversation). */
  reload: () => Promise<void>;
  /** Drops all messages from `key` onward (edited-prompt resend). */
  clearAfter: (key: string) => void;
}

export function useChatSession(agent: PanelAgent): ChatSession {
  const [state, dispatch] = useReducer(chatReducer, undefined, initialState);

  // Shared loader: initial mount and explicit reloads (demo showcase play
  // resets the mock conversation, then reload sees the empty session and
  // the streamed showcase events fill it in).
  const reload = useCallback(async (): Promise<void> => {
    try {
      const [messagesRes, stateRes] = await Promise.all([api.rpcMessages(), api.rpcState()]);
      // Entry ids are best-effort: a transient failure must not blank the
      // whole chat — messages and state still load, branch buttons just
      // stay disabled until the next run provides ids.
      const entriesRes = await api.rpcEntries().catch(() => null);
      const rawMessages = Array.isArray(messagesRes.messages) ? messagesRes.messages : [];
      const chatMessages: ChatMessage[] = rawMessages
        .filter(isAgentMessage)
        .map((message) => ({ key: makeKey(), message, isStreaming: false }));
      // Align the session-tree entry ids (get_entries) with the message
      // list by order — both sequences follow conversation order.
      if (entriesRes !== null && Array.isArray(entriesRes.entries)) {
        const messageEntryIds = entriesRes.entries
          .filter((entry) => entry.message !== undefined)
          .map((entry) => entry.id);
        chatMessages.forEach((chatMessage, index) => {
          const entryId = messageEntryIds[index];
          if (entryId !== undefined) {
            chatMessage.entryId = entryId;
          }
        });
      }
      dispatch({ type: 'reset', messages: chatMessages, rpcState: stateRes });
    } catch (error) {
      dispatch({
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const source = new EventSource(eventsUrl());
    const onPiEvent = (event: MessageEvent<string>): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data) as unknown;
      } catch {
        return;
      }
      if (typeof parsed !== 'object' || parsed === null) {
        return;
      }
      // Route by agent kind: codex events carry kind:'codex', pi events do
      // not — an event only renders in the view of its own agent.
      const kind = (parsed as Record<string, unknown>)['kind'];
      const isCodexEvent = kind === 'codex';
      if (isCodexEvent !== (agent === 'codex')) {
        return;
      }
      const action = eventToAction(parsed as RpcStreamEvent);
      if (action !== null) {
        dispatch(action);
      }
    };
    source.addEventListener('pi', onPiEvent);
    return () => {
      source.close();
    };
  }, [agent]);

  const refreshState = useCallback(async (): Promise<void> => {
    try {
      const stateRes = await api.rpcState();
      dispatch({ type: 'rpcState', rpcState: stateRes });
    } catch (error) {
      dispatch({
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const sendPrompt = useCallback(
    async (text: string, images?: PromptImage[]): Promise<void> => {
      try {
        if (agent === 'codex') {
          await api.codexPrompt(text);
        } else {
          await api.prompt(text, undefined, images);
        }
        void refreshState();
      } catch (error) {
        dispatch({
          type: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [agent, refreshState],
  );

  const sendSteer = useCallback(
    async (text: string): Promise<void> => {
      try {
        if (agent === 'codex') {
          // codex has no steer command; a steer becomes a continuation.
          await api.codexPrompt(text);
        } else {
          await api.steer(text);
        }
        void refreshState();
      } catch (error) {
        dispatch({
          type: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [agent, refreshState],
  );

  const abort = useCallback(async (): Promise<void> => {
    // Optimistic: mark the run aborted before the RPC response returns —
    // the settle event usually arrives first and must see the flag.
    dispatch({ type: 'runAborted' });
    try {
      if (agent === 'codex') {
        await api.codexAbort();
      } else {
        await api.abort();
      }
    } catch (error) {
      dispatch({
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [agent]);

  const setModel = useCallback(
    async (provider: string, modelId: string): Promise<void> => {
      try {
        await api.setModel(provider, modelId);
        void refreshState();
      } catch (error) {
        dispatch({
          type: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [refreshState],
  );

  const setThinkingLevel = useCallback(
    async (level: string): Promise<void> => {
      try {
        await api.setThinkingLevel(level);
        void refreshState();
      } catch (error) {
        dispatch({
          type: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [refreshState],
  );

  return {
    messages: state.messages,
    isAgentRunning: state.isAgentRunning,
    pendingSteer: state.pendingSteer,
    pendingFollowUp: state.pendingFollowUp,
    rpcState: state.rpcState,
    error: state.error,
    retrying: state.retrying,
    hasLoaded: state.hasLoaded,
    runStartedAt: state.runStartedAt,
    lastRun: state.lastRun,
    sendPrompt,
    sendSteer,
    abort,
    setModel,
    setThinkingLevel,
    refreshState,
    reload,
    clearAfter: (key: string) => {
      dispatch({ type: 'clearAfter', key });
    },
  };
}
