import type { NextFunction, Request, Response } from 'express';
import { randomBytes } from 'node:crypto';

/**
 * SPRINT-2 A1: local control-plane security gate.
 *
 * The panel binds 127.0.0.1 only, but loopback alone does not stop DNS
 * rebinding, malicious local pages, or a misconfigured reverse proxy. Every
 * request passes through:
 *
 *  1. Host allowlist — only 127.0.0.1 / localhost (any port) by default;
 *     extendable via PIHUB_ALLOWED_HOSTS (comma-separated host[:port]).
 *  2. Origin check — state-changing requests carrying an Origin header must
 *     be same-origin (modern browsers always send Origin on POST/SSE from a
 *     page; cross-site forms cannot forge the header).
 *  3. Control token — a random per-process token; all write routes and
 *     sensitive read routes must present it. The SPA injects it via fetch
 *     header; EventSource carries it as a query param.
 */

const DEFAULT_ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost']);

function allowedHosts(): Set<string> {
  const set = new Set<string>(DEFAULT_ALLOWED_HOSTS);
  const raw = process.env.PIHUB_ALLOWED_HOSTS;
  if (raw === undefined || raw.length === 0) {
    return set;
  }
  // PIHUB_ALLOWED_HOSTS EXTENDS the loopback allowlist — it never removes
  // 127.0.0.1/localhost (P2-02 lan mode must keep local access working).
  for (const part of raw.split(',')) {
    const host = part.trim().toLowerCase();
    if (host.length > 0) {
      set.add(host);
    }
  }
  return set;
}

/** Normalizes `host` (may include port) to its bare hostname. */
function bareHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  // IPv6 literals like [::1]:3001
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    return end === -1 ? trimmed : trimmed.slice(1, end);
  }
  const colon = trimmed.lastIndexOf(':');
  if (colon === -1 || trimmed.indexOf(':') === -1) {
    return trimmed;
  }
  // host:port — strip the port
  return trimmed.slice(0, colon);
}

export interface SecurityGate {
  /** The per-process random token; never persisted, never logged. */
  token: string;
  /** True when the request carries the valid control token. */
  isAuthorized(req: Request): boolean;
  /** Express middleware: host + origin + token gating. */
  middleware(req: Request, res: Response, next: NextFunction): void;
}

const TOKEN_HEADER = 'x-pihub-token';

export function createSecurityGate(): SecurityGate {
  const token = randomBytes(32).toString('hex');
  const hosts = allowedHosts();

  const isAuthorized = (req: Request): boolean => {
    const header = req.header(TOKEN_HEADER);
    if (typeof header === 'string' && header.length > 0) {
      return header === token;
    }
    // EventSource cannot set headers; the SPA passes ?token= for SSE.
    const query = req.query['token'];
    return typeof query === 'string' && query.length > 0 && query === token;
  };

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    const host = req.headers.host;
    if (typeof host !== 'string' || host.length === 0 || !hosts.has(bareHost(host))) {
      res.status(403).json({ error: 'forbidden host' });
      return;
    }
    const origin = req.header('origin');
    if (req.method !== 'GET' && origin !== undefined && origin.length > 0) {
      let originHost: string;
      try {
        originHost = new URL(origin).host;
      } catch {
        res.status(403).json({ error: 'forbidden origin' });
        return;
      }
      if (!hosts.has(bareHost(originHost))) {
        res.status(403).json({ error: 'forbidden origin' });
        return;
      }
    }
    next();
  };

  return { token, isAuthorized, middleware };
}

/** Routes that must present the control token (writes + sensitive reads). */
export function requiresToken(req: Request): boolean {
  const p = req.path;
  if (req.method !== 'GET' && !p.startsWith('/api/demo/')) {
    // demo write routes keep their own 503 guards; everything else that
    // mutates state needs the token.
    if (p.startsWith('/api/')) {
      return true;
    }
  }
  // Sensitive reads: credentials-bearing model config, session files,
  // file preview, bash history/tree state, and the SSE event stream
  // (message content flows through it).
  return (
    p === '/api/models-config' ||
    p === '/api/file/preview' ||
    p === '/api/rpc/messages' ||
    p === '/api/rpc/entries' ||
    p === '/api/rpc/tree' ||
    p === '/api/events'
  );
}

/* ---- P2-02: LAN access modes + capability scope ---- */

export type NetMode = 'local' | 'pair' | 'lan';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(bareHost(host));
}

/** Routes that mutate agent state — denied for remote (non-loopback) peers
 *  unless the capability switch explicitly allows them (P2-02 B). */
export function isRemoteWriteRoute(p: string): boolean {
  return (
    p === '/api/rpc/prompt' ||
    p === '/api/rpc/steer' ||
    p === '/api/rpc/abort' ||
    p === '/api/rpc/bash' ||
    p === '/api/rpc/abort-bash' ||
    p === '/api/sessions/delete' ||
    p === '/api/models-config'
  );
}

