// APEX Service Worker — PWA + Notification support
const CACHE_NAME = 'apex-cache-v2';
const CACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './apple-touch-icon.png',
];

// ── INSTALL: cache les fichiers pour mode hors-ligne
self.addEventListener('install', e => {
  console.log('[SW] Install v2');
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(CACHE_URLS).catch(err => {
        console.warn('[SW] Cache partiel:', err);
      });
    })
  );
  self.skipWaiting();
});

// ── ACTIVATE: supprime TOUS les anciens caches
self.addEventListener('activate', e => {
  console.log('[SW] Activate v2 — nettoyage ancien cache');
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => {
        if (k !== CACHE_NAME) {
          console.log('[SW] Suppression cache:', k);
          return caches.delete(k);
        }
      }))
    )
  );
  self.clients.claim();
});

// ── FETCH: offline-first
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(cached => {
      return cached || fetch(e.request).then(response => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return response;
      }).catch(() => cached);
    })
  );
});

// ── NOTIFICATION CLICK: ouvre l'app
self.addEventListener('notificationclick', e => {
  console.log('[SW] Notification cliquée:', e.notification.tag);
  e.notification.close();
  const action = e.notification.data && e.notification.data.action;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      for (const client of clients) {
        if (client.url.includes('github.io') && 'focus' in client) {
          client.focus();
          if (action) client.postMessage({ type: 'NOTIF_ACTION', action });
          return;
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow('./');
      }
    })
  );
});

// ── MESSAGE
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
