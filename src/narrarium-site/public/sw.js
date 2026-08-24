const REQUESTED_RELEASE = new URL(self.location.href).searchParams.get("v") || "unknown";
importScripts(`./precache-manifest.js?v=${encodeURIComponent(REQUESTED_RELEASE)}`);

// The registration URL is authoritative. A stale imported manifest must never
// relabel an old asset set as the newly requested release.
const RELEASE = REQUESTED_RELEASE;
if (self.__NARRARIUM_RELEASE__ && self.__NARRARIUM_RELEASE__ !== RELEASE) {
  throw new Error(`Precache release mismatch: requested ${RELEASE}, received ${self.__NARRARIUM_RELEASE__}.`);
}
const PRECACHE_NAME = `narrarium-precache-${RELEASE}`;
const RUNTIME_NAME = `narrarium-runtime-${RELEASE}`;
const OWNED_CACHE_PREFIX = "narrarium-";
const MAX_RUNTIME_ENTRIES = 64;

function scopeUrl() {
  return new URL(self.registration.scope).href;
}

function scopedUrl(path) {
  return new URL(path, scopeUrl()).href;
}

async function trimRuntimeCache(cache) {
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_RUNTIME_ENTRIES)).map((request) => cache.delete(request)));
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(PRECACHE_NAME).then((cache) => cache.addAll([
      new Request(scopeUrl(), { cache: "reload" }),
      ...(self.__NARRARIUM_PRECACHE__ || []).map((path) => new Request(scopedUrl(path), { cache: "reload" })),
    ])),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith(OWNED_CACHE_PREFIX) && key !== PRECACHE_NAME && key !== RUNTIME_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      caches.open(PRECACHE_NAME).then(async (cache) => {
        const cached = await cache.match(request, { ignoreSearch: true });
        if (cached) return cached;
        const shell = await cache.match(scopeUrl());
        if (shell) return shell;
        return fetch(request);
      }),
    );
    return;
  }

  if (!["script", "style", "worker", "image", "font"].includes(request.destination)) return;

  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then(async (cached) => {
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) {
        const runtime = await caches.open(RUNTIME_NAME);
        await runtime.put(request, response.clone());
        await trimRuntimeCache(runtime);
      }
      return response;
    }),
  );
});
