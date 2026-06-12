/**
 * Service Worker — منصة ثواني
 * يخدم كـ offline cache للوحة الإدارة + يفعّل "Add to Home Screen"
 */
const CACHE_NAME = "twani-v1";
const STATIC_ASSETS = [
  "/admin-enhancements.js",
  "/business-types.js",
  "/ux-enhancements.js",
  "/manifest.json",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(STATIC_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  // فقط GET للـ static assets — كل شيء آخر network-first
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (!/\.(js|css|png|jpg|jpeg|gif|svg|woff2?|ico)$/i.test(url.pathname)) return;

  e.respondWith(
    caches.match(req).then(cached =>
      cached || fetch(req).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(req, clone)).catch(() => {});
        }
        return res;
      }).catch(() => cached)
    )
  );
});
