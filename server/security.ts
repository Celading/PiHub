import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { createHash, randomBytes } from 'node:crypto';

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
 *     header; EventSource uses a same-origin HttpOnly control cookie.
 */

const DEFAULT_ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

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
      set.add(bareHost(host));
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
  const firstColon = trimmed.indexOf(':');
  if (colon === -1 || firstColon === -1) {
    return trimmed;
  }
  // Unbracketed address with multiple colons is bare IPv6, not host:port.
  if (firstColon !== colon) {
    return trimmed;
  }
  // host:port — strip the port
  return trimmed.slice(0, colon);
}

function requestIsSecure(req: Request): boolean {
  return req.secure || (req.socket as { encrypted?: boolean }).encrypted === true;
}

function bootstrapKey(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

export interface SecurityGate {
  /** The per-process random token; never persisted, never logged. */
  token: string;
  /** True when the request carries the valid control token. */
  isAuthorized(req: Request): boolean;
  /** HttpOnly cookie used by same-origin transports such as EventSource. */
  cookie(req: Request): string;
  /** Express middleware: host + origin + token gating. */
  middleware(req: Request, res: Response, next: NextFunction): void;
}

const TOKEN_HEADER = 'x-pihub-token';
export const LOCAL_CONTROL_COOKIE = 'pihub_control';

export function createSecurityGate(): SecurityGate {
  const token = randomBytes(32).toString('hex');
  const hosts = allowedHosts();

  const isAuthorized = (req: Request): boolean => {
    const header = req.header(TOKEN_HEADER);
    if (typeof header === 'string' && header.length > 0) {
      return header === token;
    }
    return cookieValue(req, LOCAL_CONTROL_COOKIE) === token;
  };

  const cookie = (req: Request): string =>
    [
      `${LOCAL_CONTROL_COOKIE}=${token}`,
      'HttpOnly',
      'SameSite=Strict',
      'Path=/api',
      ...(requestIsSecure(req) ? ['Secure'] : []),
    ].join('; ');

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    const host = req.headers.host;
    if (typeof host !== 'string' || host.length === 0 || !hosts.has(bareHost(host))) {
      res.status(403).json({ error: 'forbidden host' });
      return;
    }
    const origin = req.header('origin');
    const remote = isRemoteRequest(req);
    const stateChanging = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
    if ((origin === undefined || origin.length === 0) && remote && stateChanging) {
      res.status(403).json({ error: 'missing origin' });
      return;
    }
    // Any browser request carrying Origin — including GET/SSE — must match
    // exactly because cookies are scoped by host, not by port.
    if (origin !== undefined && origin.length > 0) {
      let originUrl: URL;
      try {
        originUrl = new URL(origin);
      } catch {
        res.status(403).json({ error: 'forbidden origin' });
        return;
      }
      const requestProtocol = requestIsSecure(req) ? 'https:' : 'http:';
      const requestHost = host.trim().toLowerCase();
      if (
        !hosts.has(bareHost(originUrl.host)) ||
        originUrl.protocol !== requestProtocol ||
        originUrl.host.toLowerCase() !== requestHost
      ) {
        res.status(403).json({ error: 'forbidden origin' });
        return;
      }
    }
    next();
  };

  return { token, isAuthorized, cookie, middleware };
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
  '/api/dirs',
  '/api/dsh/settings',
  '/api/dsh/sessions',
  '/api/external/sessions',
  '/api/capabilities',
  '/api/pi-agent/settings',
  '/api/net',
  '/api/continuity/manifest',
  '/api/continuity/target',
  '/api/continuity/events',
] as const;

