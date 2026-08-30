import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { LanGate, REMOTE_SESSION_EXCHANGE_PATH } from './security.js';
import { SseHub } from './sse.js';

class MockResponse extends EventEmitter {
  readonly headers = new Map<string, string>();
  readonly chunks: string[] = [];
  statusCode = 200;
  endCount = 0;

  setHeader(name: string, value: string): this {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  flushHeaders(): void {}

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  end(): this {
    this.endCount += 1;
    return this;
  }
}

function request(
  remote: boolean,
  cookie?: string,
  headers: Record<string, string> = {},
): Request {
  const host = remote ? '192.168.1.20:3001' : '127.0.0.1:3001';
  const values: Record<string, string> = { host, ...headers };
  if (cookie !== undefined) {
    values['cookie'] = cookie;
  }
  return {
    method: 'GET',
    path: '/api/events',
    headers: values,
    socket: { remoteAddress: remote ? '192.168.1.20' : '127.0.0.1' },
    header(name: string): string | undefined {
      return values[name.toLowerCase()];
    },
  } as unknown as Request;
}

function cookieHeader(setCookie: string): string {
  return setCookie.split(';', 1)[0] ?? '';
}

function authorize(gate: LanGate): {
  req: Request;
  sessionId: string;
} {
  const bootstrap = gate.createBootstrap();
  const exchange = gate.exchangeBootstrap(
    {
      ...request(true),
      method: 'POST',
      path: REMOTE_SESSION_EXCHANGE_PATH,
    } as Request,
    bootstrap.code,
  );
  if (!exchange.ok) {
    throw new Error(exchange.error);
  }
  const req = request(true, cookieHeader(exchange.setCookie));
  const next = vi.fn();
  gate.middleware(req, new MockResponse() as unknown as Response, next as NextFunction);
  expect(next).toHaveBeenCalledOnce();
  return { req, sessionId: exchange.session.id };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  vi.stubEnv('PIHUB_NET', 'pair');
  vi.stubEnv('PIHUB_PAIR_TTL_MS', '');
  vi.stubEnv('PIHUB_SESSION_TTL_MS', '');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('SseHub remote-session lifecycle', () => {
  it('rejects remote clients without authorization and keeps no-store', () => {
    const hub = new SseHub();
    const denied = new MockResponse();
    hub.addClient(request(true), denied as unknown as Response);
    expect(denied.statusCode).toBe(403);
    expect(denied.endCount).toBe(1);

    const local = new MockResponse();
    hub.addClient(request(false), local as unknown as Response);
    expect(local.headers.get('cache-control')).toBe('no-store');
    hub.close();
  });

  it('closes an established stream immediately on revoke or logout', () => {
    const gate = new LanGate();
    const hub = new SseHub();
    gate.onSessionRevoked((sessionId) => {
      hub.closeRemoteSession(sessionId);
    });

    const revoked = authorize(gate);
    const revokedResponse = new MockResponse();
    hub.addClient(
      revoked.req,
      revokedResponse as unknown as Response,
      gate.sessionAuthorization(revoked.req),
    );
    expect(gate.revokeSession(revoked.sessionId)).toBe(true);
    expect(revokedResponse.endCount).toBe(1);

    const loggedOut = authorize(gate);
    const logoutResponse = new MockResponse();
    hub.addClient(
      loggedOut.req,
      logoutResponse as unknown as Response,
      gate.sessionAuthorization(loggedOut.req),
    );
    gate.endSession(loggedOut.req);
    expect(logoutResponse.endCount).toBe(1);
    hub.close();
  });

  it('expires streams and revalidates before broadcast or heartbeat', async () => {
    const gate = new LanGate({ sessionTtlMs: 1_000 });
    const hub = new SseHub();
    const issued = authorize(gate);
    const expiring = new MockResponse();
    hub.addClient(
      issued.req,
      expiring as unknown as Response,
      gate.sessionAuthorization(issued.req),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(expiring.endCount).toBe(1);

    let valid = true;
    const stale = new MockResponse();
    hub.addClient(request(true), stale as unknown as Response, {
      sessionId: 'stale',
      expiresAt: Date.now() + 60_000,
      isValid: () => valid,
    });
    valid = false;
    hub.broadcast({ type: 'agent_start' });
    expect(stale.endCount).toBe(1);

    const heartbeat = new MockResponse();
    hub.addClient(request(true), heartbeat as unknown as Response, {
      sessionId: 'heartbeat',
      expiresAt: Date.now() + 60_000,
      isValid: () => false,
    });
    hub.broadcastComment();
    expect(heartbeat.endCount).toBe(1);
    hub.close();
  });

  it('uses shared remote truth for the event marker', () => {
    const hub = new SseHub();
    const proxied = new MockResponse();
    hub.addClient(
      request(false, undefined, { 'x-forwarded-for': '192.168.1.20' }),
      proxied as unknown as Response,
      {
        sessionId: 'proxy',
        expiresAt: Date.now() + 60_000,
        isValid: () => true,
      },
    );
    hub.broadcast({ type: 'agent_start' });
    expect(proxied.chunks.join('')).toContain('"remote":true');

    const local = new MockResponse();
    hub.addClient(request(false), local as unknown as Response);
    hub.broadcast({ type: 'agent_start' });
    expect(local.chunks.join('')).not.toContain('"remote":true');
    hub.close();
  });

  it('assigns ordered ids and replays a bounded cursor window', () => {
    const hub = new SseHub({ replayLimit: 2, hostId: 'host-a', streamEpoch: 'epoch-a' });
    hub.broadcast({ type: 'one' });
    hub.broadcast({ type: 'two' });
    hub.broadcast({ type: 'three' });

    expect(hub.currentCursor()).toBe('epoch-a:3');
    expect(hub.replayAfter('epoch-a:1')).toMatchObject({
      resyncRequired: false,
      events: [{ sequence: 2 }, { sequence: 3 }],
    });
    expect(hub.replayAfter('epoch-a:0')).toMatchObject({
      resyncRequired: true,
      reason: 'cursor-too-old',
      events: [],
    });
    expect(hub.replayAfter('old:2')).toMatchObject({
      resyncRequired: true,
      reason: 'epoch-changed',
    });
    expect(hub.replayAfter('broken')).toMatchObject({
      resyncRequired: true,
      reason: 'invalid-cursor',
    });
  });

  it('replays Last-Event-ID and emits an explicit resync event on a gap', () => {
    const hub = new SseHub({ replayLimit: 2, hostId: 'host-a', streamEpoch: 'epoch-a' });
    hub.broadcast({ type: 'one' });
    hub.broadcast({ type: 'two' });
    hub.broadcast({ type: 'three' });

    const replayed = new MockResponse();
    hub.addClient(
      request(false, undefined, { 'last-event-id': 'epoch-a:1' }),
      replayed as unknown as Response,
    );
    expect(replayed.chunks.join('')).toContain('id: epoch-a:2');
    expect(replayed.chunks.join('')).toContain('id: epoch-a:3');

    const gap = new MockResponse();
    hub.addClient(
      request(false, undefined, { 'last-event-id': 'epoch-a:0' }),
      gap as unknown as Response,
    );
    expect(gap.chunks.join('')).toContain('event: resync');
    expect(gap.chunks.join('')).toContain('cursor-too-old');
    hub.close();
  });
});
