import { describe, expect, it } from 'vitest';
import {
  agentMessageSchema,
  messageEventSchema,
  sessionEventSchema,
  sessionHeaderEventSchema,
} from './schemas.js';

describe('session header schema', () => {
  it('parses a real v3 session header line', () => {
    const line = {
      type: 'session',
      version: 3,
      id: '019fd094-b438-7ae1-aa20-9a873849a222',
      timestamp: '2026-08-05T06:20:34.232Z',
      cwd: '/Users/cinyu/Documents/Work0/CureateE/HarmonyHap',
    };
    const result = sessionHeaderEventSchema.safeParse(line);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe('019fd094-b438-7ae1-aa20-9a873849a222');
      expect(result.data.cwd).toContain('HarmonyHap');
    }
  });
});

describe('agent message schema', () => {
  it('parses a user message with text content', () => {
    const message = {
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
      timestamp: 1785911131918,
    };
    const result = agentMessageSchema.safeParse(message);
    expect(result.success).toBe(true);
  });

  it('parses a user message with plain-string content', () => {
    const message = { role: 'user', content: 'Hello!', timestamp: 1 };
    const result = agentMessageSchema.safeParse(message);
    expect(result.success).toBe(true);
  });

  it('parses an assistant message with thinking + text + toolCall + usage', () => {
    const message = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'let me think', thinkingSignature: 'reasoning_content' },
        { type: 'text', text: 'I will run ls' },
        {
          type: 'toolCall',
          id: 'call_00_abc',
          name: 'bash',
          arguments: { command: 'ls -la' },
        },
      ],
      api: 'openai-completions',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      usage: {
        input: 7337,
        output: 405,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 151,
        totalTokens: 7742,
        cost: {
          input: 0.001,
          output: 0.0001,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0.0011,
        },
      },
      stopReason: 'toolUse',
      timestamp: 1785911135500,
    };
    const result = agentMessageSchema.safeParse(message);
    expect(result.success).toBe(true);
    if (result.success && result.data.role === 'assistant') {
      expect(result.data.usage?.cost?.total).toBeCloseTo(0.0011, 6);
      expect(result.data.content[0]?.type).toBe('thinking');
    }
  });

  it('parses a toolResult message with isError', () => {
    const message = {
      role: 'toolResult',
      toolCallId: 'call_00_abc',
      toolName: 'bash',
      content: [{ type: 'text', text: 'total 48\n' }],
      isError: false,
      timestamp: 1785911135600,
    };
    const result = agentMessageSchema.safeParse(message);
    expect(result.success).toBe(true);
    if (result.success && result.data.role === 'toolResult') {
      expect(result.data.toolName).toBe('bash');
      expect(result.data.isError).toBe(false);
    }
  });

  it('rejects messages with an unknown role', () => {
    const message = { role: 'nope', content: [], timestamp: 1 };
    const result = agentMessageSchema.safeParse(message);
    expect(result.success).toBe(false);
  });
});

describe('session event schema', () => {
  it('parses a real message event line', () => {
    const line = {
      type: 'message',
      id: '9426e903',
      parentId: '389b9e9b',
      timestamp: '2026-08-05T06:25:31.922Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '先看看当前项目集' }],
        timestamp: 1785911131918,
      },
    };
    const result = messageEventSchema.safeParse(line);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.parentId).toBe('389b9e9b');
    }
  });

  it('parses thinking/model change events through the union', () => {
    const thinking = {
      type: 'thinking_level_change',
      id: '9fa790a0',
      parentId: null,
      timestamp: '2026-08-05T06:20:34.293Z',
      thinkingLevel: 'off',
    };
    const model = {
      type: 'model_change',
      id: 'e0ae9465',
      parentId: '9fa790a0',
      timestamp: '2026-08-05T06:24:33.958Z',
      provider: 'deepseek',
      modelId: 'deepseek-v4-pro',
    };
    expect(sessionEventSchema.safeParse(thinking).success).toBe(true);
    expect(sessionEventSchema.safeParse(model).success).toBe(true);
  });

  it('rejects unknown event kinds (labels, future kinds)', () => {
    const unknown = {
      type: 'label',
      id: 'x1',
      parentId: null,
      timestamp: '2026-08-05T00:00:00.000Z',
      label: 'branch A',
    };
    const result = sessionEventSchema.safeParse(unknown);
    expect(result.success).toBe(false);
  });

  it('accepts session_info entries (display name)', () => {
    const info = {
      type: 'session_info',
      id: 'a93d11f8',
      parentId: '5f977488',
      timestamp: '2026-08-05T10:44:11.499Z',
      name: 'PiHub Smoke Session',
    };
    const result = sessionEventSchema.safeParse(info);
    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'session_info') {
      expect(result.data.name).toBe('PiHub Smoke Session');
    }
  });
});
