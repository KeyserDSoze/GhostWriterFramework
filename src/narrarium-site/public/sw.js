const CACHE_NAME = "narrarium-runtime-v1";

function scopeUrl() {
  return new URL(self.registration.scope).href;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.add(new Request(scopeUrl(), { cache: "reload" })).catch(() => undefined)),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.mode !== "navigate") return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.status === 404) {
          return fetch(new Request(scopeUrl(), { cache: "reload" })).catch(() => response);
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(scopeUrl());
        return cached ?? fetch(scopeUrl());
      }),
  );
});
