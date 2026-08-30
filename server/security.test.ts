import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import {
  LOCAL_CONTROL_COOKIE,
  LanGate,
  createSecurityGate,
  isRemoteRequest,
  requiresToken,
  writeFamilyOf,
} from './security.js';

interface RequestOptions {
  origin?: string;
  remoteAddress?: string;
  cookie?: string;
  query?: Record<string, unknown>;
  secure?: boolean;
  token?: string;
  headers?: Record<string, string>;
}

function request(
  method: string,
  path: string,
  host = '127.0.0.1:3001',
  options: RequestOptions = {},
): Request {
  const headers: Record<string, string> = { host };
  if (options.origin !== undefined) {
    headers['origin'] = options.origin;
  }
  if (options.cookie !== undefined) {
    headers['cookie'] = options.cookie;
  }
  if (options.token !== undefined) {
    headers['x-pihub-token'] = options.token;
  }
  Object.assign(headers, options.headers);
  const remoteAddress =
    options.remoteAddress ??
    (host.startsWith('127.0.0.1') || host.startsWith('localhost') ? '127.0.0.1' : '192.168.1.20');
  return {
    method,
    path,
    headers,
    query: options.query ?? {},
    secure: options.secure ?? false,
    socket: { remoteAddress, encrypted: options.secure ?? false },
    header(name: string): string | undefined {
      return headers[name.toLowerCase()];
    },
  } as unknown as Request;
}

function response(): Response & {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
} {
  const result = {
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as Response & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };
  result.status.mockReturnValue(result);
  return result;
}

function lastStatus(result: ReturnType<typeof response>): unknown {
  return result.status.mock.calls.at(-1)?.[0];
}

afterEach(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  vi.stubEnv('PIHUB_ALLOWED_HOSTS', '');
});

