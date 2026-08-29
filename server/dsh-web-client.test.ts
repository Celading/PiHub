import { describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DshWebClient, normalizeDshHistory } from './dsh-web-client.js';

function startMockServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${String(port)}`,
        close: () => {
          server.close();
        },
      });
    });
  });
}

describe('DshWebClient', () => {
  it('normalizes the current 0.0.1 history event ledger', () => {
    expect(normalizeDshHistory({
      events: [
        { event: { type: 'user/message', seq: 8, time: 10, data: {
          id: 'u1', content: [{ type: 'text', text: '你好' }],
        } } },
        { event: { type: 'assistant/message', seq: 45, time: 20, data: {
          message: { id: 'a1', content: [
            { type: 'reasoning', text: 'internal' },
            { type: 'text', text: '你好，需要我做什么？' },
          ] },
        } } },
      ],
    })).toEqual([
      { id: 'u1', role: 'user', text: '你好', timestamp: 10 },
      { id: 'a1', role: 'assistant', text: '你好，需要我做什么？', timestamp: 20 },
    ]);
  });

  it('parses a successful server-response envelope', async () => {
    const mock = await startMockServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += String(chunk);
      });
      req.on('end', () => {
        const message = JSON.parse(body) as { type: string; rpcId: string; method: string };
        expect(message.type).toBe('client-request');
        expect(message.method).toBe('host.describe');
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            type: 'server-response',
            rpcId: message.rpcId,
            result: { ok: true, value: { version: '0.1.0-rc.6', cwd: '/tmp', attachedSessions: 2, canOpenPath: true } },
          }),
        );
      });
    });
    try {
      const client = new DshWebClient({ baseUrl: mock.url, timeoutMs: 5000 });
      const result = await client.describe();
      expect(result.ok).toBe(true);
      const value = result.value as { version: string; attachedSessions: number };
      expect(value.version).toBe('0.1.0-rc.6');
      expect(value.attachedSessions).toBe(2);
    } finally {
      mock.close();
    }
  });

  it('surfaces an rpc error result', async () => {
    const mock = await startMockServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          type: 'server-response',
          rpcId: 'x',
          result: { ok: false, error: { code: 'session/not-found', message: 'no such session' } },
        }),
      );
    });
    try {
      const client = new DshWebClient({ baseUrl: mock.url, timeoutMs: 5000 });
      const result = await client.sessionHistory('missing');
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('session/not-found');
      expect(result.error?.message).toContain('no such session');
    } finally {
      mock.close();
    }
  });

  it('reports transport failures honestly', async () => {
    const client = new DshWebClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 1500 });
    const result = await client.describe();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('transport');
  });

  it('answers an approval via /api/respond with a client-response envelope', async () => {
    let received: unknown = null;
    const mock = await startMockServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += String(chunk);
      });
      req.on('end', () => {
        received = JSON.parse(body) as unknown;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ accepted: true }));
      });
    });
    try {
      const client = new DshWebClient({ baseUrl: mock.url, timeoutMs: 5000 });
      const result = await client.respond('rpc-1', 'session-1', 'approval-1', 'allowed-once');
      expect(result.accepted).toBe(true);
      const message = received as {
        type: string;
        rpcId: string;
        result: { ok: boolean; value: { sessionId: string; approvalId: string; outcome: string } };
      };
      expect(message.type).toBe('client-response');
      expect(message.rpcId).toBe('rpc-1');
      expect(message.result.ok).toBe(true);
      expect(message.result.value).toEqual({
        sessionId: 'session-1',
        approvalId: 'approval-1',
        outcome: 'allowed-once',
      });
    } finally {
      mock.close();
    }
  });

  it('creates a session with an optional cwd', async () => {
    let received: unknown = null;
    const mock = await startMockServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += String(chunk);
      });
      req.on('end', () => {
        received = JSON.parse(body) as unknown;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            type: 'server-response',
            rpcId: 'r',
            result: { ok: true, value: { sessionId: 'session-new' } },
          }),
        );
      });
    });
    try {
      const client = new DshWebClient({ baseUrl: mock.url, timeoutMs: 5000 });
      const result = await client.createSession('/work/a');
      expect(result.ok).toBe(true);
      const message = received as { method: string; payload: { cwd?: string } };
      expect(message.method).toBe('session.create');
      expect(message.payload.cwd).toBe('/work/a');
      const value = result.value as { sessionId: string };
      expect(value.sessionId).toBe('session-new');
    } finally {
      mock.close();
    }
  });

  it('uses the DSH steer mode on an existing session', async () => {
    let received: unknown = null;
    const mock = await startMockServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += String(chunk);
      });
      req.on('end', () => {
        received = JSON.parse(body) as unknown;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          type: 'server-response',
          rpcId: 'r',
          result: { ok: true, value: { accepted: true } },
        }));
      });
    });
    try {
      const client = new DshWebClient({ baseUrl: mock.url, timeoutMs: 5000 });
      const result = await client.prompt('session-live', '改变当前执行方向', 'steer');
      expect(result.ok).toBe(true);
      expect(received).toMatchObject({
        method: 'session.prompt',
        payload: {
          sessionId: 'session-live',
          mode: 'steer',
          content: [{ type: 'text', text: '改变当前执行方向' }],
        },
      });
    } finally {
      mock.close();
    }
  });
});
