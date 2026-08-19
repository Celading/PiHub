import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import {
  LanGate,
  REMOTE_SESSION_COOKIE,
  REMOTE_SESSION_EXCHANGE_PATH,
  createJsonBodyMiddleware,
} from '../security.js';

interface RequestOptions {
  cookie?: string;
  query?: Record<string, unknown>;
  remoteAddress?: string;
  secure?: boolean;
  host?: string;
}

function remoteRequest(
  method: string,
  path: string,
  options: RequestOptions = {},
): Request {
  const headers: Record<string, string> = { host: options.host ?? '192.168.1.20:3001' };
  if (options.cookie !== undefined) {
    headers['cookie'] = options.cookie;
  }
  return {
    method,
    path,
    headers,
    query: options.query ?? {},
    secure: options.secure ?? false,
    socket: {
      remoteAddress: options.remoteAddress ?? '192.168.1.20',
      encrypted: options.secure ?? false,
    },
    header(name: string): string | undefined {
      return headers[name.toLowerCase()];
    },
  } as unknown as Request;
}

function localRequest(method = 'GET', path = '/api/net'): Request {
  return remoteRequest(method, path, { host: '127.0.0.1:3001', remoteAddress: '127.0.0.1' });
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

function cookieHeader(setCookie: string): string {
  return setCookie.split(';', 1)[0] ?? '';
}

function cookieToken(setCookie: string): string {
  return cookieHeader(setCookie).slice(`${REMOTE_SESSION_COOKIE}=`.length);
}

function issueSession(gate: LanGate): {
  bootstrap: ReturnType<LanGate['createBootstrap']>;
  cookie: string;
  sessionId: string;
  setCookie: string;
} {
  const bootstrap = gate.createBootstrap();
  const exchange = gate.exchangeBootstrap(
    remoteRequest('POST', REMOTE_SESSION_EXCHANGE_PATH),
    bootstrap.code,
  );
  if (!exchange.ok) {
    throw new Error(exchange.error);
  }
  return {
    bootstrap,
    cookie: cookieHeader(exchange.setCookie),
    sessionId: exchange.session.id,
    setCookie: exchange.setCookie,
  };
}

beforeEach(() => {
  vi.stubEnv('PIHUB_NET', 'pair');
  vi.stubEnv('PIHUB_PAIR_TTL_MS', '');
  vi.stubEnv('PIHUB_SESSION_TTL_MS', '');
  vi.stubEnv('PIHUB_CAP_REMOTE_APPROVE', '0');
  vi.stubEnv('PIHUB_CAP_REMOTE_PROMPT', '0');
  vi.stubEnv('PIHUB_CAP_REMOTE_SHELL', '0');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('RemoteLink R0 bootstrap/session lifecycle', () => {
  it('creates a 64-hex bootstrap, clamps TTL to 60s and lists no secret', () => {
    const now = 1_000_000;
    const gate = new LanGate({ now: () => now, bootstrapTtlMs: 10 * 60_000 });
    const bootstrap = gate.createBootstrap();
    expect(bootstrap.code).toMatch(/^[0-9a-f]{64}$/u);
    expect(bootstrap.expiresAt - now).toBe(60_000);
    expect(gate.listBootstraps()).toEqual([{ id: bootstrap.id, expiresAt: bootstrap.expiresAt }]);
    expect(JSON.stringify(gate.listBootstraps())).not.toContain(bootstrap.code);
  });

  it('expires a bootstrap at the exact boundary', () => {
    let now = 10_000;
    const gate = new LanGate({ now: () => now, bootstrapTtlMs: 2_000 });
    const bootstrap = gate.createBootstrap();
    now = bootstrap.expiresAt;
    expect(gate.exchangeBootstrap(remoteRequest('POST', REMOTE_SESSION_EXCHANGE_PATH), bootstrap.code)).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it('does not burn a valid bootstrap when a different proposal fails', () => {
    const gate = new LanGate();
    const bootstrap = gate.createBootstrap();
    expect(
      gate.exchangeBootstrap(remoteRequest('POST', REMOTE_SESSION_EXCHANGE_PATH), 'de'.repeat(32)),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      gate.exchangeBootstrap(remoteRequest('POST', REMOTE_SESSION_EXCHANGE_PATH), bootstrap.code),
    ).toMatchObject({ ok: true });
  });

  it('allows at most one success for concurrent/repeated exchange', async () => {
    const gate = new LanGate();
    const bootstrap = gate.createBootstrap();
    const attempts = await Promise.all(
      [0, 1].map(() =>
        Promise.resolve().then(() =>
          gate.exchangeBootstrap(remoteRequest('POST', REMOTE_SESSION_EXCHANGE_PATH), bootstrap.code),
        ),
      ),
    );
    expect(attempts.filter((result) => result.ok)).toHaveLength(1);
    expect(attempts.filter((result) => !result.ok && result.status === 403)).toHaveLength(1);
    expect(
      gate.exchangeBootstrap(remoteRequest('POST', REMOTE_SESSION_EXCHANGE_PATH), bootstrap.code),
    ).toMatchObject({ ok: false, status: 403 });
  });

  it('issues an independent 256-bit HttpOnly cookie and no JSON token field', () => {
    const gate = new LanGate();
    const bootstrap = gate.createBootstrap();
    const exchange = gate.exchangeBootstrap(
      remoteRequest('POST', REMOTE_SESSION_EXCHANGE_PATH),
      bootstrap.code,
    );
    expect(exchange.ok).toBe(true);
    if (!exchange.ok) {
      return;
    }
    const token = cookieToken(exchange.setCookie);
    expect(token).toMatch(/^[0-9a-f]{64}$/u);
    expect(token).not.toBe(bootstrap.code);
    expect(token).not.toBe(exchange.session.id);
    expect(exchange.session).not.toHaveProperty('token');
    expect(exchange.setCookie).toContain('HttpOnly');
    expect(exchange.setCookie).toContain('SameSite=Strict');
    expect(exchange.setCookie).toContain('Path=/api');
    expect(exchange.setCookie).toContain('Max-Age=900');
    expect(exchange.setCookie).not.toContain('Secure');
  });

  it('adds Secure only for a direct HTTPS request', () => {
    const gate = new LanGate();
    const bootstrap = gate.createBootstrap();
    const exchange = gate.exchangeBootstrap(
      remoteRequest('POST', REMOTE_SESSION_EXCHANGE_PATH, { secure: true }),
      bootstrap.code,
    );
    expect(exchange.ok && exchange.setCookie).toContain('Secure');
  });

  it('throttles repeated invalid bootstrap exchanges per peer', () => {
    const gate = new LanGate();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(
        gate.exchangeBootstrap(remoteRequest('POST', REMOTE_SESSION_EXCHANGE_PATH), 'de'.repeat(32)),
      ).toMatchObject({ ok: false, status: 403 });
    }
    expect(
      gate.exchangeBootstrap(remoteRequest('POST', REMOTE_SESSION_EXCHANGE_PATH), 'de'.repeat(32)),
    ).toMatchObject({ ok: false, status: 429 });
  });

  it('counts malformed bootstrap values toward the same throttle', () => {
    const gate = new LanGate();
    for (const candidate of [undefined, null, 123, 'short', {}]) {
      expect(
        gate.exchangeBootstrap(remoteRequest('POST', REMOTE_SESSION_EXCHANGE_PATH), candidate),
      ).toMatchObject({ ok: false, status: 400 });
    }
    expect(
      gate.exchangeBootstrap(remoteRequest('POST', REMOTE_SESSION_EXCHANGE_PATH), 'ab'.repeat(32)),
    ).toMatchObject({ ok: false, status: 429 });
  });
});

describe('RemoteLink R0 cookie gate, expiry and revocation', () => {
  it('rejects query credentials and accepts the issued cookie', () => {
    const gate = new LanGate();
    const issued = issueSession(gate);
    for (const query of [
      { pair: issued.bootstrap.code },
      { bootstrap: issued.bootstrap.code },
      { session: cookieToken(issued.setCookie) },
      { token: cookieToken(issued.setCookie) },
    ]) {
      const result = response();
      gate.middleware(
        remoteRequest('GET', '/api/rpc/messages', { query }),
        result,
        vi.fn() as NextFunction,
      );
      expect(lastStatus(result)).toBe(403);
    }

    const next = vi.fn();
    gate.middleware(
      remoteRequest('GET', '/api/rpc/messages', { cookie: issued.cookie }),
      response(),
      next as NextFunction,
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it('enforces capability switches and keeps unknown writes fail-closed', () => {
    const gate = new LanGate();
    const issued = issueSession(gate);
    const denied = response();
    gate.middleware(
      remoteRequest('POST', '/api/rpc/prompt', { cookie: issued.cookie }),
      denied,
      vi.fn() as NextFunction,
    );
    expect(lastStatus(denied)).toBe(403);

    gate.caps.remotePrompt = true;
    const allowed = vi.fn();
    gate.middleware(
      remoteRequest('POST', '/api/rpc/prompt', { cookie: issued.cookie }),
      response(),
      allowed as NextFunction,
    );
    expect(allowed).toHaveBeenCalledOnce();

    gate.caps.remoteShell = true;
    gate.caps.remoteApprove = true;
    for (const [method, path] of [
      ['POST', '/api/unknown/future-route'],
      ['DELETE', '/api/rpc/prompt'],
      ['PUT', '/api/pipelines/runs/run-1/approve'],
      ['POST', '/api/pipelines/runs/run-1/extra/approve'],
    ] as const) {
      const unknown = response();
      gate.middleware(
        remoteRequest(method, path, { cookie: issued.cookie }),
        unknown,
        vi.fn() as NextFunction,
      );
      expect(lastStatus(unknown), `${method} ${path}`).toBe(403);
    }
  });

  it('expires sessions at the exact boundary', () => {
    let now = 2_000_000;
    const gate = new LanGate({ now: () => now, sessionTtlMs: 2_000 });
    const issued = issueSession(gate);
    now += 2_000;
    const result = response();
    gate.middleware(
      remoteRequest('GET', '/api/rpc/messages', { cookie: issued.cookie }),
      result,
      vi.fn() as NextFunction,
    );
    expect(lastStatus(result)).toBe(403);
  });

  it('revokes by public session id and logout clears server and cookie state', () => {
    const gate = new LanGate();
    const revoked = issueSession(gate);
    expect(gate.revokeSession(revoked.sessionId)).toBe(true);
    const afterRevoke = response();
    gate.middleware(
      remoteRequest('GET', '/api/rpc/messages', { cookie: revoked.cookie }),
      afterRevoke,
      vi.fn() as NextFunction,
    );
    expect(lastStatus(afterRevoke)).toBe(403);

    const logout = issueSession(gate);
    const logoutRequest = remoteRequest('POST', '/api/net/session/logout', { cookie: logout.cookie });
    const next = vi.fn();
    gate.middleware(logoutRequest, response(), next as NextFunction);
    expect(next).toHaveBeenCalledOnce();
    const clearingCookie = gate.endSession(logoutRequest);
    expect(clearingCookie).toContain('Max-Age=0');

    const afterLogout = response();
    gate.middleware(
      remoteRequest('GET', '/api/rpc/messages', { cookie: logout.cookie }),
      afterLogout,
      vi.fn() as NextFunction,
    );
    expect(lastStatus(afterLogout)).toBe(403);
  });

  it('filters remote network state while local state exposes only management ids', () => {
    const gate = new LanGate();
    const bootstrap = gate.createBootstrap();
    const issued = issueSession(gate);
    const remote = gate.netState(remoteRequest('GET', '/api/net', { cookie: issued.cookie }));
    expect(remote).toEqual({ mode: 'pair', caps: gate.caps, remote: true });
    expect(remote).not.toHaveProperty('bootstraps');
    expect(remote).not.toHaveProperty('sessions');

    const local = gate.netState(localRequest());
    expect(local.remote).toBe(false);
    if (local.remote) {
      return;
    }
    expect(local.bootstraps).toContainEqual({ id: bootstrap.id, expiresAt: bootstrap.expiresAt });
    expect(JSON.stringify(local.bootstraps)).not.toContain(bootstrap.code);
    expect(local.sessions[0]).toHaveProperty('id');
    expect(local.sessions[0]).not.toHaveProperty('token');
  });
});

async function startJsonApp(gate: LanGate): Promise<{ baseUrl: string; server: Server }> {
  const app = express();
  app.use(createJsonBodyMiddleware(gate));
  app.post('/api/net/session', (req, res) => {
    const body = req.body as Record<string, unknown> | null;
    const result = gate.exchangeBootstrap(
      req,
      typeof body === 'object' && body !== null ? body['bootstrap'] : undefined,
    );
    res.status(result.ok ? 200 : result.status).json(
      result.ok ? { success: true, session: result.session } : { error: result.error },
    );
  });
  app.post('/api/other', (_req, res) => {
    res.json({ success: true });
  });
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${String(address.port)}`, server };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

describe('RemoteLink R0 request-body gate', () => {
  it('uses a narrow exchange parser, generic errors and malformed-body throttling', async () => {
    const gate = new LanGate();
    const bootstrap = gate.createBootstrap();
    const { baseUrl, server } = await startJsonApp(gate);
    try {
      const malformed = `{"bootstrap":"${bootstrap.code}"`;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const result = await fetch(`${baseUrl}/api/net/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: malformed,
        });
        expect(result.status).toBe(400);
        const text = await result.text();
        expect(text).toContain('invalid request body');
        expect(text).not.toContain(bootstrap.code);
      }
      const locked = await fetch(`${baseUrl}/api/net/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bootstrap: bootstrap.code }),
      });
      expect(locked.status).toBe(429);
    } finally {
      await closeServer(server);
    }
  });

  it('caps exchange JSON near 1KB while preserving the ordinary 1MB parser', async () => {
    const gate = new LanGate();
    const bootstrap = gate.createBootstrap();
    const { baseUrl, server } = await startJsonApp(gate);
    try {
      const oversized = await fetch(`${baseUrl}/api/net/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bootstrap: bootstrap.code, padding: 'x'.repeat(2_000) }),
      });
      expect(oversized.status).toBe(413);
      expect(await oversized.json()).toEqual({ error: 'request body too large' });

      const ordinary = await fetch(`${baseUrl}/api/other`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ padding: 'x'.repeat(2_000) }),
      });
      expect(ordinary.status).toBe(200);

      const wrongType = await fetch(`${baseUrl}/api/net/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ bootstrap: bootstrap.code }),
      });
      expect(wrongType.status).toBe(415);
      expect(await wrongType.json()).toEqual({ error: 'application/json required' });

      const missingType = await fetch(`${baseUrl}/api/net/session`, {
        method: 'POST',
        body: JSON.stringify({ bootstrap: bootstrap.code }),
      });
      expect(missingType.status).toBe(415);
    } finally {
      await closeServer(server);
    }
  });

  it('keeps parser installation after the security and token gates', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const securityIndex = source.indexOf('app.use(security.middleware.bind(security))');
    const lanIndex = source.indexOf('app.use(lanGate.middleware.bind(lanGate))');
    const tokenIndex = source.indexOf('const remoteSession = lanGate.isRemote(req)');
    const parserIndex = source.indexOf('app.use(createJsonBodyMiddleware(lanGate))');
    expect(securityIndex).toBeGreaterThanOrEqual(0);
    expect(lanIndex).toBeGreaterThan(securityIndex);
    expect(tokenIndex).toBeGreaterThan(lanIndex);
    expect(parserIndex).toBeGreaterThan(tokenIndex);
    expect(source).toContain("console.error('[http] internal request failure')");
  });
});
