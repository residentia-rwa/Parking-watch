const CACHE = "parking-watch-v1";
const SHELL = ["/", "/index.html", "/styles.css", "/app.js", "/manifest.json", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // API calls: always go to network — data must be fresh. No offline fallback for writes.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(request).catch(() => new Response(
      JSON.stringify({ error: "You're offline. This needs a connection." }),
      { headers: { "Content-Type": "application/json" }, status: 503 }
    )));
    return;
  }

  // App shell: cache-first, falling back to network.
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request))
  );
});
