import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eventsUrl } from './controlToken.js';
import {
  exchangeRemoteBootstrap,
  initializePendingRemoteSession,
  isRemoteBootstrap,
  normalizeRemoteUrl,
  scrubLegacyRemoteCredentials,
} from './remoteSession.js';

const BOOTSTRAP = 'ab'.repeat(32);

beforeEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('RemoteLink R0 browser credential hygiene', () => {
  it('accepts only 256-bit hex bootstraps', () => {
    expect(isRemoteBootstrap(BOOTSTRAP)).toBe(true);
    expect(isRemoteBootstrap('AB'.repeat(32))).toBe(true);
    expect(isRemoteBootstrap('ab'.repeat(16))).toBe(false);
    expect(isRemoteBootstrap('z'.repeat(64))).toBe(false);
  });

  it('exchanges through a POST body with no credential in the URL or storage', async () => {
    const storage = {
      getItem: vi.fn(() => {
        throw new Error('storage must not be read');
      }),
      setItem: vi.fn(() => {
        throw new Error('storage must not be written');
      }),
    };
    vi.stubGlobal('window', { localStorage: storage, sessionStorage: storage });
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const fetcher: typeof fetch = (input, init) => {
      calls.push([input, init]);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            success: true,
            session: { id: 'public-id', createdAt: 1, expiresAt: 2 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    };

    const result = await exchangeRemoteBootstrap(BOOTSTRAP, fetcher);

    expect(result.session.id).toBe('public-id');
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0] ?? [];
    expect(url).toBe('/api/net/session');
    if (typeof url === 'string') {
      expect(url).not.toContain(BOOTSTRAP);
    }
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      referrerPolicy: 'no-referrer',
    });
    expect(typeof init?.body).toBe('string');
    if (typeof init?.body === 'string') {
      expect(JSON.parse(init.body)).toEqual({ bootstrap: BOOTSTRAP });
    }
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('purges retired storage and URL residue without adopting it', () => {
    const localRemove = vi.fn();
    const sessionRemove = vi.fn();
    const replaceState = vi.fn();
    vi.stubGlobal('window', {
      localStorage: { removeItem: localRemove },
      sessionStorage: { removeItem: sessionRemove },
      location: {
        href: `https://host.example/?pair=${BOOTSTRAP}&keep=1#bootstrap=${BOOTSTRAP}`,
      },
      history: { state: { route: 'settings' }, replaceState },
    });

    scrubLegacyRemoteCredentials();

    expect(localRemove).toHaveBeenCalledOnce();
    expect(localRemove).toHaveBeenCalledWith('pi-panel:pair');
    expect(sessionRemove).toHaveBeenCalledOnce();
    expect(sessionRemove).toHaveBeenCalledWith('pi-panel:pair');
    expect(replaceState).toHaveBeenCalledWith({ route: 'settings' }, '', '/?keep=1');
  });

  it('rejects any non-root remote URL data or embedded user credentials', () => {
    expect(normalizeRemoteUrl('https://host.example:3001')).toBe('https://host.example:3001/');
    expect(() => normalizeRemoteUrl('https://host.example/?pair=secret')).toThrow(
      'remote URL must not contain query or fragment data',
    );
    expect(() => normalizeRemoteUrl('https://host.example/#pair=secret')).toThrow(
      'remote URL must not contain query or fragment data',
    );
    expect(() => normalizeRemoteUrl('https://user:pass@host.example/')).toThrow(
      'remote URL must not contain credentials',
    );
    expect(() => normalizeRemoteUrl('https://host.example/settings')).toThrow(
      'remote URL must use the root path',
    );
    expect(() => normalizeRemoteUrl('file:///tmp/panel')).toThrow('invalid remote URL');
  });

  it('bounds startup exchange time and never surfaces remote error text', async () => {
    vi.useFakeTimers();
    const fetcher: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error(`network failed with ${BOOTSTRAP}`));
        });
      });
    const pending = exchangeRemoteBootstrap(BOOTSTRAP, fetcher, 50);
    const timeoutAssertion = expect(pending).rejects.toThrow('remote session exchange failed');
    await vi.advanceTimersByTimeAsync(50);
    await timeoutAssertion;

    const rejected: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: `rejected ${BOOTSTRAP}` }), { status: 403 }),
      );
    await expect(exchangeRemoteBootstrap(BOOTSTRAP, rejected)).rejects.toThrow(
      'remote session exchange failed',
    );
  });

  it('uses the Electron one-shot bootstrap before render, never location query state', async () => {
    const pending = 'cd'.repeat(32);
    const takeRemoteBootstrap = vi.fn(() => Promise.resolve(pending));
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const fetcher: typeof fetch = (input, init) => {
      calls.push([input, init]);
      return Promise.resolve(
        new Response(
          JSON.stringify({ success: true, session: { id: 'id', createdAt: 1, expiresAt: 2 } }),
          { status: 200 },
        ),
      );
    };
    vi.stubGlobal('window', {
      location: { href: `https://host.example/?pair=${BOOTSTRAP}` },
      pihubWindow: { takeRemoteBootstrap },
    });
    vi.stubGlobal('fetch', fetcher);

    await expect(initializePendingRemoteSession()).resolves.toBe(true);
    expect(takeRemoteBootstrap).toHaveBeenCalledOnce();
    expect(calls[0]?.[0]).toBe('/api/net/session');
    const body = calls[0]?.[1]?.body;
    expect(typeof body).toBe('string');
    if (typeof body === 'string') {
      expect(JSON.parse(body)).toEqual({ bootstrap: pending });
    }
  });

  it('keeps the EventSource URL credential-free even when a local token global exists', () => {
    vi.stubGlobal('window', { __PIHUB_TOKEN__: 'local-control-secret' });
    expect(eventsUrl()).toBe('/api/events');
  });

  it('keeps credential-bearing HTML out of Service Worker CacheStorage', () => {
    const serviceWorker = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');
    expect(serviceWorker).toContain("const APP_SHELL = ['/manifest.webmanifest'];");
    expect(serviceWorker).toContain("const SHELL_CACHE = 'pihub-shell-v3';");
    expect(serviceWorker).toContain("const ASSET_CACHE = 'pihub-assets-v2';");
    expect(serviceWorker).toContain(
      "request.mode === 'navigate' || request.destination === 'document'",
    );
    expect(serviceWorker).toContain('event.respondWith(fetch(request));');
    expect(serviceWorker).toContain('function isCacheableResponse(response, url)');
    expect(serviceWorker.match(/isCacheableResponse\(response, url\)/gu)).toHaveLength(3);
    expect(serviceWorker).toContain("!contentType.toLowerCase().includes('text/html')");
    expect(serviceWorker).not.toContain("caches.match('/index.html')");
    expect(serviceWorker).not.toContain("['/', '/index.html'");
  });

  it('keeps Electron loadURL clean and passes bootstrap through separate IPC', () => {
    const main = readFileSync(new URL('../../electron/main.cjs', import.meta.url), 'utf8');
    const preload = readFileSync(new URL('../../electron/preload.cjs', import.meta.url), 'utf8');
    expect(main).toContain('win.loadURL(target.url)');
    expect(main).toContain('!isLocalPanelSender(event.sender)');
    expect(main).toContain("ipcMain.handle('pihub:take-remote-bootstrap'");
    expect(main).toContain('clearPendingRemoteBootstrap(id, pending)');
    expect(main).toContain('current !== expected');
    expect(main).toContain('REMOTE_BOOTSTRAP_TTL_MS');
    expect(main).toContain("win.webContents.once('did-fail-load'");
    expect(main).not.toContain('?pair=');
    expect(preload).toContain("ipcRenderer.send('pihub:open-remote', url, bootstrap)");
    expect(preload).toContain("ipcRenderer.invoke('pihub:take-remote-bootstrap')");
  });

  it('keeps bootstrap failure diagnostics fixed and credential-free', () => {
    const main = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8');
    expect(main).toContain("console.error('[pihub] remote session bootstrap failed')");
    expect(main).not.toContain('error.message');
  });
});
