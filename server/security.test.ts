import { describe, expect, it, vi } from 'vitest';
import { LanGate, requiresToken, writeFamilyOf } from './security.js';
import type { NextFunction, Request, Response } from 'express';

function req(method: string, path: string, host: string, query: Record<string, unknown> = {}) {
  // v1c-completion: remoteness is judged by socket.remoteAddress; the helper
  // mirrors the old host-based semantics so existing tests keep their intent,
  // and the P1-3 test below overrides the socket explicitly.
  const loopbackHost =
    host.startsWith('127.0.0.1') || host.startsWith('localhost') || host.startsWith('[::1]');
  return {
    method,
    path,
    headers: { host },
    query,
    socket: { remoteAddress: loopbackHost ? '127.0.0.1' : '192.168.1.20' },
  } as unknown as Request;
}

function res() {
  const status = vi.fn();
  const json = vi.fn();
  status.mockReturnValue({ json });
  return { status, json };
}

/** Casts a mock response into the express Response shape for middleware. */
function mockResponse(r: ReturnType<typeof res>): Response {
  return r as unknown as Response;
}

describe('writeFamilyOf (audit P0 — remote capability classification)', () => {
  it('classifies the capability-scoped families', () => {
    expect(writeFamilyOf('POST', '/api/rpc/prompt')).toBe('prompt');
    expect(writeFamilyOf('POST', '/api/rpc/steer')).toBe('prompt');
    expect(writeFamilyOf('POST', '/api/codex/prompt')).toBe('prompt');
    expect(writeFamilyOf('POST', '/api/rpc/bash')).toBe('shell');
    expect(writeFamilyOf('POST', '/api/rpc/abort-bash')).toBe('shell');
    expect(writeFamilyOf('POST', '/api/pipelines/runs/run-1/approve')).toBe('approve');
  });

  it('denies every other non-read /api route (fail-closed)', () => {
    for (const [method, path] of [
      ['POST', '/api/rpc/abort'],
      ['POST', '/api/rpc/switch_session'],
      ['POST', '/api/rpc/new_session'],
      ['POST', '/api/rpc/fork'],
      ['POST', '/api/rpc/model'],
      ['POST', '/api/rpc/thinking'],
      ['POST', '/api/rpc/compact'],
      ['POST', '/api/rpc/cycle-model'],
      ['POST', '/api/codex/abort'],
      ['POST', '/api/codex/session'],
      ['POST', '/api/pipelines'],
      ['DELETE', '/api/pipelines/p1'],
      ['POST', '/api/pipelines/run'],
      ['POST', '/api/pipelines/runs/run-1/abort'],
      ['POST', '/api/sessions/delete'],
      ['POST', '/api/models-config'],
      ['PUT', '/api/system-prompt'],
      ['POST', '/api/net/caps'],
      ['POST', '/api/unknown/future-route'], // fail-closed
    ] as const) {
      expect(writeFamilyOf(method, path), `${method} ${path}`).toBe('never');
    }
  });

  it('passes reads and demo routes without a capability', () => {
    expect(writeFamilyOf('GET', '/api/rpc/prompt')).toBeNull();
    expect(writeFamilyOf('GET', '/api/rpc/messages')).toBeNull();
    expect(writeFamilyOf('GET', '/api/events')).toBeNull();
    expect(writeFamilyOf('POST', '/api/demo/play')).toBeNull();
  });
});

