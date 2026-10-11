// Keep the bookmarked address stable. A normal reload gets the current HTML,
// which selects the release's fingerprinted JavaScript and stylesheets.
// This worker stores no responses and never intercepts score/data requests.
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate') return;
  const url = new URL(event.request.url);
  const root = new URL('./', self.location.href);
  if (url.origin !== root.origin || ![root.pathname, root.pathname + 'index.html'].includes(url.pathname)) return;
  event.respondWith(fetch(new Request(event.request, { cache: 'no-store' })));
});
