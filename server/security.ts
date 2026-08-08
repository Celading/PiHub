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
  const raw = process.env.PIHUB_ALLOWED_HOSTS;
  if (raw === undefined || raw.length === 0) {
    return DEFAULT_ALLOWED_HOSTS;
  }
  const set = new Set<string>();
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
