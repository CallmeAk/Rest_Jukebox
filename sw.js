/* BeatBites service worker: offline app shell + safe runtime caching. */
const CACHE = "beatbites-v6";
const SHELL = [
  "./", "./index.html", "./style.css",
  "./config.js", "./js/store.js", "./js/core.js", "./js/app.js",
  "./manifest.json", "./icons/icon.svg", "./icons/icon-192.png", "./icons/icon-512.png"
];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Never cache API calls (iTunes, QR, Supabase) — always go to network.
  const isApi = /itunes\.apple\.com|api\.qrserver\.com|supabase/.test(url.host);
  if (e.request.method !== "GET" || isApi) return;
  // Cache-first for the local shell, falling back to network.
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => hit))
  );
});
