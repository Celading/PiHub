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

/** v1c-completion: sensitive-read prefixes that must present the control
 *  token — full-content session / adapter-history / git-diff / file-list /
 *  prompt-index reads (audit P1-2: the allowlist used to miss them). */
const SENSITIVE_READ_PREFIXES = [
  '/api/sessions/',
  '/api/claude/sessions/',
  '/api/codex/sessions/',
  '/api/zcode/sessions/',
  '/api/atomcode/sessions',
  '/api/codex/messages',
  '/api/prompts',
  '/api/git/diff',
  '/api/files',
] as const;

const SENSITIVE_READ_EXACT = [
  '/api/models-config',
  '/api/file/preview',
  '/api/rpc/messages',
  '/api/rpc/entries',
  '/api/rpc/tree',
  '/api/events',
] as const;

/** Routes that must present the control token (writes + sensitive reads). */
export function requiresToken(req: Request): boolean {
  const p = req.path;
  if (req.method !== 'GET' && !p.startsWith('/api/demo/')) {
    // /api/demo/* is the demo-only driver surface (synthetic data, its own
    // control plane — see routes.ts); everything else that mutates state
    // needs the token.
    if (p.startsWith('/api/')) {
      return true;
    }
  }
  // Sensitive reads: credentials-bearing model config, session files,
  // file preview, bash history/tree state, the SSE event stream, and
  // (v1c-completion) full-content session/adapter/git/file/prompt reads.
  if ((SENSITIVE_READ_EXACT as readonly string[]).includes(p)) {
    return true;
  }
  return SENSITIVE_READ_PREFIXES.some((prefix) => p.startsWith(prefix));
}

/* ---- P2-02: LAN access modes + capability scope ---- */

export type NetMode = 'local' | 'pair' | 'lan';

const LOOPBACK_HOSTS = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  '[::1]',
  '::ffff:127.0.0.1', // IPv4-mapped IPv6 loopback (Node remoteAddress form)
]);

function isLoopbackHost(host: string): boolean {
  const trimmed = host.trim().toLowerCase();
  // Full-address match first: bareHost() mangles bare IPv6 (::1 → '::').
  if (LOOPBACK_HOSTS.has(trimmed)) {
    return true;
  }
  const bare = bareHost(trimmed);
  if (LOOPBACK_HOSTS.has(bare)) {
    return true;
  }
  // IPv4-mapped IPv6 loopback (::ffff:127.0.0.1) — the tail is dotted IPv4.
  if (bare.startsWith('::ffff:')) {
    const ipv4 = bare.slice('::ffff:'.length);
    return /^127\.\d+\.\d+\.\d+$/.test(ipv4);
  }
  return false;
}

/** Capability families a remote peer may unlock explicitly. */
export type WriteFamily = 'prompt' | 'shell' | 'approve';

/**
 * Maps a request to its remote capability family (audit P0 fix):
 *  - 'prompt' / 'shell' / 'approve' — allowed for remote peers only when
 *    the matching capability switch is on;
 *  - 'never' — every OTHER non-read /api route (session switch/new/fork/
 *    model/thinking, codex abort/session, pipelines run/abort/save,
 *    sessions/delete, models-config, system-prompt PUT, net management…):
 *    remote peers are ALWAYS denied. Fail-closed: a future write route
 *    that forgets to classify is denied by default;
 *  - null — reads (GET/HEAD/OPTIONS) and /api/demo/* (they keep their own
 *    503 write guards) pass without a capability.
 */
export function writeFamilyOf(method: string, p: string): WriteFamily | 'never' | null {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return null;
  }
  if (p.startsWith('/api/demo/')) {
    return null;
  }
  if (p === '/api/rpc/prompt' || p === '/api/rpc/steer' || p === '/api/codex/prompt') {
    return 'prompt';
  }
  if (p === '/api/rpc/bash' || p === '/api/rpc/abort-bash') {
    return 'shell';
  }
  if (p.startsWith('/api/pipelines/runs/') && p.endsWith('/approve')) {
    return 'approve';
  }
  return 'never';
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
  /** P2-2: per-peer failed-pairing throttle (keyed by socket address). */
  private readonly failedPairs = new Map<string, { count: number; lockedUntil: number }>();
  private readonly maxFailedAttempts = 5;
  private readonly lockMs = 60_000;
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

  /** True when the request comes from a non-loopback peer (v1c-completion:
   *  judged by socket.remoteAddress, NOT the forgeable Host header — audit
   *  P1-3: a forged `Host: 127.0.0.1` used to bypass pairing on a
   *  LAN-exposed instance). The Host allowlist in `middleware` stays as the
   *  DNS-rebinding line of defense; remoteness is a socket fact. */
  isRemote(req: Request): boolean {
    const address = req.socket.remoteAddress;
    return typeof address !== 'string' || address.length === 0 || !isLoopbackHost(address);
  }

  /** Generates a one-time pairing code (remote unlock). */
  createPairCode(): string {
    // P2-2: 128-bit entropy (32-bit was guessable within a TTL window).
    const code = randomBytes(16).toString('hex');
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
      // P2-2: throttle repeated failed pairings per peer (brute force).
      if (this.isLocked(req)) {
        res.status(429).json({ error: 'too many failed pairing attempts' });
        return;
      }
      const pair = req.query['pair'];
      if (typeof pair !== 'string' || !this.validate(pair)) {
        this.recordFailure(req);
        res.status(403).json({ error: 'remote access requires pairing' });
        return;
      }
      // Capability scope (audit P0): pairing alone never unlocks agent-
      // controlling writes. Non-read routes map to a capability family;
      // 'never' routes are always denied, and classified families require
      // the matching switch (remote default is read-only).
      const family = writeFamilyOf(req.method, req.path);
      if (family === 'never' || (family !== null && !this.remoteCan(req, family))) {
        res.status(403).json({ error: 'remote capability not enabled' });
        return;
      }
    }
    next();
  }

  /** P2-2: true when this peer is inside its failed-pairing lockout. */
  private isLocked(req: Request): boolean {
    const address = req.socket.remoteAddress ?? 'unknown';
    const entry = this.failedPairs.get(address);
    return entry !== undefined && entry.lockedUntil > Date.now();
  }

  /** P2-2: counts one failed pairing; locks the peer after the threshold. */
  private recordFailure(req: Request): void {
    const address = req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const entry = this.failedPairs.get(address);
    const count =
      entry !== undefined && entry.lockedUntil <= now ? entry.count + 1 : 1;
    this.failedPairs.set(address, {
      count,
      lockedUntil: count >= this.maxFailedAttempts ? now + this.lockMs : 0,
    });
    // Keep the map bounded: prune long-idle peers.
    if (this.failedPairs.size > 1000) {
      for (const [key, value] of this.failedPairs) {
        if (value.count === 0 || value.lockedUntil <= now) {
          this.failedPairs.delete(key);
        }
      }
    }
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

