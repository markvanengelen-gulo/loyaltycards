// Keeps a copy of the site on the phone so the cards still open with no signal.
// Every open asks the server whether a file has changed, so new cards show up
// straight away; the saved copy is the fallback when there is no connection.

const CACHE = 'loyaltycards-v2';
const FILES = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'vault.js',
  'vendor/JsBarcode.all.min.js',
  'vendor/qrcode.js',
  'fonts/bricolage-grotesque-latin-wght-normal.woff2',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(request, { cache: 'no-cache' })
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request, { ignoreSearch: true })));
});
