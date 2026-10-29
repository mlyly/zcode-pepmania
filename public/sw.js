/* Peptimania service worker — hand-rolled, zero dependencies.
 *
 * Strategy:
 *  - Navigations:    network-first, falling back to cache, then to the
 *                    cached app shell ('/') so the SPA always boots offline.
 *  - /_next/static:  cache-first (content-hashed, immutable).
 *  - Other same-origin GETs: stale-while-revalidate.
 *
 * Bump CACHE_VERSION whenever the shell's runtime caching contract changes.
 */
const CACHE_VERSION = "peptimania-v1";
const APP_SHELL_URL = "/";

self.addEventListener("install", (event) => {
    event.waitUntil(
        (async () => {
            const cache = await caches.open(CACHE_VERSION);
            await cache.add(APP_SHELL_URL);
            // Do not skipWaiting automatically; the page decides via a message so a
            // new worker can't strand an old, still-open tab mid-render.
        })()
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        (async () => {
            const keep = new Set([CACHE_VERSION]);
            const names = await caches.keys();
            await Promise.all(
                names.filter((n) => !keep.has(n)).map((n) => caches.delete(n))
            );
            await self.clients.claim();
        })()
    );
});

self.addEventListener("message", (event) => {
    if (event.data === "SKIP_WAITING") self.skipWaiting();
});

async function cacheFirst(request) {
    const cache = await caches.open(CACHE_VERSION);
    const hit = await cache.match(request);
    if (hit) return hit;
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
}

async function staleWhileRevalidate(request) {
    const cache = await caches.open(CACHE_VERSION);
    const hit = await cache.match(request);
    const network = fetch(request)
        .then((response) => {
            if (response.ok) cache.put(request, response.clone());
            return response;
        })
        .catch(() => undefined);
    return hit || (await network) || Response.error();
}

async function networkFirstNavigate(request) {
    const cache = await caches.open(CACHE_VERSION);
    try {
        const response = await fetch(request);
        if (response.ok) {
            cache.put(request, response.clone());
            return response;
        }
        throw new Error(`Bad status ${response.status}`);
    } catch {
        return (
            (await cache.match(request, {ignoreSearch: true})) ||
            (await cache.match(APP_SHELL_URL)) ||
            new Response("Offline and no cached shell available.", {
                status: 503,
                headers: {"Content-Type": "text/plain"},
            })
        );
    }
}

self.addEventListener("fetch", (event) => {
    const {request} = event;
    if (request.method !== "GET") return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;

    if (request.mode === "navigate") {
        event.respondWith(networkFirstNavigate(request));
        return;
    }

    if (url.pathname.startsWith("/_next/static/")) {
        event.respondWith(cacheFirst(request));
        return;
    }

    if (
        url.pathname.startsWith("/icons/") ||
        url.pathname === "/manifest.webmanifest"
    ) {
        event.respondWith(cacheFirst(request));
        return;
    }

    event.respondWith(staleWhileRevalidate(request));
});
