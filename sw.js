/* RCR Shop service worker: makes the web app installable and lets it open without a connection.
   Always tries the network first (so updates show up right away) and falls back to the last saved copy.
   Google sign-in and Google Drive requests are never cached. */
const CACHE = 'rcr-shop-20261119-151805';                 // BUILD is replaced with a timestamp each time the site is published
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(['./', 'dashboard/', 'invoice/', 'shared/rcr-drive.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'])).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;          // Google APIs etc.: straight to the network
  // cache: 'no-cache' asks GitHub whether the file changed every time (it would otherwise reuse it for 10 minutes)
  e.respondWith(fetch(u.href, { cache: 'no-cache', credentials: 'same-origin' }).then(r => {
    if (r.ok && !u.search && !u.hash) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match(u.pathname.endsWith('/') ? u.pathname : './'))));
});
