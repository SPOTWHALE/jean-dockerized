// @wrapper-status: STOPGAP - PWA installability; remove if jean ships its own
// manifest + service worker for headless web.
// Minimal service worker. Its only job is to make the app installable on
// Android (Chrome's install criteria require a fetch handler). It deliberately
// does NOT cache anything - every request goes straight to the network - so
// token auth, the WebSocket, and app updates behave exactly as without a SW.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
// Pass-through: no respondWith() => the browser performs its default fetch.
self.addEventListener('fetch', () => {})

// Web Push: web/push-relay.mjs sends a JSON payload {title, body, tag, url} when
// an agent finishes, errors, or needs approval. userVisibleOnly subscriptions
// must show a notification for every push, so we always do. `tag` (the session
// id) makes repeat events for one chat replace the previous card.
self.addEventListener('push', (e) => {
  let d = {}
  try {
    d = e.data ? e.data.json() : {}
  } catch (_) {
    d = { body: e.data && e.data.text() }
  }
  e.waitUntil(
    self.registration.showNotification(d.title || 'Jean', {
      body: d.body || '',
      tag: d.tag,
      data: { url: d.url || '/' },
      icon: '/icon-192.png',
      badge: '/icon-192.png',
    })
  )
})

// Tapping a notification focuses an open jean tab if there is one, else opens it.
self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const url = (e.notification.data && e.notification.data.url) || '/'
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
      for (const c of cs) {
        if ('focus' in c) return c.focus()
      }
      if (clients.openWindow) return clients.openWindow(url)
    })
  )
})
