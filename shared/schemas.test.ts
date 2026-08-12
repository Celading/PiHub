import { describe, expect, it } from 'vitest';
import {
  agentMessageSchema,
  extensionUiRequestSchema,
  messageEventSchema,
  rpcStreamEventSchema,
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
      cwd: '/workspace/HarmonyHap',
    };
    const result = sessionHeaderEventSchema.safeParse(line);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe('019fd094-b438-7ae1-aa20-9a873849a222');
      expect(result.data.cwd).toContain('/workspace');
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

describe('extension UI request schema (P1-01)', () => {
  it('parses a select dialog request', () => {
    const frame = {
      type: 'extension_ui_request',
      id: 'sel-1',
      method: 'select',
      title: 'Pick a model',
      options: ['a', 'b', 'c'],
      timeout: 10000,
    };
    const result = extensionUiRequestSchema.safeParse(frame);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.method).toBe('select');
      if (result.data.method === 'select') {
        expect(result.data.options).toHaveLength(3);
        expect('timeout' in result.data ? result.data.timeout : undefined).toBe(10000);
      }
    }
  });

  it('parses confirm / input / editor / notify / status / widget / title frames', () => {
    const frames = [
      { type: 'extension_ui_request', id: 'c1', method: 'confirm', title: 'OK?', message: 'really?' },
      { type: 'extension_ui_request', id: 'i1', method: 'input', title: 'Name', placeholder: 'x' },
      { type: 'extension_ui_request', id: 'e1', method: 'editor', title: 'Edit', prefill: 'hello' },
      { type: 'extension_ui_request', id: 'n1', method: 'notify', message: 'done', notifyType: 'warning' },
      { type: 'extension_ui_request', id: 's1', method: 'setStatus', statusKey: 'run', statusText: 'busy' },
      { type: 'extension_ui_request', id: 'w1', method: 'setWidget', widgetKey: 'stats', widgetLines: ['1', '2'] },
      { type: 'extension_ui_request', id: 't1', method: 'setTitle', title: 'PiHub' },
      { type: 'extension_ui_request', id: 'x1', method: 'set_editor_text', text: 'content' },
    ];
    for (const frame of frames) {
      const result = extensionUiRequestSchema.safeParse(frame);
      expect(result.success).toBe(true);
    }
  });

  it('rejects unknown methods', () => {
    const bad = { type: 'extension_ui_request', id: 'x', method: 'explode' };
    expect(extensionUiRequestSchema.safeParse(bad).success).toBe(false);
  });
});

describe('rpc stream event schema', () => {
  it('validates type and preserves protocol fields (passthrough)', () => {
    const frame = {
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      assistantMessageEvent: { id: 'm1', parentId: null },
    };
    const result = rpcStreamEventSchema.safeParse(frame);
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      expect(data['message']).toEqual(frame.message);
      expect(data['assistantMessageEvent']).toEqual(frame.assistantMessageEvent);
    }
  });

  it('rejects non-object lines without a string type', () => {
    expect(rpcStreamEventSchema.safeParse('garbage').success).toBe(false);
    expect(rpcStreamEventSchema.safeParse({ type: 42 }).success).toBe(false);
  });
});

describe('provider-tolerant content blocks (P1-12 E)', () => {
  it('keeps unknown block types without failing the message', () => {
    const result = agentMessageSchema.safeParse({
      role: 'assistant',
      content: [
        { type: 'text', text: 'visible answer' },
        { type: 'reasoning', content: 'volcengine-style hidden reasoning' },
      ],
      timestamp: Date.now(),
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.role === 'assistant') {
      const blocks = result.data.content;
      expect(Array.isArray(blocks)).toBe(true);
      if (Array.isArray(blocks)) {
        const texts = blocks.filter(
          (block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text',
        );
        expect(texts).toHaveLength(1);
        // unknown block survives as a generic object
        expect(
          blocks.some((block) => (block as { type?: string }).type === 'reasoning'),
        ).toBe(true);
      }
    }
  });

  it('degrades malformed known blocks instead of dropping the message', () => {
    const result = agentMessageSchema.safeParse({
      role: 'assistant',
      content: [{ type: 'text', text: 42 }],
      timestamp: Date.now(),
    });
    // The loose union keeps the message alive; the renderer guards the
    // block shape at runtime (P1-12 E).
    expect(result.success).toBe(true);
  });
});
