import { useCallback, useEffect, useReducer } from 'react';
import type { AgentMessage, RpcState, RpcStreamEvent } from '../../shared/types.js';
import { api } from '../api/client.js';

export interface ChatMessage {
  key: string;
  message: AgentMessage;
  isStreaming: boolean;
}

interface ChatState {
  messages: ChatMessage[];
  isAgentRunning: boolean;
  pendingSteer: string[];
  pendingFollowUp: string[];
  rpcState: RpcState | null;
  error: string | null;
}

type ChatAction =
  | { type: 'reset'; messages: ChatMessage[]; rpcState: RpcState | null }
  | { type: 'push'; message: AgentMessage }
  | { type: 'updateLast'; message: AgentMessage }
  | { type: 'markStreaming'; streaming: boolean }
  | { type: 'agentRunning'; running: boolean }
  | { type: 'queue'; steer: string[]; followUp: string[] }
  | { type: 'rpcState'; rpcState: RpcState }
  | { type: 'error'; error: string };

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
  };
}

function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'reset':
      return { ...state, messages: action.messages, rpcState: action.rpcState, error: null };
    case 'push': {
      const next: ChatMessage[] = [
        ...state.messages,
        { key: makeKey(), message: action.message, isStreaming: false },
      ];
      return { ...state, messages: next };
    }
    case 'updateLast': {
      if (state.messages.length === 0) {
        return {
          ...state,
          messages: [
            { key: makeKey(), message: action.message, isStreaming: state.isAgentRunning },
          ],
        };
      }
      const messages = [...state.messages];
      const last = messages[messages.length - 1];
      if (last === undefined || last.message.role !== 'assistant') {
        messages.push({
          key: makeKey(),
          message: action.message,
          isStreaming: state.isAgentRunning,
        });
      } else {
        messages[messages.length - 1] = { ...last, message: action.message };
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
    case 'agentRunning':
      return { ...state, isAgentRunning: action.running };
    case 'queue':
      return { ...state, pendingSteer: action.steer, pendingFollowUp: action.followUp };
    case 'rpcState':
      return { ...state, rpcState: action.rpcState };
    case 'error':
      return { ...state, error: action.error };
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
      return { type: 'agentRunning', running: false };
    case 'message_start':
      if (isAgentMessage(event['message'])) {
        return { type: 'push', message: event['message'] };
      }
      return null;
    case 'message_update':
      if (isAgentMessage(event['message'])) {
        return { type: 'updateLast', message: event['message'] };
      }
      return null;
    case 'message_end':
      if (isAgentMessage(event['message'])) {
        return { type: 'updateLast', message: event['message'] };
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
    case 'auto_retry_start': {
      const message = event['errorMessage'];
      const detail = typeof message === 'string' ? message : 'retrying';
      return { type: 'error', error: detail };
    }
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
  sendPrompt: (text: string) => Promise<void>;
  sendSteer: (text: string) => Promise<void>;
  abort: () => Promise<void>;
  setModel: (provider: string, modelId: string) => Promise<void>;
  setThinkingLevel: (level: string) => Promise<void>;
  refreshState: () => Promise<void>;
}

export function useChatSession(): ChatSession {
  const [state, dispatch] = useReducer(chatReducer, undefined, initialState);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const [messagesRes, stateRes] = await Promise.all([api.rpcMessages(), api.rpcState()]);
        if (cancelled) {
          return;
        }
        const rawMessages = Array.isArray(messagesRes.messages) ? messagesRes.messages : [];
        const chatMessages: ChatMessage[] = rawMessages
          .filter(isAgentMessage)
          .map((message) => ({ key: makeKey(), message, isStreaming: false }));
        dispatch({ type: 'reset', messages: chatMessages, rpcState: stateRes });
      } catch (error) {
        if (!cancelled) {
          dispatch({
            type: 'error',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const source = new EventSource('/api/events');
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
      const action = eventToAction(parsed as RpcStreamEvent);
      if (action !== null) {
        dispatch(action);
      }
    };
    source.addEventListener('pi', onPiEvent);
    return () => {
      source.close();
    };
  }, []);

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

  const sendPrompt = useCallback(async (text: string): Promise<void> => {
    try {
      await api.prompt(text);
      void refreshState();
    } catch (error) {
      dispatch({
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [refreshState]);

  const sendSteer = useCallback(async (text: string): Promise<void> => {
    try {
      await api.steer(text);
      void refreshState();
    } catch (error) {
      dispatch({
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [refreshState]);

  const abort = useCallback(async (): Promise<void> => {
    try {
      await api.abort();
    } catch (error) {
      dispatch({
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

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
    sendPrompt,
    sendSteer,
    abort,
    setModel,
    setThinkingLevel,
    refreshState,
  };
}
