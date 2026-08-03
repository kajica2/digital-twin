// Twin OS service worker — sprint 1 stub.
//
// Scope:
//   - Cache the shell on install so the app loads offline
//   - Pass through all other requests (no app shell fetch handler yet)
//   - Reserve the namespace for sprint 2 (cache-first for static,
//     network-first for the songs catalog, etc.)
//
// Why a stub and not the full thing: the AGENTS.md convention is
// "ship the smallest thing that proves the contract." Sprint 1 ships
// a loadable, installable PWA. Sprint 2 adds IndexedDB + the catalog
// sync and the real fetch strategies. This file will grow then.

const CACHE = 'twin-os-v1';
const SHELL = ['./', './index.html', './manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  // Pass through everything. Sprint 2 will add cache-first for the
  // shell + network-first with fallback for the catalog.
  return;
});