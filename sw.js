/* ChromaCanvas Pro — service worker.
 * Precaches the whole app so it runs fully offline; updates are picked up on the next start
 * (the page shows a "Restart" toast when a new version has been installed).
 *
 * IMPORTANT: bump VERSION whenever any file in ASSETS changes, so users receive the update.
 */
const VERSION = '1.0.0';
const CACHE = `chromacanvas-pro-${VERSION}`;

const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './privacy.html',
  './js/main.js',
  './js/icons.js',
  './js/state.js',
  './js/history.js',
  './js/renderer.js',
  './js/brush.js',
  './js/color.js',
  './js/tools.js',
  './js/ops.js',
  './js/storage.js',
  './js/ui.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-1024.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/shortcut-new.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('chromacanvas-pro-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // App navigation (including ./?action=new) → cached shell, network as fallback.
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html').then((cached) => cached || fetch(req).catch(() => caches.match('./')))
    );
    return;
  }

  // Everything else: cache first, then network (and cache the fresh copy for next time).
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      });
    })
  );
});
