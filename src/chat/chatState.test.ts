import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '../../shared/types.js';
import { chatReducer, initialState, type ChatMessage } from './chatState.js';

const assistant = (text: string): AgentMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  timestamp: 1,
});

describe('chat reducer completion', () => {
  it('settles the final assistant message without hiding its completed text', () => {
    const message: ChatMessage = {
      key: 'assistant-1', message: assistant('final answer'), isStreaming: true,
    };
    const state = { ...initialState(), messages: [message], isAgentRunning: true, runStartedAt: 100 };

    const settled = chatReducer(state, { type: 'runSettled', at: 350 });
    expect(settled.messages[0]?.isStreaming).toBe(false);
    expect(settled.messages[0]?.message).toEqual(message.message);
    expect(settled.lastRun).toEqual({ durationMs: 250, aborted: false });
  });

  it('adds optional entry ids without replacing transcript messages', () => {
    const messages: ChatMessage[] = [
      { key: 'a', message: assistant('one'), isStreaming: false },
      { key: 'b', message: assistant('two'), isStreaming: false },
    ];
    const next = chatReducer({ ...initialState(), messages }, {
      type: 'entryIds', ids: ['entry-a', 'entry-b'],
    });
    expect(next.messages.map((message) => message.entryId)).toEqual(['entry-a', 'entry-b']);
    expect(next.messages.map((message) => message.message)).toEqual(messages.map((message) => message.message));
  });
});
