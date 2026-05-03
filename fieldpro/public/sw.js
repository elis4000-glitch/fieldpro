const CACHE = 'fieldpro-v1';
const STATIC = ['/', '/index.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

// Queue for offline API calls
const offlineQueue = [];

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // API calls — network first, queue if offline
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request.clone()).catch(() => {
        // Store failed POST/PUT requests for later sync
        if (e.request.method === 'POST' || e.request.method === 'PUT') {
          e.request.clone().text().then(body => {
            offlineQueue.push({ url: e.request.url, method: e.request.method, body });
          });
        }
        return new Response(JSON.stringify({ offline: true, error: 'Offline' }), {
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }

  // Static assets — cache first
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(resp => {
      const clone = resp.clone();
      caches.open(CACHE).then(c => c.put(e.request, clone));
      return resp;
    }))
  );
});

// Background sync — send queued requests when online
self.addEventListener('sync', e => {
  if (e.tag === 'sync-orders') {
    e.waitUntil(syncOfflineQueue());
  }
});

async function syncOfflineQueue() {
  while (offlineQueue.length) {
    const item = offlineQueue.shift();
    try {
      await fetch(item.url, { method: item.method, body: item.body, headers: { 'Content-Type': 'application/json' } });
    } catch (err) {
      offlineQueue.unshift(item);
      break;
    }
  }
}
