/* eslint-env serviceworker */
'use strict';

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', event => {
  let payload = {
    title: 'Homey Party Quiz',
    body: 'Er is een update in de quiz!',
    icon: '/assets/icon.svg',
    badge: '/assets/icon.svg',
    tag: 'homey-quiz-push',
    data: { url: '/play' }
  };

  if (event.data) {
    try {
      const parsed = event.data.json();
      payload = { ...payload, ...parsed };
    } catch (err) {
      payload.body = event.data.text();
    }
  }

  const options = {
    body: payload.body,
    icon: payload.icon || '/assets/icon.svg',
    badge: payload.badge || '/assets/icon.svg',
    tag: payload.tag || 'homey-quiz-push',
    renotify: true,
    vibrate: [120, 60, 120],
    data: payload.data || { url: '/play' }
  };

  event.waitUntil(self.registration.showNotification(payload.title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/play';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes('/play') && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
