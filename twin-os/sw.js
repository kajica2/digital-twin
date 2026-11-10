// Versioned local shell. Navigation refreshes online; complete shared assets work offline.
const SCOPE = new URL('./', self.location.href);
const CACHE_PREFIX = 'twin-os-';
const CACHE = 'twin-os-workspace-v3-' + SCOPE.pathname;
const SHELL = [
  './', './index.html', './manifest.webmanifest',
  '../assets/skins/house.css', '../assets/skins/studio.css',
  '../assets/twin-workspace.css', '../lib/skin.js', '../lib/theme.js',
  '../lib/twin-memory.js', '../lib/twin-workspace.js',
].map(path => new URL(path, SCOPE).href);
const CATALOGS = ['../data/songs/catalog.json', '../data/songs/catalog-jazz-solos.json']
  .map(path => new URL(path, SCOPE).href);

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key =>
    // Retire this shell’s versions and the two legacy names, leaving unrelated PWAs intact.
    key === 'twin-os-v1' || key === 'twin-os-v2' ||
    (key.startsWith(CACHE_PREFIX) && key.endsWith('-' + SCOPE.pathname) && key !== CACHE)
  ).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
async function networkFirst(request, fallback) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) { await cache.put(request, response.clone()); return response; }
    return await cache.match(request) || response;
  } catch (_) {
    return await cache.match(request) || (fallback && await cache.match(fallback)) || new Response(
      JSON.stringify({ items: [], roots: [], generatedAt: null, _offline: true }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }
}
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const plain = url.origin + url.pathname;
  if (request.mode === 'navigate' && [SCOPE.href, new URL('index.html', SCOPE).href].includes(plain)) {
    event.respondWith(networkFirst(request, new URL('index.html', SCOPE).href));
  } else if (CATALOGS.includes(plain)) {
    event.respondWith(networkFirst(request));
  } else if (SHELL.includes(plain)) {
    event.respondWith(caches.open(CACHE).then(async cache => {
      const hit = await cache.match(plain);
      if (hit) return hit;
      const response = await fetch(request);
      if (response.ok) await cache.put(plain, response.clone());
      return response;
    }));
  }
});
