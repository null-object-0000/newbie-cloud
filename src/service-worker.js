/* Generated build constants; no cloud data is stored by this worker. */
const CACHE = 'newbie-cloud-shell-' + __BUILD_VERSION__;
const PRECACHE = __PRECACHE_URLS__;
const STATIC_PATHS = new Set(PRECACHE);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) =>
        cache.addAll(
          PRECACHE.map((path) => new Request(path, { cache: 'reload', credentials: 'omit' })),
        ),
      ),
  );
  // Updates wait for an explicit action; never reload an in-progress DNS edit.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith('newbie-cloud-shell-') && key !== CACHE)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'ACTIVATE_UPDATE') event.waitUntil(self.skipWaiting());
});

self.addEventListener('fetch', (event) => {
  const request = event.request,
    url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // API reads and writes always use the network. No offline replay or caching.
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(
        () =>
          new Response(
            JSON.stringify({
              error: '当前无法连接网络，不能读取或修改云资源。请联网后重试。',
              offline: true,
            }),
            {
              status: 503,
              headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store',
              },
            },
          ),
      ),
    );
    return;
  }
  if (request.method !== 'GET') return;
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => (await cache.match('/')) ?? fetch(request)),
    );
  } else if (STATIC_PATHS.has(url.pathname)) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => (await cache.match(url.pathname)) ?? fetch(request)),
    );
  }
});
