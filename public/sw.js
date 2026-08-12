// Minimal production service worker: network-first with a small app-shell
// fallback cache. Registered only in production builds (see main.tsx) so the
// dev server's HMR is never intercepted.
const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest'];
const SHELL_CACHE = 'pihub-shell-v2';
const ASSET_CACHE = 'pihub-assets-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(APP_SHELL)),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== SHELL_CACHE && key !== ASSET_CACHE).map((key) => caches.delete(key))),
      ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') {
    return;
  }
  const url = new URL(request.url);
  // SPRINT-2 A2: never cache API responses — they carry session content,
  // file previews, model configs (with API keys) and cost records. The
  // server already sends Cache-Control: no-store; this is the belt.
  if (url.pathname.startsWith('/api/')) {
    return;
  }
  // Hashed build assets are immutable — cache-first with a network miss
  // falling back to the cache (P1-07: offline works after first load).
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached !== undefined) {
          return cached;
        }
        return fetch(request).then((response) => {
          const copy = response.clone();
          void caches.open(ASSET_CACHE).then((cache) => cache.put(request, copy));
          return response;
        });
      }),
    );
    return;
  }
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (url.origin === self.location.origin && request.destination !== 'document') {
          const copy = response.clone();
          void caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then((cached) => {
          if (cached !== undefined) {
            return cached;
          }
          // Offline fallback for navigations: serve the cached shell.
          if (request.mode === 'navigate') {
            return caches.match('/index.html').then((shell) => shell ?? Response.error());
          }
          return Response.error();
        }),
      ),
  );
});
