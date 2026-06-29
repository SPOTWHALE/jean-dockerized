// @wrapper-status: STOPGAP - remove when jean ships web push + hides its
// desktop-only settings in web builds. See AGENTS.md "Injected patch layer".
// Adds an "Agent notifications" toggle to jean's Settings > General >
// Notifications (next to the sound toggles) that subscribes this browser to Web
// Push, so the agent can notify you (finished / errored / needs approval) even
// when the tab is closed. Talks to web/push-relay.mjs through the preview proxy
// at jdpush.<preview-wildcard>. jean is NOT forked - this clones jean's own
// settings row for an exact style match and only touches rendered DOM + the
// browser's Push API, same pattern as theia-launch.js.
//
// Enabled only when entrypoint.sh wrote window.__PUSH_ENABLED__ (JEAN_PUBLIC_URL
// set). The relay host reuses window.__THEIA_HOST_SUFFIX__ (the preview wildcard).
// Degrades silently if anything is missing or the browser lacks Push (e.g. iOS
// before adding to home screen).
(function () {
  var ROW_ID = 'jd-push-row'
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

  async function unsubscribe() {
    var reg = await navigator.serviceWorker.ready
    var sub = await reg.pushManager.getSubscription()
    if (!sub) return
    try {
      await fetch(relayBase() + '/unsubscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: token(), endpoint: sub.endpoint }),
      })
    } catch (e) { /* relay unreachable; still drop the local sub below */ }
    await sub.unsubscribe()
  }

  // Reflect on/off on whatever control jean's row uses (Radix button[role=switch]
  // or a checkbox), covering data-state / aria-checked / checked.
  function reflect(sw, on) {
    if (!sw) return
    if (sw.tagName === 'INPUT') sw.checked = on
    sw.setAttribute('aria-checked', on ? 'true' : 'false')
    sw.setAttribute('data-state', on ? 'checked' : 'unchecked')
    var thumb = sw.querySelector('[data-state]')
    if (thumb) thumb.setAttribute('data-state', on ? 'checked' : 'unchecked')
  }

  // Current visual state of the toggle - the source of truth for which way to
  // flip. (Notification.permission can't be it: turning off doesn't revoke the
  // permission, so it stays 'granted' and the toggle would never turn back on.)
  function isOn(sw) {
    return sw.getAttribute('aria-checked') === 'true' ||
      sw.getAttribute('data-state') === 'checked' ||
      (sw.tagName === 'INPUT' && sw.checked)
  }

  async function onToggle(sw) {
    if (!isOn(sw)) {
      if (Notification.permission === 'denied') {
        alert('Notifications are blocked for this site. Enable them in your browser/OS settings, then retry.')
        return
      }
      if (Notification.permission !== 'granted') {
        var p = await Notification.requestPermission()
        if (p !== 'granted') { reflect(sw, false); return }
      }
      try { await subscribe() } catch (e) { /* relay unreachable; user can retry */ }
      reflect(sw, true)
    } else {
      try { await unsubscribe() } catch (e) { /* ignore */ }
      reflect(sw, false)
    }
  }

  // Labels of the OTHER rows in the Notifications section - used as fences so the
  // cell search never grows to swallow a neighbouring row (which caused the whole
  // section to be cloned/duplicated).
  // Row TITLES only (not descriptions - those live inside a row and would fence it
  // against itself). Used so the cell search stops before a neighbouring row.
  var FENCES = [
    'Desktop notifications', 'Web access sounds', 'Waiting sound', 'Review sound',
    'Auto-generate', 'Agent notifications',
  ]

  function leafWithText(scope, text) {
    var els = scope.querySelectorAll('*')
    for (var i = 0; i < els.length; i++) {
      var el = els[i]
      if (el.children.length === 0 && (el.textContent || '').trim() === text) return el
    }
    return null
  }

  // Largest ancestor of the label that still belongs to ONLY this row - i.e. it
  // doesn't yet contain any other row's label. That's this row's cell (the grid's
  // label cell, or the whole row if jean groups label+switch together).
  function cellFor(scope, label) {
    var leaf = leafWithText(scope, label)
    if (!leaf) return null
    var cell = leaf, n = leaf.parentElement
    while (n && n !== scope) {
      var txt = n.textContent || ''
      var fenced = false
      for (var i = 0; i < FENCES.length; i++) {
        if (FENCES[i] !== label && txt.indexOf(FENCES[i]) !== -1) { fenced = true; break }
      }
      if (fenced) break
      cell = n; n = n.parentElement
    }
    return cell
  }

  // Replace the first descendant text node exactly matching `from` with `to`.
  function relabel(root, from, to) {
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null)
    var t
    while ((t = w.nextNode())) {
      if (t.nodeValue && t.nodeValue.trim() === from) { t.nodeValue = to; return }
    }
  }

  // Replace the first descendant text node that CONTAINS `substr` (for longer
  // descriptions where exact-match is brittle).
  function relabelContains(root, substr, to) {
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null)
    var t
    while ((t = w.nextNode())) {
      if (t.nodeValue && t.nodeValue.indexOf(substr) !== -1) { t.nodeValue = to; return }
    }
  }

  function stripIds(root) {
    var ided = root.querySelectorAll('[id]')
    for (var i = 0; i < ided.length; i++) ided[i].removeAttribute('id')
    var labels = root.querySelectorAll('label[for]')
    for (var j = 0; j < labels.length; j++) labels[j].removeAttribute('for')
  }

  function dressLabel(labelClone) {
    relabel(labelClone, 'Desktop notifications', 'Agent notifications')
    relabelContains(
      labelClone,
      'native system banner',
      'Push a notification to this device when the agent finishes, errors, or needs you - even with the tab closed. Requires allowing notifications.'
    )
    stripIds(labelClone)
  }

  function bindSwitch(root) {
    var sw = root.querySelector('[role="switch"],input[type="checkbox"]')
    if (!sw) return
    // Seed from the ACTUAL subscription (not the permission): on only if a push
    // subscription exists and notifications are still granted.
    reflect(sw, false)
    navigator.serviceWorker.ready
      .then(function (reg) { return reg.pushManager.getSubscription() })
      .then(function (s) { reflect(sw, !!s && Notification.permission === 'granted') })
      .catch(function () {})
    sw.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation(); onToggle(sw)
    }, true)
  }

  // Inject our "Agent notifications" row by cloning jean's "Desktop notifications"
  // row (a clean toggle). Clears any inherited display:none (the original may be
  // hidden by hideRow on a prior pass).
  function injectAgentRow(dlg) {
    var cell = cellFor(dlg, 'Desktop notifications')
    if (!cell) return
    if (cell.querySelector('[role="switch"],input[type="checkbox"]')) {
      var row = cell.cloneNode(true)
      row.id = ROW_ID
      row.style.display = ''
      dressLabel(row)
      bindSwitch(row)
      cell.parentNode.insertBefore(row, cell.nextSibling)
    } else {
      var control = cell.nextElementSibling
      if (!control || !control.querySelector('[role="switch"],input[type="checkbox"]')) return
      var labelClone = cell.cloneNode(true)
      var controlClone = control.cloneNode(true)
      labelClone.id = ROW_ID
      labelClone.style.display = ''
      controlClone.style.display = ''
      dressLabel(labelClone)
      stripIds(controlClone)
      bindSwitch(controlClone)
      // Insert the pair (label then control) after the original control cell so
      // grid auto-flow keeps them aligned as one new row.
      control.parentNode.insertBefore(controlClone, control.nextSibling)
      control.parentNode.insertBefore(labelClone, controlClone)
    }
  }

  // Hide a native row that's irrelevant in headless web (Desktop notifications is
  // Tauri-only; Web access sounds is being retired in favour of push). Idempotent
  // and re-applied each pass so it survives jean re-rendering the pane.
  function hideRow(dlg, label) {
    var cell = cellFor(dlg, label)
    if (!cell) return
    cell.style.display = 'none'
    if (!cell.querySelector('[role="switch"],input[type="checkbox"]')) {
      var ctrl = cell.nextElementSibling
      if (ctrl) ctrl.style.display = 'none'
    }
  }

  // Hide a sidebar nav item (a clickable whose whole text is exactly `text`).
  // jean's "Web Access" settings tab is irrelevant in headless web.
  function hideNav(scope, text) {
    var items = scope.querySelectorAll('button,a,li,[role="tab"],[role="menuitem"]')
    for (var i = 0; i < items.length; i++) {
      if ((items[i].textContent || '').trim() === text) items[i].style.display = 'none'
    }
  }

  function mount() {
    // Settings render either as a modal ([role=dialog], older jean) or a full-page
    // route with a left nav (newer jean). Scope to the dialog when present, else the
    // whole document so the full-page settings route is covered too. cellFor's FENCE
    // walk still bounds each cloned row, so a document-wide scope stays safe.
    var dlg = document.querySelector('[role="dialog"]') || document.body
    hideNav(dlg, 'Web Access')
    if (!document.getElementById(ROW_ID)) injectAgentRow(dlg)
    // Re-hide the web-irrelevant native rows every pass (survives re-render).
    // Desktop notifications: Tauri-only. Web access sounds + its Waiting/Review
    // sound selectors: retired in favour of push.
    hideRow(dlg, 'Desktop notifications')
    hideRow(dlg, 'Web access sounds')
    hideRow(dlg, 'Waiting sound')
    hideRow(dlg, 'Review sound')
  }

  var raf = 0
  function schedule() {
    if (raf) return
    raf = requestAnimationFrame(function () { raf = 0; mount() })
  }
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', schedule)
  else schedule()
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true })

  // Already granted on a prior visit -> silently refresh the subscription so a
  // restarted relay (new VAPID keys would invalidate, but same keys persist) and
  // rotated browser endpoints stay registered.
  if (Notification.permission === 'granted') {
    navigator.serviceWorker.ready.then(function () {
      subscribe().catch(function () {})
    })
  }
})()
