/**
 * P2-02 pairing-code plumbing for the SPA (remote supervisor flow).
 *
 * A remote browser presents the
 * one-time pairing code generated on the local machine. The code is persisted
 * in localStorage, appended to every API request as `?pair=...` and to the
 * SSE EventSource URL. Loopback clients never need it: the server ignores the
 * query when the peer is local, so storing a stale code is harmless.
 *
 * Mirrors the control-token pattern (controlToken.ts) but is user-enterable:
 * the local page generates a code, the remote page pastes it here.
 */

const PAIR_KEY = 'pi-panel:pair';

let cached: string | null | undefined;

function readPair(): string | undefined {
  if (cached === undefined) {
    try {
      const value =
        typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
          ? window.localStorage.getItem(PAIR_KEY)
          : null;
      cached = typeof value === 'string' && value.length > 0 ? value : null;
    } catch {
      cached = null;
    }
  }
  return cached ?? undefined;
}

/** The persisted pairing code ('' when none is set). */
export function getPairCode(): string {
  return readPair() ?? '';
}

/** Persists a pairing code; empty string clears it. */
export function setPairCode(code: string): void {
  const trimmed = code.trim();
  cached = trimmed.length > 0 ? trimmed : null;
  try {
    if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
      if (trimmed.length > 0) {
        window.localStorage.setItem(PAIR_KEY, trimmed);
      } else {
        window.localStorage.removeItem(PAIR_KEY);
      }
    }
  } catch {
    // storage unavailable — the in-memory value still applies this session
  }
}

/** Query-string fragment (`pair=...`) or '' when no code is stored. */
export function pairQuery(): string {
  const code = readPair();
  return code === undefined || code.length === 0
    ? ''
    : `pair=${encodeURIComponent(code)}`;
}

/** Appends the pairing fragment to an API path (handles existing queries). */
export function withPair(path: string): string {
  const fragment = pairQuery();
  if (fragment.length === 0) {
    return path;
  }
  return path.includes('?') ? `${path}&${fragment}` : `${path}?${fragment}`;
}

/**
 * Distributed mode: a remote-open URL may carry `?pair=<code>` (generated on
 * the host). Adopt it into the persisted pairing code so every API request
 * and the SSE stream present it. Call once at app boot.
 */
export function initPairFromUrl(): void {
  if (typeof window === 'undefined' || typeof window.location === 'undefined') {
    return;
  }
  const pair = new URLSearchParams(window.location.search).get('pair');
  if (pair !== null && pair.length > 0) {
    setPairCode(pair);
  }
}
