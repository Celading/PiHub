/**
 * R0 LAN compatibility-session bootstrap plumbing.
 *
 * Bootstrap material exists only in caller memory and the POST body used for
 * the one-time exchange. The resulting credential is an HttpOnly cookie, so
 * this module never adopts or persists a credential. Startup only removes
 * residue left by the retired URL/Web Storage transport.
 */

const BOOTSTRAP_RE = /^[0-9a-f]{64}$/iu;
const DEFAULT_EXCHANGE_TIMEOUT_MS = 10_000;

export interface RemoteSessionInfo {
  id: string;
  createdAt: number;
  expiresAt: number;
}

export interface RemoteSessionExchangeResponse {
  success: true;
  session: RemoteSessionInfo;
}

export function isRemoteBootstrap(value: string): boolean {
  return BOOTSTRAP_RE.test(value.trim());
}

/** Removes residue left by the retired URL/localStorage pairing transport. */
export function scrubLegacyRemoteCredentials(): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.removeItem('pi-panel:pair');
    window.sessionStorage.removeItem('pi-panel:pair');
  } catch {
    // Storage may be unavailable; no value is read or copied.
  }
  try {
    const url = new URL(window.location.href);
    let changed = false;
    for (const key of ['pair', 'bootstrap', 'session', 'token']) {
      if (url.searchParams.has(key)) {
        url.searchParams.delete(key);
        changed = true;
      }
    }
    if (/(?:pair|bootstrap|session|token)=/iu.test(url.hash)) {
      url.hash = '';
      changed = true;
    }
    if (changed) {
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    }
  } catch {
    // A non-browser test double may not expose a complete Location/History.
  }
}

/** Validates a desktop remote target and rejects legacy secret-bearing URLs. */
export function normalizeRemoteUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('invalid remote URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('invalid remote URL');
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error('remote URL must not contain credentials');
  }
  if (url.pathname !== '/') {
    throw new Error('remote URL must use the root path');
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new Error('remote URL must not contain query or fragment data');
  }
  return url.toString();
}

/** Exchanges one bootstrap without placing it in a URL or Web Storage. */
export async function exchangeRemoteBootstrap(
  value: string,
  fetcher: typeof fetch = fetch,
  timeoutMs = DEFAULT_EXCHANGE_TIMEOUT_MS,
): Promise<RemoteSessionExchangeResponse> {
  const bootstrap = value.trim().toLowerCase();
  if (!isRemoteBootstrap(bootstrap)) {
    throw new Error('invalid bootstrap format');
  }
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => {
    controller.abort();
  }, Math.max(1, timeoutMs));
  try {
    const response = await fetcher('/api/net/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bootstrap }),
      credentials: 'same-origin',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error('exchange rejected');
    }
    const parsed = (await response.json()) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('invalid exchange response');
    }
    const record = parsed as Record<string, unknown>;
    const session = record['session'];
    if (
      record['success'] !== true ||
      typeof session !== 'object' ||
      session === null ||
      typeof (session as Record<string, unknown>)['id'] !== 'string' ||
      typeof (session as Record<string, unknown>)['createdAt'] !== 'number' ||
      typeof (session as Record<string, unknown>)['expiresAt'] !== 'number'
    ) {
      throw new Error('invalid exchange response');
    }
    const sessionRecord = session as Record<string, unknown>;
    return {
      success: true,
      session: {
        id: sessionRecord['id'] as string,
        createdAt: sessionRecord['createdAt'] as number,
        expiresAt: sessionRecord['expiresAt'] as number,
      },
    };
  } catch {
    // Do not surface a remote response body, network diagnostic or bootstrap.
    throw new Error('remote session exchange failed');
  } finally {
    globalThis.clearTimeout(timer);
  }
}

/** Electron only: take the main-process bootstrap once and exchange it. */
export async function initializePendingRemoteSession(): Promise<boolean> {
  if (typeof window === 'undefined' || window.pihubWindow === undefined) {
    return false;
  }
  const bootstrap = await window.pihubWindow.takeRemoteBootstrap();
  if (bootstrap === null) {
    return false;
  }
  await exchangeRemoteBootstrap(bootstrap);
  return true;
}