describe('SecurityGate host/origin/control credential boundary', () => {
  it('normalizes PIHUB_ALLOWED_HOSTS entries that include a port', () => {
    vi.stubEnv('PIHUB_ALLOWED_HOSTS', '192.168.1.20:3001');
    const gate = createSecurityGate();
    const next = vi.fn();
    gate.middleware(
      request('GET', '/', '192.168.1.20:3001', { remoteAddress: '192.168.1.20' }),
      response(),
      next as NextFunction,
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it('requires an exact Origin for remote state-changing requests', () => {
    vi.stubEnv('PIHUB_ALLOWED_HOSTS', '192.168.1.20');
    const gate = createSecurityGate();

    const exactNext = vi.fn();
    gate.middleware(
      request('POST', '/api/net/session', '192.168.1.20:3001', {
        origin: 'http://192.168.1.20:3001',
        remoteAddress: '192.168.1.20',
      }),
      response(),
      exactNext as NextFunction,
    );
    expect(exactNext).toHaveBeenCalledOnce();

    for (const origin of [undefined, 'http://192.168.1.20:4000', 'https://192.168.1.20:3001']) {
      const result = response();
      const next = vi.fn();
      gate.middleware(
        request('POST', '/api/net/session', '192.168.1.20:3001', {
          ...(origin === undefined ? {} : { origin }),
          remoteAddress: '192.168.1.20',
        }),
        result,
        next as NextFunction,
      );
      expect(lastStatus(result), String(origin)).toBe(403);
      expect(next).not.toHaveBeenCalled();
    }
  });

  it('checks exact Origin on GET and SSE requests when Origin is present', () => {
    vi.stubEnv('PIHUB_ALLOWED_HOSTS', '192.168.1.20');
    const gate = createSecurityGate();
    const exact = vi.fn();
    gate.middleware(
      request('GET', '/api/events', '192.168.1.20:3001', {
        origin: 'http://192.168.1.20:3001',
        remoteAddress: '192.168.1.20',
      }),
      response(),
      exact as NextFunction,
    );
    expect(exact).toHaveBeenCalledOnce();

    const mismatched = response();
    gate.middleware(
      request('GET', '/api/events', '192.168.1.20:3001', {
        origin: 'http://192.168.1.20:4000',
        remoteAddress: '192.168.1.20',
      }),
      mismatched,
      vi.fn() as NextFunction,
    );
    expect(lastStatus(mismatched)).toBe(403);
  });

  it('normalizes loopback and allowlisted IPv6 hosts', () => {
    const loopback = createSecurityGate();
    const loopbackNext = vi.fn();
    loopback.middleware(
      request('GET', '/', '[::1]:3001', { remoteAddress: '::1' }),
      response(),
      loopbackNext as NextFunction,
    );
    expect(loopbackNext).toHaveBeenCalledOnce();

    vi.stubEnv('PIHUB_ALLOWED_HOSTS', '[2001:db8::5]:3001,2001:db8::6');
    const allowed = createSecurityGate();
    for (const host of ['[2001:db8::5]:3001', '[2001:db8::6]:3001']) {
      const next = vi.fn();
      allowed.middleware(
        request('GET', '/', host, { remoteAddress: host.slice(1, host.indexOf(']')) }),
        response(),
        next as NextFunction,
      );
      expect(next, host).toHaveBeenCalledOnce();
    }
  });

  it('treats proxy-marked or externally hosted loopback requests as remote', () => {
    expect(isRemoteRequest(request('GET', '/'))).toBe(false);
    expect(
      isRemoteRequest(
        request('GET', '/', '192.168.1.20:3001', { remoteAddress: '127.0.0.1' }),
      ),
    ).toBe(true);
    for (const header of ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-real-ip', 'via']) {
      expect(
        isRemoteRequest(
          request('GET', '/', '127.0.0.1:3001', {
            remoteAddress: '127.0.0.1',
            headers: { [header]: 'marked' },
          }),
        ),
        header,
      ).toBe(true);
    }
  });

  it('keeps loopback CLI writes compatible when Origin is absent', () => {
    const gate = createSecurityGate();
    const next = vi.fn();
    gate.middleware(request('POST', '/api/rpc/prompt'), response(), next as NextFunction);
    expect(next).toHaveBeenCalledOnce();
  });

  it('accepts the control header or HttpOnly cookie, never a query token', () => {
    const gate = createSecurityGate();
    expect(gate.isAuthorized(request('GET', '/api/events', '127.0.0.1:3001', { token: gate.token }))).toBe(true);
    expect(
      gate.isAuthorized(
        request('GET', '/api/events', '127.0.0.1:3001', {
          cookie: `${LOCAL_CONTROL_COOKIE}=${gate.token}`,
        }),
      ),
    ).toBe(true);
    expect(
      gate.isAuthorized(
        request('GET', '/api/events', '127.0.0.1:3001', { query: { token: gate.token } }),
      ),
    ).toBe(false);
    expect(gate.cookie(request('GET', '/'))).toContain('HttpOnly');
    expect(gate.cookie(request('GET', '/'))).toContain('SameSite=Strict');
    expect(gate.cookie(request('GET', '/'))).toContain('Path=/api');
  });
});

describe('writeFamilyOf remote capability classification', () => {
  it('classifies the three capability-scoped families', () => {
    expect(writeFamilyOf('POST', '/api/rpc/prompt')).toBe('prompt');
    expect(writeFamilyOf('POST', '/api/rpc/steer')).toBe('prompt');
    expect(writeFamilyOf('POST', '/api/rpc/abort')).toBe('prompt');
    expect(writeFamilyOf('POST', '/api/codex/prompt')).toBe('prompt');
    expect(writeFamilyOf('POST', '/api/pipelines/run')).toBe('prompt');
    expect(writeFamilyOf('POST', '/api/pipelines/runs/run-1/abort')).toBe('prompt');
    expect(writeFamilyOf('POST', '/api/continuity/target/confirm')).toBe('continue');
    expect(writeFamilyOf('POST', '/api/rpc/bash')).toBe('shell');
    expect(writeFamilyOf('POST', '/api/rpc/abort-bash')).toBe('shell');
    expect(writeFamilyOf('POST', '/api/pipelines/runs/run-1/approve')).toBe('approve');
  });

  it('denies every other non-read API route by default', () => {
    for (const [method, path] of [
      ['POST', '/api/rpc/switch_session'],
      ['POST', '/api/net/caps'],
      ['POST', '/api/net/session/revoke'],
      ['POST', '/api/unknown/future-route'],
      ['DELETE', '/api/rpc/prompt'],
      ['PUT', '/api/pipelines/runs/run-1/approve'],
      ['POST', '/api/pipelines/runs/run-1/extra/approve'],
      ['POST', '/api/demo/future-write'],
    ] as const) {
      expect(writeFamilyOf(method, path), `${method} ${path}`).toBe('never');
    }
  });

  it('passes reads and demo routes without a capability', () => {
    expect(writeFamilyOf('GET', '/api/events')).toBeNull();
    expect(writeFamilyOf('POST', '/api/demo/play')).toBeNull();
    expect(requiresToken(request('POST', '/api/demo/play'))).toBe(false);
    expect(requiresToken(request('POST', '/api/demo/future-write'))).toBe(true);
  });
});

describe('requiresToken sensitive reads', () => {
  it('protects content reads and local network-management state', () => {
    for (const path of [
      '/api/sessions/some-id',
      '/api/models-config',
      '/api/pi-agent/settings',
      '/api/file/preview',
      '/api/rpc/messages',
      '/api/events',
      '/api/net',
      '/api/continuity/manifest',
      '/api/continuity/target',
      '/api/continuity/events',
    ]) {
      expect(requiresToken(request('GET', path)), `GET ${path}`).toBe(true);
    }
  });

  it('keeps ordinary metadata reads public to the local page', () => {
    for (const path of ['/api/sessions', '/api/stats', '/api/health', '/api/adapters']) {
      expect(requiresToken(request('GET', path)), `GET ${path}`).toBe(false);
    }
  });

  it('requires authorization on every non-GET API route', () => {
    expect(requiresToken(request('POST', '/api/net/session'))).toBe(true);
    expect(requiresToken(request('POST', '/api/rpc/prompt'))).toBe(true);
  });
});

describe('continuity capability generation', () => {
  it('advances only when an independent grant actually changes', () => {
    const gate = new LanGate();
    expect(gate.grantGeneration()).toBe(0);
    gate.setCap('remoteContinue', true);
    expect(gate.grantGeneration()).toBe(1);
    gate.setCap('remoteContinue', true);
    expect(gate.grantGeneration()).toBe(1);
    gate.setCap('remotePrompt', true);
    expect(gate.grantGeneration()).toBe(2);
    gate.setCap('remoteContinue', false);
    expect(gate.grantGeneration()).toBe(3);
  });
});
