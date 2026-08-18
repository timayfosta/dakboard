const CACHE = "family-admin-v19";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
  );
  self.clients.claim();
});

function inAdminScope(pathname) {
  if (pathname.startsWith("/admin/") || pathname.startsWith("/phone/")) return true;
  return (
    pathname === "/" ||
    pathname === "/index.html" ||
    pathname === "/api.js" ||
    pathname === "/app.js" ||
    pathname === "/admin.css" ||
    pathname === "/sw.js" ||
    pathname.startsWith("/icons/")
  );
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/")) return;
  if (event.request.method !== "GET") return;
  if (!inAdminScope(url.pathname)) return;

  // Network-first so admin UI updates show up after refresh (cache = offline fallback)
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
