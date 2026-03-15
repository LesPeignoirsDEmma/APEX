// APEX Service Worker — PWA + Notification support
const CACHE_NAME = 'apex-cache-v1';
const CACHE_URLS = [
  './APEX — Mon Système de Vie.html',
  './manifest.json',
  './icon.svg',
];

// ── INSTALL: cache les fichiers pour mode hors-ligne
self.addEventListener('install', e => {
  console.log('[SW] Install');
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(CACHE_URLS).catch(err => {
        console.warn('[SW] Cache partiel:', err);
      });
    })
  );
  self.skipWaiting();
});

// ── ACTIVATE
self.addEventListener('activate', e => {
  console.log('[SW] Activate');
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
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
      // Si l'app est déjà ouverte, la mettre en avant
      for (const client of clients) {
        if (client.url.includes('APEX') && 'focus' in client) {
          client.focus();
          if (action) client.postMessage({ type: 'NOTIF_ACTION', action });
          return;
        }
      }
      // Sinon, ouvrir l'app
      if (self.clients.openWindow) {
        return self.clients.openWindow('./APEX — Mon Système de Vie.html');
      }
    })
  );
});

// ── MESSAGE: reçoit des instructions depuis l'app principale
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
