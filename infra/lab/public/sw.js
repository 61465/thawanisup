/**
 * Service Worker — منصة ثواني
 * Strategy: network-first للـ JS/CSS/HTML (تحديثات فورية)
 *           cache-first فقط للصور/الخطوط (تحسين الأداء)
 */
const CACHE_NAME = "twani-v65"; // bump 2026-07-04: force refresh + /browse/ path bypass
const IMAGE_CACHE = "twani-images-v1";

self.addEventListener("install", (e) => {
  // فعّل النسخة الجديدة فوراً بدون انتظار إغلاق التابات القديمة
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    // امسح كل الكاشات القديمة (twani-v1, twani-v2, إلخ)
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k !== CACHE_NAME && k !== IMAGE_CACHE)
          .map(k => caches.delete(k))
    );
    await self.clients.claim();
    // 🔄 أعلن لكل التابات المفتوحة بحدوث تحديث → يعيدون التحميل تلقائياً
    const allClients = await self.clients.matchAll({ type: "window" });
    for (const client of allClients) {
      client.postMessage({ type: "SW_UPDATED", cache: CACHE_NAME });
    }
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // API + menu-pro + browse (دائماً fresh): لا تتدخل أبداً
  if (url.pathname.startsWith("/store/") ||
      url.pathname.startsWith("/master/") ||
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/health") ||
      url.pathname.startsWith("/socket.io/") ||
      url.pathname.startsWith("/menu-pro/") ||
      url.pathname.startsWith("/o/") ||
      url.pathname.startsWith("/t/") ||
      url.pathname.startsWith("/m/") ||
      url.pathname.startsWith("/browse/") ||
      url.pathname === "/browse") {
    return;
  }

  // الصور/الخطوط: cache-first (سريع، نادراً تتغير)
  if (/\.(png|jpg|jpeg|gif|svg|ico|woff2?)$/i.test(url.pathname)) {
    e.respondWith(
      caches.match(req).then(cached =>
        cached || fetch(req).then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(IMAGE_CACHE).then(c => c.put(req, clone)).catch(() => {});
          }
          return res;
        }).catch(() => cached)
      )
    );
    return;
  }

  // HTML: لا cache أبداً (always fresh from network)
  if (/\.html$/i.test(url.pathname) || url.pathname === "/" || !url.pathname.includes(".")) {
    e.respondWith(
      fetch(req, { cache: "no-store" }).catch(() => caches.match(req))
    );
    return;
  }
  // JS/CSS: network-first مع كاش fallback
  if (/\.(js|css)$/i.test(url.pathname)) {
    e.respondWith(
      fetch(req).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(req, clone)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match(req))
    );
  }
});