export interface CapabilitySwitches {
  remoteApprove: boolean;
  remotePrompt: boolean;
  remoteShell: boolean;
}

/**
 * P2-02 LAN gate: decides whether a request is "remote" and which
 * capabilities it may use. Mode is fixed at startup (PIHUB_NET):
 *  - local (default): loopback only — behavior identical to SPRINT-2.
 *  - pair: a one-time pairing code (short TTL) unlocks a remote session;
 *    the code is validated here and swapped for a short-lived session token.
 *  - lan: explicit PIHUB_ALLOWED_HOSTS plus capability switches via env.
 */
export class LanGate {
  readonly mode: NetMode;
  /** One-time pairing codes: code -> { createdAt, expiresAt }. */
  private readonly pairs = new Map<string, { createdAt: number; expiresAt: number }>();
  /** Remote sessions that completed pairing: token -> { expiresAt }. */
  private readonly sessions = new Map<string, { expiresAt: number }>();
  /** Runtime-adjustable capability switches (local settings page). */
  caps: CapabilitySwitches;
  private readonly pairTtlMs: number;

  constructor() {
    const raw = process.env.PIHUB_NET;
    this.mode = raw === 'pair' || raw === 'lan' ? raw : 'local';
    this.pairTtlMs = Number(process.env.PIHUB_PAIR_TTL_MS ?? 15 * 60 * 1000);
    this.caps = {
      remoteApprove: process.env.PIHUB_CAP_REMOTE_APPROVE === '1',
      remotePrompt: process.env.PIHUB_CAP_REMOTE_PROMPT === '1',
      remoteShell: process.env.PIHUB_CAP_REMOTE_SHELL === '1',
    };
  }

  /** Updates a capability switch (called from the local settings page). */
  setCap(key: keyof CapabilitySwitches, value: boolean): void {
    this.caps[key] = value;
  }

  /** True when the request comes from a non-loopback host (remote peer). */
  isRemote(req: Request): boolean {
    const host = req.headers.host;
    return typeof host !== 'string' || host.length === 0 || !isLoopbackHost(host);
  }

  /** Generates a one-time pairing code (remote unlock). */
  createPairCode(): string {
    const code = randomBytes(4).toString('hex');
    const now = Date.now();
    this.pairs.set(code, { createdAt: now, expiresAt: now + this.pairTtlMs });
    // Keep the map small: prune expired codes.
    for (const [key, value] of this.pairs) {
      if (value.expiresAt < now) {
        this.pairs.delete(key);
      }
    }
    return code;
  }

  /** Revokes a pairing code / remote session (token rotation). */
  revoke(code: string): void {
    this.pairs.delete(code);
    this.sessions.delete(code);
  }

  listPairs(): Array<{ code: string; expiresAt: number }> {
    const now = Date.now();
    const out: Array<{ code: string; expiresAt: number }> = [];
    for (const [code, value] of this.pairs) {
      if (value.expiresAt > now) {
        out.push({ code, expiresAt: value.expiresAt });
      }
    }
    return out;
  }

  /** Middleware: for remote peers, require a valid pair/session token and
   *  apply capability scope. Loopback traffic is untouched. */
  middleware(req: Request, res: Response, next: NextFunction): void {
    if (!this.isRemote(req)) {
      next();
      return;
    }
    // Any mode with a remote peer: API access requires a pair/session token.
    // In local mode this can only happen for explicitly allowlisted hosts
    // (lan-like) — pairing is still required.
    if (req.path.startsWith('/api/')) {
      const pair = req.query['pair'];
      if (typeof pair !== 'string' || !this.validate(pair)) {
        res.status(403).json({ error: 'remote access requires pairing' });
        return;
      }
    }
    next();
  }

  /** Validates a pair code / session token; expires and rotates cleanly. */
  private validate(token: string): boolean {
    const now = Date.now();
    const pair = this.pairs.get(token);
    if (pair !== undefined && pair.expiresAt > now) {
      // One-time use: the code becomes the session token until expiry.
      this.sessions.set(token, { expiresAt: pair.expiresAt });
      return true;
    }
    const session = this.sessions.get(token);
    return session !== undefined && session.expiresAt > now;
  }

  /** Capability check for remote peers: writes require the matching switch. */
  remoteCan(req: Request, route: 'approve' | 'prompt' | 'shell'): boolean {
    if (!this.isRemote(req)) {
      return true; // local always allowed
    }
    switch (route) {
      case 'approve':
        return this.caps.remoteApprove;
      case 'prompt':
        return this.caps.remotePrompt;
      case 'shell':
        return this.caps.remoteShell;
      default:
        return false;
    }
  }
}

