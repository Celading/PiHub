// Minimal production service worker: network-first with a small app-shell
// fallback cache. Registered only in production builds (see main.tsx) so the
// dev server's HMR is never intercepted.
const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open('pihub-shell-v1').then((cache) => cache.addAll(APP_SHELL)),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== 'pihub-shell-v1').map((key) => caches.delete(key))),
      ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') {
    return;
  }
  event.respondWith(
    fetch(request)
      .then((response) => {
        const url = new URL(request.url);
        if (url.origin === self.location.origin && request.destination !== 'document') {
          const copy = response.clone();
          void caches.open('pihub-shell-v1').then((cache) => cache.put(request, copy));
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
