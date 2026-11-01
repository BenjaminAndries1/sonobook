/* Service worker: bewaart de app zelf zodat hij ook zonder internet opent.
   Bij een nieuwe versie van de app: verhoog VERSIE, anders blijft de oude cache actief. */
const VERSIE = "luisterboeken-v1";
const SHELL = ["./", "./index.html", "./app.js", "./manifest.webmanifest", "./icon.svg"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSIE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSIE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      if (res.ok) caches.open(VERSIE).then(c => c.put(e.request, res.clone()));
      return res;
    }))
  );
});