/** Routes that must present the control token (writes + sensitive reads). */
export function requiresToken(req: Request): boolean {
  const p = req.path;
  if (req.method !== 'GET' && !isDemoControlRoute(req.method, p)) {
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

/** Shared remote truth for security, LAN auth, HTML injection and SSE.
 * Either a non-loopback socket/Host or proxy metadata keeps a request remote;
 * none of these headers are trusted as an identity source. */
export function isRemoteRequest(req: Request): boolean {
  const address = req.socket.remoteAddress;
  const socketRemote =
    typeof address !== 'string' || address.length === 0 || !isLoopbackHost(address);
  const host = req.headers.host;
  const hostRemote = typeof host !== 'string' || host.length === 0 || !isLoopbackHost(host);
  const proxyMarked = [
    'forwarded',
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-proto',
    'x-forwarded-port',
    'x-real-ip',
    'via',
  ].some((name) => {
    const value = req.headers[name];
    return typeof value === 'string' ? value.length > 0 : Array.isArray(value) && value.length > 0;
  });
  return socketRemote || hostRemote || proxyMarked;
}

/** Capability families a remote peer may unlock explicitly. */
export type WriteFamily = 'prompt' | 'shell' | 'approve' | 'continue';

const DEMO_CONTROL_ROUTES = new Set([
  'POST /api/demo/start',
  'POST /api/demo/step',
  'POST /api/demo/abort',
  'POST /api/demo/reset',
  'POST /api/demo/play',
  'POST /api/demo/stop',
]);

export function isDemoControlRoute(method: string, path: string): boolean {
  return DEMO_CONTROL_ROUTES.has(`${method.toUpperCase()} ${path}`);
}

/**
 * Maps a request to its remote capability family (audit P0 fix):
 *  - 'prompt' / 'shell' / 'approve' — allowed for remote peers only when
 *    the matching capability switch is on;
 *  - 'never' — every OTHER non-read /api route (session switch/new/fork/
 *    model/thinking, codex abort/session, pipelines save,
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
  if (isDemoControlRoute(method, p)) {
    return null;
  }
  if (
    method === 'POST' &&
    (p === '/api/rpc/prompt' ||
      p === '/api/rpc/steer' ||
      p === '/api/rpc/abort' ||
      p === '/api/codex/prompt' ||
      p === '/api/pipelines/run' ||
      /^\/api\/pipelines\/runs\/[^/]+\/abort$/u.test(p))
  ) {
    return 'prompt';
  }
  if (method === 'POST' && p === '/api/continuity/target/confirm') {
    return 'continue';
  }
  if (method === 'POST' && (p === '/api/rpc/bash' || p === '/api/rpc/abort-bash')) {
    return 'shell';
  }
  if (method === 'POST' && /^\/api\/pipelines\/runs\/[^/]+\/approve$/u.test(p)) {
    return 'approve';
  }
  return 'never';
}

export interface CapabilitySwitches {
  remoteApprove: boolean;
  remotePrompt: boolean;
  remoteShell: boolean;
  remoteContinue: boolean;
}

/**
 * P2-02/R0 LAN gate: decides whether a request is remote and which
 * capabilities it may use. Remote credentials never travel in URLs: a
 * one-use bootstrap is exchanged for an independent HttpOnly cookie session.
 * This remains a compatibility transport, not RemoteLink E2E.
 */
export const REMOTE_SESSION_COOKIE = 'pihub_remote_session';
export const REMOTE_SESSION_EXCHANGE_PATH = '/api/net/session';
export const REMOTE_SESSION_LOGOUT_PATH = '/api/net/session/logout';

const MAX_BOOTSTRAP_TTL_MS = 60_000;
const MAX_SESSION_TTL_MS = 15 * 60 * 1000;

interface LanGateOptions {
  now?: () => number;
  bootstrapTtlMs?: number;
  sessionTtlMs?: number;
}

export interface RemoteBootstrapInfo {
  id: string;
  expiresAt: number;
}

export interface IssuedRemoteBootstrap extends RemoteBootstrapInfo {
  code: string;
}

export interface RemoteSessionInfo {
  id: string;
  createdAt: number;
  expiresAt: number;
}

export interface RemoteSessionAuthorization {
  sessionId: string;
  expiresAt: number;
  isValid: () => boolean;
}

export type RemoteSessionExchange =
  | {
      ok: true;
      session: RemoteSessionInfo;
      /** Server-only Set-Cookie value. Never include this field in JSON. */
      setCookie: string;
    }
  | { ok: false; status: 400 | 403 | 429 | 503; error: string };

export type NetState =
  | {
      mode: NetMode;
      caps: CapabilitySwitches;
      remote: true;
    }
  | {
      mode: NetMode;
      caps: CapabilitySwitches;
      remote: false;
      bootstraps: RemoteBootstrapInfo[];
      sessions: RemoteSessionInfo[];
    };

function boundedTtl(value: number, fallback: number, maximum: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(value), 1_000), maximum);
}

function cookieValue(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (typeof raw !== 'string' || raw.length === 0) {
    return undefined;
  }
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index === -1 || part.slice(0, index).trim() !== name) {
      continue;
    }
    const value = part.slice(index + 1).trim();
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

