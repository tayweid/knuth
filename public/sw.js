"use strict";

// Network-first avoids pinning an old UI/engine protocol while retaining the
// application shell — which is what lets a file-handler launch open, and say
// so, when the engine is not running. The engine serves this page, so a pip
// upgrade changes these bytes; the cache must never win over the network.
const CACHE_NAME = "knuth-app-shell-v1";
const APP_SHELL = [
  "./",
  "./manifest.webmanifest",
  "./icons/knuth-192.png",
  "./icons/knuth-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names
          .filter((name) => name.startsWith("knuth-app-shell-") && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    try {
      const response = await fetch(event.request);
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(event.request, response.clone());
      }
      return response;
    } catch {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        if (event.request.mode === "navigate") return caches.match("./");
        throw new Error("offline and resource is not cached");
    }
  })());
});