describe('LanGate middleware capability scope (audit P0)', () => {
  it('leaves loopback traffic untouched', () => {
    const gate = new LanGate();
    const next = vi.fn();
    gate.middleware(req('POST', '/api/rpc/prompt', '127.0.0.1:3001'), mockResponse(res()), next as NextFunction);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('requires pairing for remote peers', () => {
    const gate = new LanGate();
    const r = res();
    const next = vi.fn();
    gate.middleware(
      req('GET', '/api/rpc/messages', '192.168.1.20:3001'),
      mockResponse(r),
      next as NextFunction,
    );
    expect(r.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('denies prompt-family writes unless remotePrompt is on', () => {
    const gate = new LanGate();
    gate.caps.remotePrompt = false;
    const code = gate.createPairCode();
    const r = res();
    const next = vi.fn();
    gate.middleware(
      req('POST', '/api/rpc/prompt', '192.168.1.20:3001', { pair: code }),
      mockResponse(r),
      next as NextFunction,
    );
    expect(r.status).toHaveBeenCalledWith(403);
    expect(r.json).toHaveBeenCalledWith({ error: 'remote capability not enabled' });
    expect(next).not.toHaveBeenCalled();

    gate.caps.remotePrompt = true;
    const r2 = res();
    const next2 = vi.fn();
    gate.middleware(
      req('POST', '/api/rpc/prompt', '192.168.1.20:3001', { pair: code }),
      mockResponse(r2),
      next2 as NextFunction,
    );
    expect(next2).toHaveBeenCalledTimes(1);
  });

  it('denies shell/approve families by their own switches', () => {
    const gate = new LanGate();
    gate.caps.remoteShell = true;
    gate.caps.remoteApprove = true;
    const code = gate.createPairCode();
    const ok = vi.fn();
    gate.middleware(
      req('POST', '/api/rpc/bash', '192.168.1.20:3001', { pair: code }),
      mockResponse(res()),
      ok as NextFunction,
    );
    expect(ok).toHaveBeenCalledTimes(1);
    const ok2 = vi.fn();
    gate.middleware(
      req('POST', '/api/pipelines/runs/run-1/approve', '192.168.1.20:3001', { pair: code }),
      mockResponse(res()),
      ok2 as NextFunction,
    );
    expect(ok2).toHaveBeenCalledTimes(1);

    gate.caps.remoteShell = false;
    const denied = vi.fn();
    const r = res();
    gate.middleware(
      req('POST', '/api/rpc/bash', '192.168.1.20:3001', { pair: code }),
      mockResponse(r),
      denied as NextFunction,
    );
    expect(r.status).toHaveBeenCalledWith(403);
    expect(denied).not.toHaveBeenCalled();
  });

  it('always denies "never" routes even with every capability on', () => {
    const gate = new LanGate();
    gate.caps.remotePrompt = true;
    gate.caps.remoteShell = true;
    gate.caps.remoteApprove = true;
    const code = gate.createPairCode();
    for (const [method, path] of [
      ['POST', '/api/rpc/switch_session'],
      ['POST', '/api/rpc/new_session'],
      ['POST', '/api/codex/abort'],
      ['POST', '/api/pipelines/run'],
      ['POST', '/api/sessions/delete'],
      ['PUT', '/api/system-prompt'],
    ] as const) {
      const r = res();
      const next = vi.fn();
      gate.middleware(req(method, path, '192.168.1.20:3001', { pair: code }), mockResponse(r), next as NextFunction);
      expect(r.status, `${method} ${path}`).toHaveBeenCalledWith(403);
      expect(next, `${method} ${path}`).not.toHaveBeenCalled();
    }
  });

  it('allows remote reads without any capability', () => {
    const gate = new LanGate();
    const code = gate.createPairCode();
    const next = vi.fn();
    gate.middleware(
      req('GET', '/api/rpc/messages', '192.168.1.20:3001', { pair: code }),
      mockResponse(res()),
      next as NextFunction,
    );
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('requiresToken (audit P1-2 — sensitive reads)', () => {
  it('requires the token on full-content sensitive reads', () => {
    for (const path of [
      '/api/sessions/some-id',
      '/api/claude/sessions/abc',
      '/api/codex/sessions/xyz',
      '/api/zcode/sessions/z',
      '/api/atomcode/sessions',
      '/api/codex/messages',
      '/api/prompts',
      '/api/git/diff',
      '/api/files',
      '/api/models-config',
      '/api/file/preview',
      '/api/rpc/messages',
      '/api/events',
    ]) {
      expect(requiresToken(req('GET', path, '127.0.0.1')), `GET ${path}`).toBe(true);
    }
  });

  it('does not require the token on non-sensitive reads', () => {
    for (const path of ['/api/sessions', '/api/stats', '/api/health', '/api/adapters', '/api/mode']) {
      expect(requiresToken(req('GET', path, '127.0.0.1')), `GET ${path}`).toBe(false);
    }
  });

  it('requires the token on every non-GET api route', () => {
    for (const path of ['/api/rpc/prompt', '/api/rpc/abort', '/api/pipelines/run', '/api/sessions/delete']) {
      expect(requiresToken(req('POST', path, '127.0.0.1')), `POST ${path}`).toBe(true);
    }
  });
});

describe('LanGate.isRemote (audit P1-3 — socket-based peer judgment)', () => {
  it('judges remoteness by socket.remoteAddress, not the forgeable Host header', () => {
    const gate = new LanGate();
    // Forged `Host: 127.0.0.1` with a real LAN socket → still remote.
    const forged = Object.assign(req('GET', '/api/sessions', '127.0.0.1'), {
      socket: { remoteAddress: '192.168.1.5' },
    }) as Request;
    expect(gate.isRemote(forged)).toBe(true);
    // Loopback socket → local, regardless of the Host header.
    const local = Object.assign(req('GET', '/api/sessions', 'whatever.local'), {
      socket: { remoteAddress: '127.0.0.1' },
    }) as Request;
    expect(gate.isRemote(local)).toBe(false);
  });

  it('treats IPv4-mapped IPv6 loopback as local', () => {
    const gate = new LanGate();
    const v4mapped = Object.assign(req('GET', '/', '127.0.0.1'), {
      socket: { remoteAddress: '::ffff:127.0.0.1' },
    }) as Request;
    expect(gate.isRemote(v4mapped)).toBe(false);
  });
});
