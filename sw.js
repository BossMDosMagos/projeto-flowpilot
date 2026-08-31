/* ============================================
   FLOWPILOT - Service Worker
   Cache-first para o app shell; rede primeiro
   para config.local.js (chave TomTom pode mudar).
   Ao alterar o app, incremente SW_CACHE_VERSION.
   ============================================ */
const SW_CACHE_VERSION = 'flowpilot-v7';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SW_CACHE_VERSION).then((cache) => {
      return Promise.allSettled(APP_SHELL.map((url) => cache.add(url)));
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SW_CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // config.local.js: rede primeiro (chave da TomTom pode ser editada)
  if (url.pathname.endsWith('/config.local.js')) {
    event.respondWith(
      fetch(req).catch(() => caches.match(req).then((r) => r || Response.error()))
    );
    return;
  }

  // Arquivos do próprio app: cache-first
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((hit) => {
        const rede = fetch(req).then((res) => {
          if (res && res.ok && req.method === 'GET') {
            const copia = res.clone();
            caches.open(SW_CACHE_VERSION).then((cache) => cache.put(req, copia));
          }
          return res;
        }).catch(() => hit);
        return hit || rede;
      })
    );
    return;
  }

  // Recursos de terceiros (mapas, tiles, OSRM, TomTom): rede com fallback em cache
  event.respondWith(
    caches.match(req).then((hit) =>
      fetch(req).then((res) => {
        if (res && (res.ok || res.type === 'opaque')) {
          const copia = res.clone();
          caches.open(SW_CACHE_VERSION).then((cache) => cache.put(req, copia));
        }
        return res;
      }).catch(() => hit)
    )
  );
});