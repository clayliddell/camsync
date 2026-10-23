// Caches the app shell so CamSync opens (and records) without a connection.
// Bump VERSION when you change any app file so phones pick up the update.
const VERSION = 'camsync-v5';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './config.js',
  './core.js',
  './privacy.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)));
  // Wait for existing tabs to close; never switch shell versions mid-recording.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('camsync-') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Same-origin GETs: serve from cache, refresh in the background.
// Google API and sign-in traffic is never touched.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(req, { ignoreSearch: true });
    // Keep all scripts on one version; the next worker refreshes the whole shell.
    // Only known app shell assets are cached, never recordings or credentials.
    if (cached) return cached;
    try { return await fetch(req); }
    catch { return new Response('CamSync is offline. Reopen a previously loaded app URL.', { status: 503 }); }
  })());
});
