/* RCR Shop service worker: makes the web app installable, open instantly and work without a connection.
   Pages and files are served from the saved copy right away and refreshed from GitHub in the background
   ("stale-while-revalidate"). A new version shows up through the app's "🔄 Update now" bar, which loads the page
   with ?fresh=… — those requests always go to the network and replace the saved copy.
   Google sign-in and Google Drive requests are never touched. */
const CACHE = 'rcr-shop-20261120-205535';                 // BUILD is replaced with a timestamp each time the site is published
const SHELL = ['./', 'dashboard/', 'invoice/', 'shared/rcr-drive.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', e => {
  // cache: 'reload' skips the browser's own HTTP cache (GitHub allows 10 minutes), so a new version really gets the new files
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;          // Google APIs etc.: straight to the network
  if (u.searchParams.has('update-check')) return;                                   // the update check must see the live copy
  const key = u.origin + u.pathname;                                                // saved per page, whatever the ?query
  const fromNet = () => fetch(key, { cache: 'no-cache', credentials: 'same-origin' }).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
    return r;
  });
  const fallback = () => caches.match(key).then(r => r || caches.match(new URL(u.pathname.endsWith('/') ? u.pathname : './', location.href).href));
  // "Update now": the page and everything it loads come from the network, so the new page never runs with an old shared/rcr-drive.js
  if (u.searchParams.has('fresh') || /[?&]fresh=/.test(e.request.referrer || '')) { e.respondWith(fromNet().catch(fallback)); return; }
  e.respondWith(caches.match(key).then(hit => {
    const net = fromNet();
    if (hit) { e.waitUntil(net.catch(() => {})); return hit; }                       // open instantly, refresh quietly
    return net.catch(fallback);
  }));
});
