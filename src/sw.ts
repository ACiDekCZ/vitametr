/**
 * Service worker (K9): offline-first app-shell caching.
 *
 * Built as a separate bundle (scripts/bundle.js) and served from the app root
 * so its scope covers the whole app. The cache name carries the build version
 * so a new release invalidates the old shell. The app makes no network requests
 * at runtime, so a precached shell is fully functional offline.
 */

/// <reference lib="webworker" />

declare const self: ServiceWorkerGlobalScope;
declare const __BUILD_ID__: string;
declare const __SW_NETWORK_FIRST__: boolean;

// Per-build in development, the package version in production (see bundle.js).
// A changing id makes a rebuild produce a new sw.js and a new cache name, so the
// cache-first shell is replaced instead of serving stale assets forever.
const BUILD_ID = typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev';
const CACHE = `vitametr-shell-${BUILD_ID}`;
// In development the cache-first shell would shadow freshly rebuilt assets
// (esbuild --serve rebuilds main.js but not sw.js), so dev serves network-first
// with a cache fallback; production stays cache-first for a true offline shell.
const DEV = BUILD_ID.includes('-dev-');
// Network-first fetch strategy (dev + staging): always try the network so a
// redeploy is visible on the next open. Production stays cache-first (offline).
const NETWORK_FIRST =
  DEV || (typeof __SW_NETWORK_FIRST__ !== 'undefined' && __SW_NETWORK_FIRST__ === true);

/** Everything needed to boot the app with no network. */
const SHELL: readonly string[] = [
  './',
  './index.html',
  './main.js',
  './main.css',
  './manifest.webmanifest',
  './icon.svg',
  './icon-maskable.svg',
  './fonts/hanken-grotesk-latin.woff2',
  './fonts/hanken-grotesk-latin-ext.woff2',
];

self.addEventListener('install', (event) => {
  // On staging (network-first) take over immediately, so a redeploy is live on
  // the next open without waiting for every tab to close. Production keeps the
  // controlled update (the page posts SKIP_WAITING on user action).
  if (NETWORK_FIRST) void self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL as string[])),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop caches from older versions.
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n.startsWith('vitametr-shell-') && n !== CACHE).map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  // The page posts SKIP_WAITING when the user accepts an update.
  if ((event.data as { type?: string } | undefined)?.type === 'SKIP_WAITING') {
    void self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Only handle same-origin requests; the app never talks to other origins.
  if (url.origin !== self.location.origin) return;

  // Navigations fall back to the cached shell (SPA + offline). Dev prefers the
  // network so a rebuilt shell is never shadowed by the cache.
  if (request.mode === 'navigate') {
    event.respondWith(
      NETWORK_FIRST
        ? fetch(request).catch(() => caches.match('./index.html').then((c) => c ?? fetch(request)))
        : caches.match('./index.html').then((cached) => cached ?? fetch(request)),
    );
    return;
  }

  // Network-first (cache only as an offline fallback) so a redeploy shows up
  // without waiting for a new sw.js to take over.
  if (NETWORK_FIRST) {
    event.respondWith(fetch(request).catch(() => caches.match(request).then((c) => c ?? Response.error())));
    return;
  }

  // Prod: cache-first for the offline shell.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});

export {};
