/**
 * SPRINT-2 A1: control-token plumbing for the SPA.
 *
 * The production server injects `window.__PIHUB_TOKEN__` into the served
 * index.html; this module reads it once and attaches it to every API call
 * (fetch header). EventSource authentication uses the same-origin HttpOnly
 * control cookie set with the production HTML, so SSE URLs remain clean. In
 * dev/demo mode the token may be absent and calls stay header-free.
 *
 * R0 remote peers use the same-origin HttpOnly session cookie automatically;
 * no LAN credential is appended to the EventSource URL.
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

/** SSE endpoint; same-origin HttpOnly cookies are sent automatically. */
export function eventsUrl(): string {
  return '/api/events';
}
