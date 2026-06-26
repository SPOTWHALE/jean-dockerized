// Minimal service worker. Its only job is to make the app installable on
// Android (Chrome's install criteria require a fetch handler). It deliberately
// does NOT cache anything - every request goes straight to the network - so
// token auth, the WebSocket, and app updates behave exactly as without a SW.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
// Pass-through: no respondWith() => the browser performs its default fetch.
self.addEventListener('fetch', () => {})
