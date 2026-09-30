const VERSION = 'circle-v4';
const SHELL = [
  '/', '/index.html', '/styles.css', '/mobile.css', '/boot-theme.js', '/app.js', '/api.js', '/ui.js', '/icons.js', '/store.js', '/realtime.js', '/router.js', '/push.js',
  '/views/auth.js', '/views/chats.js', '/views/conversation.js', '/views/chatInfo.js', '/views/search.js', '/views/feed.js', '/views/create.js',
  '/views/activity.js', '/views/profile.js', '/views/settings.js',
  '/components/post.js', '/components/stories.js', '/components/media.js', '/components/share.js', '/components/reactions.js',
  '/components/messages.js', '/components/messageMenu.js', '/components/messageFocus.js', '/components/voice.js', '/components/voiceComposer.js',
  '/components/chatRow.js', '/components/emojiPanel.js', '/components/attach.js', '/components/sharedMedia.js',
  '/lib/time.js', '/lib/audio.js', '/lib/recorder.js', '/lib/gestures.js', '/lib/theme.js', '/lib/settings.js', '/lib/i18n.js', '/lib/locales/uz.js',
  '/lib/nav.js', '/lib/overlays.js', '/lib/pull.js', '/lib/sounds.js', '/lib/wallpapers.js',
  '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key !== VERSION).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Private data and every authenticated media response stay out of Service Worker CacheStorage.
  // The browser may use their Cache-Control: private response cache, which is scoped to this profile.
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/index.html')));
    return;
  }

  // Network-first for code and assets: a redeploy must never be masked by a cached copy.
  // The cache is kept up to date and used as the offline fallback.
  event.respondWith(
    fetch(request).then(response => {
      if (response.ok) { const copy = response.clone(); caches.open(VERSION).then(cache => cache.put(request, copy)); }
      return response;
    }).catch(() => caches.match(request))
  );
});

self.addEventListener('push', event => {
  let payload = { title: 'Circle', body: 'New activity in your circle', url: '/' };
  try { payload = { ...payload, ...(event.data ? event.data.json() : {}) }; } catch { /* keep defaults */ }
  event.waitUntil(self.registration.showNotification(payload.title, {
    timestamp: Date.now(),
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
    const existing = clients.find(client => client.url.startsWith(self.location.origin));
    // Route inside the running app instead of reloading it, so state and scroll position survive.
    if (existing) { existing.postMessage({ type: 'navigate', url: target }); return existing.focus(); }
    return self.clients.openWindow(target);
  }));
});
