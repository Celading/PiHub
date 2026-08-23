import { pairQuery } from './pairToken.js';

/**
 * SPRINT-2 A1: control-token plumbing for the SPA.
 *
 * The production server injects `window.__PIHUB_TOKEN__` into the served
 * index.html; this module reads it once and attaches it to every API call
 * (fetch header) and to the SSE EventSource (?token= query, since
 * EventSource cannot set headers). In dev/demo mode the token may be absent —
 * the server then skips token gating — so calls stay header-free.
 *
 * P2-02: remote peers additionally carry their pairing code (?pair=) on the
 * SSE URL, mirroring the fetch-side handling in client.ts.
 */

declare global {
  interface Window {
    __PIHUB_TOKEN__?: string;
  }
}

let cached: string | null | undefined;

function readToken(): string | undefined {
  if (cached === undefined) {
    const value = typeof window !== 'undefined' ? window.__PIHUB_TOKEN__ : undefined;
    cached = typeof value === 'string' && value.length > 0 ? value : null;
  }
  return cached ?? undefined;
}

/** Header object to merge into fetch calls (empty when no token is set). */
export function controlTokenHeader(): Record<string, string> {
  const token = readToken();
  return token === undefined ? {} : { 'X-PiHub-Token': token };
}

/** SSE endpoint with the token attached as a query param when present. */
export function eventsUrl(): string {
  const token = readToken();
  const tokenPart = token === undefined ? '' : `token=${encodeURIComponent(token)}`;
  const pairPart = pairQuery();
  const params = [tokenPart, pairPart].filter((part) => part.length > 0).join('&');
  return params.length === 0 ? '/api/events' : `/api/events?${params}`;
}
