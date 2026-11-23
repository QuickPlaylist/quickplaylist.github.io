// Service worker: makes the app installable and opens instantly offline.
// App files are fetched network-first, so a new deploy reaches phones on the
// next open. Plex API calls (other origins) are never cached here.
const CACHE = 'quickplaylist-v7';
const SHELL = ['./', 'index.html', 'app.js', 'player.js', 'vendor/hls.light.min.js', 'styles.css', 'manifest.webmanifest', 'auth-done.html', 'auth-done.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'paypal-qr.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    // Only this app's old caches: another app on the same origin may have its own.
    .then(keys => Promise.all(keys.filter(k => /^(quickplaylist|plex-playlists)-v\d+$/.test(k) && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  // Only this app's own files: not Plex, and not other sites on the same github.io origin.
  if (req.method !== 'GET' || !req.url.startsWith(self.registration.scope)) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (res.ok) { const c = await caches.open(CACHE); c.put(req, res.clone()); }
      return res;
    } catch {
      return (await caches.match(req, { ignoreSearch: true })) ||
             (req.mode === 'navigate' ? caches.match('index.html') : Response.error());
    }
  })());
});