function sessionCookie(token: string, expiresAt: number, now: number, secure: boolean): string {
  const maxAge = Math.max(1, Math.ceil((expiresAt - now) / 1000));
  return [
    `${REMOTE_SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/api',
    `Max-Age=${String(maxAge)}`,
    `Expires=${new Date(expiresAt).toUTCString()}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

function expiredSessionCookie(secure: boolean): string {
  return [
    `${REMOTE_SESSION_COOKIE}=`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/api',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export class LanGate {
  readonly mode: NetMode;
  private readonly bootstraps = new Map<
    string,
    { id: string; createdAt: number; expiresAt: number }
  >();
  private readonly bootstrapKeysById = new Map<string, string>();
  private readonly sessions = new Map<string, RemoteSessionInfo>();
  private readonly sessionTokensById = new Map<string, string>();
  private readonly authenticatedRequests = new WeakMap<
    Request,
    { token: string; session: RemoteSessionInfo }
  >();
  private readonly sessionRevokedListeners = new Set<(sessionId: string) => void>();
  /** Per-peer failed-bootstrap throttle (keyed by socket address). */
  private readonly failedBootstraps = new Map<
    string,
    { count: number; lockedUntil: number; lastSeen: number }
  >();
  private readonly maxFailedAttempts = 5;
  private readonly lockMs = 60_000;
  /** Runtime-adjustable capability switches (local settings page). */
  caps: CapabilitySwitches;
  private capabilityGeneration = 0;
  private readonly bootstrapTtlMs: number;
  private readonly sessionTtlMs: number;
  private readonly now: () => number;

  constructor(options: LanGateOptions = {}) {
    const raw = process.env.PIHUB_NET;
    this.mode = raw === 'pair' || raw === 'lan' ? raw : 'local';
    this.now = options.now ?? Date.now;
    this.bootstrapTtlMs = boundedTtl(
      options.bootstrapTtlMs ?? Number(process.env.PIHUB_PAIR_TTL_MS ?? MAX_BOOTSTRAP_TTL_MS),
      MAX_BOOTSTRAP_TTL_MS,
      MAX_BOOTSTRAP_TTL_MS,
    );
    this.sessionTtlMs = boundedTtl(
      options.sessionTtlMs ?? Number(process.env.PIHUB_SESSION_TTL_MS ?? MAX_SESSION_TTL_MS),
      MAX_SESSION_TTL_MS,
      MAX_SESSION_TTL_MS,
    );
    this.caps = {
      remoteApprove: process.env.PIHUB_CAP_REMOTE_APPROVE === '1',
      remotePrompt: process.env.PIHUB_CAP_REMOTE_PROMPT === '1',
      remoteShell: process.env.PIHUB_CAP_REMOTE_SHELL === '1',
      remoteContinue: process.env.PIHUB_CAP_REMOTE_CONTINUE === '1',
    };
  }

  /** Updates a capability switch (called from the local settings page). */
  setCap(key: keyof CapabilitySwitches, value: boolean): void {
    if (this.caps[key] !== value) {
      this.caps[key] = value;
      this.capabilityGeneration += 1;
    }
  }

  grantGeneration(): number {
    return this.capabilityGeneration;
  }

  /** Shared remote truth blocks forged loopback Host and proxy-loopback
   *  misclassification while keeping ordinary loopback access local. */
  isRemote(req: Request): boolean {
    return isRemoteRequest(req);
  }

  /** Generates one 256-bit, one-use bootstrap (valid for at most 60s). */
  createBootstrap(): IssuedRemoteBootstrap {
    const code = randomBytes(32).toString('hex');
    const id = randomBytes(16).toString('hex');
    const now = this.now();
    const expiresAt = now + this.bootstrapTtlMs;
    this.prune(now);
    const key = bootstrapKey(code);
    this.bootstraps.set(key, { id, createdAt: now, expiresAt });
    this.bootstrapKeysById.set(id, key);
    return { id, code, expiresAt };
  }

  revokeBootstrap(id: string): boolean {
    const key = this.bootstrapKeysById.get(id);
    if (key === undefined) {
      return false;
    }
    this.bootstraps.delete(key);
    this.bootstrapKeysById.delete(id);
    return true;
  }

  listBootstraps(): RemoteBootstrapInfo[] {
    const now = this.now();
    this.prune(now);
    const out: RemoteBootstrapInfo[] = [];
    for (const value of this.bootstraps.values()) {
      if (value.expiresAt > now) {
        out.push({ id: value.id, expiresAt: value.expiresAt });
      }
    }
    return out;
  }

  listSessions(): RemoteSessionInfo[] {
    this.prune(this.now());
    return [...this.sessions.values()].map((session) => ({ ...session }));
  }

  revokeSession(id: string): boolean {
    const token = this.sessionTokensById.get(id);
    if (token === undefined) {
      return false;
    }
    this.deleteSession(token);
    return true;
  }

  /** Local callers get management state; remote callers get no identifiers. */
  netState(req: Request): NetState {
    const base = { mode: this.mode, caps: { ...this.caps } };
    if (this.isRemote(req)) {
      return { ...base, remote: true };
    }
    return {
      ...base,
      remote: false,
      bootstraps: this.listBootstraps(),
      sessions: this.listSessions(),
    };
  }

  isSessionExchange(req: Request): boolean {
    return req.method === 'POST' && req.path === REMOTE_SESSION_EXCHANGE_PATH;
  }

  isAuthenticated(req: Request): boolean {
    return this.authenticatedRequests.has(req);
  }

  sessionAuthorization(req: Request): RemoteSessionAuthorization | undefined {
    const authenticated = this.authenticatedRequests.get(req);
    if (authenticated === undefined) {
      return undefined;
    }
    const { token, session } = authenticated;
    return {
      sessionId: session.id,
      expiresAt: session.expiresAt,
      isValid: () => this.validSession(token)?.id === session.id,
    };
  }

  onSessionRevoked(listener: (sessionId: string) => void): () => void {
    this.sessionRevokedListeners.add(listener);
    return () => {
      this.sessionRevokedListeners.delete(listener);
    };
  }

  /** Atomically consumes a bootstrap and issues a separate cookie session. */
  exchangeBootstrap(req: Request, bootstrap: unknown): RemoteSessionExchange {
    if (this.mode === 'local') {
      return { ok: false, status: 503, error: 'remote sessions are disabled in local mode' };
    }
    if (this.isLocked(req)) {
      return { ok: false, status: 429, error: 'too many failed bootstrap attempts' };
    }
    if (typeof bootstrap !== 'string' || !/^[0-9a-f]{64}$/iu.test(bootstrap)) {
      this.recordFailure(req);
      return { ok: false, status: 400, error: 'invalid bootstrap' };
    }
    const now = this.now();
    const key = bootstrapKey(bootstrap.toLowerCase());
    const entry = this.bootstraps.get(key);
    if (entry === undefined || entry.expiresAt <= now) {
      this.bootstraps.delete(key);
      if (entry !== undefined) {
        this.bootstrapKeysById.delete(entry.id);
      }
      this.recordFailure(req);
      return { ok: false, status: 403, error: 'invalid or expired bootstrap' };
    }

    // Delete before issuing the session: concurrent/repeated exchanges can
    // observe at most one success in the single-threaded request dispatcher.
    this.bootstraps.delete(key);
    this.bootstrapKeysById.delete(entry.id);
    this.failedBootstraps.delete(req.socket.remoteAddress ?? 'unknown');
    const token = randomBytes(32).toString('hex');
    const session: RemoteSessionInfo = {
      id: randomBytes(16).toString('hex'),
      createdAt: now,
      expiresAt: now + this.sessionTtlMs,
    };
    this.sessions.set(token, session);
    this.sessionTokensById.set(session.id, token);
    return {
      ok: true,
      session: { ...session },
      setCookie: sessionCookie(token, session.expiresAt, now, requestIsSecure(req)),
    };
  }

  /** Revokes the request's current session and returns a clearing cookie. */
  endSession(req: Request): string {
    const token = cookieValue(req, REMOTE_SESSION_COOKIE);
    if (token !== undefined) {
      this.deleteSession(token);
    }
    this.authenticatedRequests.delete(req);
    return expiredSessionCookie(requestIsSecure(req));
  }

  /** Middleware: remote API peers need a valid HttpOnly cookie session;
   *  the bootstrap exchange is the sole unauthenticated API exception. */
  middleware(req: Request, res: Response, next: NextFunction): void {
    if (!this.isRemote(req)) {
      next();
      return;
    }
    if (req.path.startsWith('/api/')) {
      if (this.isSessionExchange(req)) {
        if (this.mode === 'local') {
          res.status(403).json({ error: 'remote access disabled' });
          return;
        }
        if (this.isLocked(req)) {
          res.status(429).json({ error: 'too many failed bootstrap attempts' });
          return;
        }
        next();
        return;
      }

      const token = cookieValue(req, REMOTE_SESSION_COOKIE);
      if (token === undefined) {
        res.status(403).json({ error: 'remote access requires a session' });
        return;
      }
      const session = this.validSession(token);
      if (session === undefined) {
        res.status(403).json({ error: 'remote access requires a session' });
        return;
      }
      this.authenticatedRequests.set(req, { token, session });

      if (req.method === 'POST' && req.path === REMOTE_SESSION_LOGOUT_PATH) {
        next();
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

  /** Counts malformed/oversized exchange bodies without retaining input. */
  noteMalformedBootstrapRequest(req: Request): void {
    this.recordFailure(req);
  }

  /** True when this peer is inside its failed-bootstrap lockout. */
  private isLocked(req: Request): boolean {
    const address = req.socket.remoteAddress ?? 'unknown';
    const entry = this.failedBootstraps.get(address);
    return entry !== undefined && entry.lockedUntil > this.now();
  }

  /** Counts one failed bootstrap; locks the peer after the threshold. */
  private recordFailure(req: Request): void {
    const address = req.socket.remoteAddress ?? 'unknown';
    const now = this.now();
    const entry = this.failedBootstraps.get(address);
    const count =
      entry === undefined || entry.lockedUntil > 0 || now - entry.lastSeen > this.lockMs
        ? 1
        : entry.count + 1;
    for (const [key, value] of this.failedBootstraps) {
      if (now - value.lastSeen > this.lockMs * 2) {
        this.failedBootstraps.delete(key);
      }
    }
    if (this.failedBootstraps.size >= 1000 && !this.failedBootstraps.has(address)) {
      let oldestKey: string | undefined;
      let oldestSeen = Number.POSITIVE_INFINITY;
      for (const [key, value] of this.failedBootstraps) {
        if (value.lastSeen < oldestSeen) {
          oldestKey = key;
          oldestSeen = value.lastSeen;
        }
      }
      if (oldestKey !== undefined) {
        this.failedBootstraps.delete(oldestKey);
      }
    }
    this.failedBootstraps.set(address, {
      count,
      lockedUntil: count >= this.maxFailedAttempts ? now + this.lockMs : 0,
      lastSeen: now,
    });
  }

  private validSession(token: string): RemoteSessionInfo | undefined {
    const session = this.sessions.get(token);
    if (session === undefined) {
      return undefined;
    }
    if (session.expiresAt <= this.now()) {
      this.deleteSession(token);
      return undefined;
    }
    return session;
  }

  private deleteSession(token: string): void {
    const session = this.sessions.get(token);
    if (session !== undefined) {
      this.sessionTokensById.delete(session.id);
      this.sessions.delete(token);
      for (const listener of this.sessionRevokedListeners) {
        try {
          listener(session.id);
        } catch {
          // Revocation remains authoritative even if a transport listener fails.
        }
      }
      return;
    }
    this.sessions.delete(token);
  }

  private prune(now: number): void {
    for (const [key, bootstrap] of this.bootstraps) {
      if (bootstrap.expiresAt <= now) {
        this.bootstraps.delete(key);
        this.bootstrapKeysById.delete(bootstrap.id);
      }
    }
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.deleteSession(token);
      }
    }
  }

  /** Capability check for remote peers: writes require the matching switch. */
  remoteCan(req: Request, route: WriteFamily): boolean {
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
      case 'continue':
        return this.caps.remoteContinue;
      default:
        return false;
    }
  }
}
/** JSON parsing runs only after Host/Origin, remote-session and control-token
 * gates. The exchange endpoint gets a narrow body cap and generic failures so
 * malformed input cannot bypass throttling or leak request fragments. */
export function createJsonBodyMiddleware(lanGate: LanGate): RequestHandler {
  const exchangeJson = express.json({ limit: '1kb', strict: true });
  const standardJson = express.json({ limit: '1mb', strict: true });

  return (req, res, next): void => {
    const exchange = lanGate.isSessionExchange(req);
    if (exchange && req.is('application/json') !== 'application/json') {
      lanGate.noteMalformedBootstrapRequest(req);
      res.status(415).json({ error: 'application/json required' });
      return;
    }
    const parser = exchange ? exchangeJson : standardJson;
    parser(req, res, (error?: unknown) => {
      if (error === undefined) {
        next();
        return;
      }
      if (exchange) {
        lanGate.noteMalformedBootstrapRequest(req);
      }
      const type =
        typeof error === 'object' && error !== null && 'type' in error
          ? (error as { type?: unknown }).type
          : undefined;
      if (type === 'entity.too.large') {
        res.status(413).json({ error: 'request body too large' });
        return;
      }
      if (type === 'entity.parse.failed' || type === 'entity.verify.failed') {
        res.status(400).json({ error: 'invalid request body' });
        return;
      }
      if (exchange) {
        res.status(400).json({ error: 'invalid request body' });
        return;
      }
      next(error);
    });
  };
}
