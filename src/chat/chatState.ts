import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { AgentMessage, RpcState, RpcStreamEvent } from '../../shared/types.js';
import { api, type PromptImage } from '../api/client.js';
import { eventsUrl } from '../api/controlToken.js';
import { loadSessionDraft } from './sessionDraft.js';

/** Which agent the chat view is talking to. Switching agents remounts the
 *  chat (clean message list); SSE events carry `kind` so each agent's stream
 *  only renders in its own view. */
export type PanelAgent = 'pi' | 'codex' | 'dsh' | 'claude';

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

export interface ChatState {
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

export type ChatAction =
  | { type: 'reset'; messages: ChatMessage[]; rpcState: RpcState | null }
  | { type: 'entryIds'; ids: string[] }
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

export function initialState(): ChatState {
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

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
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
    case 'entryIds': {
      let cursor = 0;
      const messages = state.messages.map((message) => {
        const id = action.ids[cursor];
        if (id === undefined) {
          return message;
        }
        cursor += 1;
        return { ...message, entryId: id };
      });
      return { ...state, messages };
    }
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
    case 'runSettled': {
      const messages = [...state.messages];
      const last = messages[messages.length - 1];
      if (last !== undefined && last.message.role === 'assistant' && last.isStreaming) {
        messages[messages.length - 1] = { ...last, isStreaming: false };
      }
      if (state.runStartedAt !== null) {
        return {
          ...state,
          messages,
          isAgentRunning: false,
          runStartedAt: null,
          lastRun: {
            durationMs: Math.max(0, action.at - state.runStartedAt),
            aborted: state.runAbortedFlag,
          },
          runAbortedFlag: false,
        };
      }
      return { ...state, messages, isAgentRunning: false };
    }
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


/** Extract the plain text of an agent message for the offline cache. */
function textOf(message: AgentMessage): string {
  if (message.role === 'bashExecution') {
    return message.output;
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block !== null && typeof block === 'object') {
        const record = block as Record<string, unknown>;
        if (typeof record['text'] === 'string') {
          parts.push(record['text']);
        }
      }
    }
    return parts.join('\n');
  }
  return '';
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
    record['role'] === 'bashExecution' ||
    record['role'] === 'notice'
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
  // the streamed showcase events fill it in). In codex mode the messages
  // come from the codex adapter (rollout history + live turns), so switching
  // agents or refreshing keeps the full conversation visible.
  // P1-08e: stale-load guard — rapid session switching can fire several
  // reloads; only the newest request may dispatch, older ones drop their
  // result instead of blanking/replacing the freshly loaded conversation.
  const reloadSeq = useRef(0);
  // dsh web chat (stage 3): when the server routes dsh prompts through a
  // real web session, the answer streams in as dsh_web_event frames —
  // accumulate text here and mirror it into the last assistant message.
  const webRunRef = useRef<{ active: boolean; buffer: string; sessionId: string | null }>({
    active: false,
    buffer: '',
    sessionId: null,
  });
  const reload = useCallback(async (): Promise<void> => {
    const seq = reloadSeq.current + 1;
    reloadSeq.current = seq;
    try {
      let messagesRes: { messages: unknown[] };
      let stateRes: RpcState | null = null;
      if (agent === 'codex') {
        messagesRes = await api.codexMessages();
      } else if (agent === 'dsh') {
        messagesRes = await api.dshMessages();
      } else if (agent === 'claude') {
        messagesRes = await api.claudeMessages();
      } else {
        const [piMessages, piState] = await Promise.all([api.rpcMessages(), api.rpcState()]);
        messagesRes = piMessages;
        stateRes = piState;
      }
      const rawMessages = Array.isArray(messagesRes.messages) ? messagesRes.messages : [];
      const chatMessages: ChatMessage[] = rawMessages
        .filter(isAgentMessage)
        .map((message) => ({ key: makeKey(), message, isStreaming: false }));
      if (reloadSeq.current !== seq) {
        return; // a newer reload superseded this one — drop stale data
      }
      dispatch({
        type: 'reset',
        messages: chatMessages,
        rpcState: agent === 'codex' || agent === 'dsh' || agent === 'claude' ? null : stateRes,
      });
      // Entry ids are optional branch metadata. Pi 0.73.1 may take the full
      // RPC timeout before rejecting get_entries, so never hold the visible
      // transcript or live reasoning behind this capability probe.
      if (agent === 'pi') {
        void api.rpcEntries().then((entriesRes) => {
          if (reloadSeq.current !== seq || !Array.isArray(entriesRes.entries)) {
            return;
          }
          dispatch({
            type: 'entryIds',
            ids: entriesRes.entries
              .filter((entry) => entry.message !== undefined)
              .map((entry) => entry.id),
          });
        }).catch(() => {
          // Branch controls remain disabled when this optional RPC is absent.
        });
      }
      // Offline cache: keep the last successful load per agent so a
      // disconnected bridge still renders history instead of hanging.
      try {
        localStorage.setItem(
          `pi-panel:chat-cache:${agent}`,
          JSON.stringify(
            chatMessages.map((m) => ({ role: m.message.role, text: textOf(m.message) })),
          ),
        );
      } catch {
        // cache best-effort
      }
    } catch (error) {
      if (reloadSeq.current !== seq) {
        return;
      }
      // Prefer the local cache over a blank hang (agent disconnected).
      let cached: unknown = null;
      try {
        cached = JSON.parse(localStorage.getItem(`pi-panel:chat-cache:${agent}`) ?? 'null') as unknown;
      } catch {
        cached = null;
      }
      const cachedMessages: ChatMessage[] = Array.isArray(cached)
        ? (cached as Array<{ role?: unknown; text?: unknown }>)
            .filter((entry) => typeof entry.text === 'string')
            .map((entry) => ({
              key: makeKey(),
              message: {
                role: entry.role === 'assistant' ? 'assistant' : 'user',
                content: [{ type: 'text', text: String(entry.text) }],
                timestamp: Date.now(),
              },
              isStreaming: false,
            }))
        : [];
      dispatch({ type: 'reset', messages: cachedMessages, rpcState: null });
      dispatch({
        type: 'error',
        error:
          (error instanceof Error ? error.message : String(error)) +
          (cachedMessages.length > 0 ? ' — 显示本地缓存（agent 可能已断开）' : ''),
      });
    }
  }, [agent]);

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
      // dsh web chat: real-time frames from a connected dsh web instance
      // stream the assistant text into the active dsh conversation.
      if (
        agent === 'dsh' &&
        (parsed as Record<string, unknown>)['type'] === 'dsh_web_event' &&
        webRunRef.current.active
      ) {
        const record = parsed as Record<string, unknown>;
        const frameType = typeof record['frameType'] === 'string' ? record['frameType'] : '';
        if (frameType === 'session/event') {
          const event = record['event'] as { data?: Record<string, unknown> } | undefined;
          const data = event === undefined ? null : (event.data ?? null);
          const text = data !== null && typeof data['text'] === 'string' ? data['text'] : null;
          if (text !== null && text.length > 0) {
            webRunRef.current.buffer += text;
            dispatch({
              type: 'updateLast',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: webRunRef.current.buffer }],
                timestamp: Date.now(),
              },
            });
          }
          return;
        }
        if (frameType === 'session/projection' && record['running'] === false) {
          webRunRef.current.active = false;
          dispatch({ type: 'runSettled', at: Date.now() });
          return;
        }
        return;
      }
      // Route by agent kind: codex/dsh events carry their kind, pi events do
      // not — an event only renders in the view of its own agent.
      if (kind === 'codex') {
        if (agent !== 'codex') return;
      } else if (kind === 'dsh') {
        if (agent !== 'dsh') return;
      } else if (kind === 'claude') {
        if (agent !== 'claude') return;
      } else if (agent === 'codex' || agent === 'dsh' || agent === 'claude') {
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
    // rpcState is a pi-only surface. DSH, Codex and Claude expose their own
    // state/events; probing the pi bridge here turns a healthy non-pi chat
    // into a misleading RPC timeout on devices without pi.
    if (agent !== 'pi') {
      return;
    }
    try {
      const stateRes = await api.rpcState();
      dispatch({ type: 'rpcState', rpcState: stateRes });
    } catch (error) {
      dispatch({
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [agent]);

  const sendPrompt = useCallback(
    async (text: string, images?: PromptImage[]): Promise<void> => {
      try {
        if (agent === 'codex') {
          await api.codexPrompt(text, loadSessionDraft()?.cwd);
        } else if (agent === 'dsh') {
          const result = await api.dshPrompt(text, loadSessionDraft()?.cwd);
          if (result.data?.mode === 'web' && typeof result.data.sessionId === 'string') {
            // Web-routed: the answer streams in via dsh_web_event frames.
            webRunRef.current = { active: true, buffer: '', sessionId: result.data.sessionId };
            dispatch({ type: 'agentRunning', running: true });
            dispatch({
              type: 'push',
              message: { role: 'user' as const, content: [{ type: 'text', text }], timestamp: Date.now() },
            });
          }
        } else if (agent === 'claude') {
          await api.claudePrompt(text, loadSessionDraft()?.cwd);
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
          await api.codexPrompt(text, loadSessionDraft()?.cwd);
        } else if (agent === 'dsh') {
          if (webRunRef.current.active && webRunRef.current.sessionId !== null) {
            await api.dshWebPrompt(webRunRef.current.sessionId, text, 'steer');
          } else {
            // Headless DSH has no persistent run to steer; continue as a new task.
            await api.dshPrompt(text, loadSessionDraft()?.cwd);
          }
        } else if (agent === 'claude') {
          // claude has no steer surface; a steer becomes a continuation.
          await api.claudePrompt(text, loadSessionDraft()?.cwd);
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
      } else if (agent === 'claude') {
        await api.claudeAbort();
      } else if (agent === 'dsh' && webRunRef.current.active && webRunRef.current.sessionId !== null) {
        await api.dshWebCancel(webRunRef.current.sessionId);
        webRunRef.current = { active: false, buffer: '', sessionId: null };
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
