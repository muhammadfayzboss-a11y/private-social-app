const VERSION = 'circle-v2';
const SHELL = [
  '/', '/index.html', '/styles.css', '/app.js', '/api.js', '/ui.js', '/icons.js', '/store.js', '/realtime.js', '/router.js', '/push.js',
  '/views/auth.js', '/views/home.js', '/views/create.js', '/views/chat.js', '/views/activity.js', '/views/profile.js',
  '/components/post.js', '/components/stories.js', '/components/stickerPicker.js', '/components/media.js', '/components/share.js', '/components/reactions.js',
  '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== VERSION).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Private data and media always come from the network so nothing sensitive is cached.
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/index.html')));
    return;
  }

  // Network-first for code and assets: a redeploy must never be masked by a cached copy.
  // The cache is kept up to date and used as the offline fallback.
  event.respondWith(
    fetch(request).then(response => {
      if (response.ok) caches.open(VERSION).then(cache => cache.put(request, response.clone()));
      return response;
    }).catch(() => caches.match(request))
  );
});

self.addEventListener('push', event => {
  let payload = { title: 'Circle', body: 'New activity in your circle', url: '/' };
  try { payload = { ...payload, ...(event.data ? event.data.json() : {}) }; } catch { /* keep defaults */ }
  event.waitUntil(self.registration.showNotification(payload.title, {
    body: payload.body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: payload.url },
    tag: payload.tag || 'circle-activity',
    renotify: true
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data?.url || '/';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
    const existing = clients.find(client => client.url.includes(self.location.origin));
    if (existing) { existing.focus(); return existing.navigate(target); }
    return self.clients.openWindow(target);
  }));
});
