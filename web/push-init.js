// Adds a "🔔" button to jean's top-right toolbar that subscribes this browser to
// Web Push, so the agent can notify you (finished / errored / needs approval)
// even when the tab is closed. Talks to web/push-relay.mjs through the preview
// proxy at jdpush.<preview-wildcard>. jean is NOT forked - this only touches the
// rendered DOM and the browser's own Push API, same pattern as theia-launch.js.
//
// Enabled only when entrypoint.sh wrote window.__PUSH_ENABLED__ (JEAN_TOKEN +
// THEIA_HOST_SUFFIX both set). The relay host reuses window.__THEIA_HOST_SUFFIX__
// (the preview wildcard). Degrades silently if anything is missing or the browser
// lacks Push (e.g. iOS before adding to home screen).
(function () {
  var BTN_ID = 'jd-push-btn'
  if (!window.__PUSH_ENABLED__) return
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return

  function suffix() {
    var s = window.__THEIA_HOST_SUFFIX__ || ('.' + location.host)
    return s.charAt(0) === '.' ? s : '.' + s
  }
  function relayBase() {
    return location.protocol + '//jdpush' + suffix()
  }
  function token() {
    try {
      return localStorage.getItem('jean-http-token') || ''
    } catch (e) {
      return ''
    }
  }
  // VAPID key is URL-safe base64; pushManager.subscribe wants a Uint8Array.
  function urlB64ToUint8(s) {
    var pad = '='.repeat((4 - (s.length % 4)) % 4)
    var b = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'))
    var out = new Uint8Array(b.length)
    for (var i = 0; i < b.length; i++) out[i] = b.charCodeAt(i)
    return out
  }

  async function subscribe() {
    var tok = token()
    if (!tok) return false
    var reg = await navigator.serviceWorker.ready
    var existing = await reg.pushManager.getSubscription()
    var sub = existing
    if (!sub) {
      var keyRes = await fetch(relayBase() + '/key')
      if (!keyRes.ok) return false
      var key = (await keyRes.json()).key
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8(key),
      })
    }
    var res = await fetch(relayBase() + '/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: tok, subscription: sub }),
    })
    return res.ok
  }

  function paint(btn) {
    var on = Notification.permission === 'granted'
    btn.firstChild.textContent = on ? '🔔' : '🔕'
    btn.setAttribute('title', on ? 'Notifications on (tap to refresh)' : 'Enable agent notifications')
  }

  async function onClick(btn) {
    if (Notification.permission === 'denied') {
      alert('Notifications are blocked for this site. Enable them in your browser settings, then retry.')
      return
    }
    if (Notification.permission !== 'granted') {
      var p = await Notification.requestPermission()
      if (p !== 'granted') {
        paint(btn)
        return
      }
    }
    try {
      await subscribe()
    } catch (e) {
      /* relay unreachable -> leave the bell; user can retry */
    }
    paint(btn)
  }

  function makeButton(template) {
    var btn = template.cloneNode(true)
    btn.id = BTN_ID
    btn.setAttribute('type', 'button')
    btn.removeAttribute('data-state')
    btn.removeAttribute('data-slot')
    while (btn.firstChild) btn.removeChild(btn.firstChild)
    btn.appendChild(document.createElement('span'))
    paint(btn)
    btn.addEventListener('click', function (e) {
      e.preventDefault()
      e.stopPropagation()
      onClick(btn)
    }, true)
    return btn
  }

  function mount() {
    if (document.getElementById(BTN_ID)) return
    var term = document.querySelector('button[aria-label="Toggle terminal"]')
    if (!term) return
    var wrapper = term.parentElement
    var cluster = wrapper && wrapper.parentElement
    if (!cluster) return
    cluster.insertBefore(makeButton(term), cluster.firstChild)
  }

  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', mount)
  else mount()
  new MutationObserver(function () {
    if (!document.getElementById(BTN_ID)) mount()
  }).observe(document.documentElement, { childList: true, subtree: true })

  // Already granted on a prior visit -> silently refresh the subscription so a
  // restarted relay (new VAPID keys would invalidate, but same keys persist) and
  // rotated browser endpoints stay registered.
  if (Notification.permission === 'granted') {
    navigator.serviceWorker.ready.then(function () {
      subscribe().catch(function () {})
    })
  }
})()
