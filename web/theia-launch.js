// Adds a floating "IDE" button to jean's headless web UI that opens the bundled
// Eclipse Theia editor in a new tab. Theia runs headless inside this container on
// 127.0.0.1:<THEIA_PORT> and is reached through the existing preview proxy at
// https://<THEIA_PORT>.<preview-wildcard> - it is never exposed on its own host
// port. jean is not forked; like version-badge.js we only touch the rendered DOM.
//
// The Theia URL comes from /theia-config.js (window.__THEIA_URL__), which
// entrypoint.sh writes at startup from THEIA_PUBLIC_URL. If that is unset we fall
// back to prefixing the current host with the Theia port, which matches a
// <port>.<domain> preview-wildcard deploy. Auth is the preview basic-auth gate,
// so the editor is only reachable once PREVIEW_PASSWORD is set (fails closed).
(function () {
  var BTN_ID = 'jd-ide-btn'

  function theiaUrl() {
    if (window.__THEIA_URL__) return window.__THEIA_URL__
    var port = window.__THEIA_PORT__ || '8443'
    // <port>.<current-host>, e.g. jean at code.example.com -> 8443.code.example.com.
    // Deploys whose preview wildcard is *.apps.<domain> should set THEIA_PUBLIC_URL.
    return location.protocol + '//' + port + '.' + location.hostname + '/'
  }

  function makeButton() {
    var btn = document.createElement('button')
    btn.id = BTN_ID
    btn.type = 'button'
    btn.title = 'Open the Theia IDE (requires PREVIEW_PASSWORD to be set)'
    btn.textContent = '</> IDE'
    btn.style.cssText = [
      'position:fixed',
      'right:16px',
      'bottom:16px',
      'z-index:2147483647',
      'padding:8px 12px',
      'border:0',
      'border-radius:9999px',
      'background:#2563eb',
      'color:#fff',
      'font:600 13px/1 system-ui,sans-serif',
      'box-shadow:0 2px 8px rgba(0,0,0,.35)',
      'cursor:pointer'
    ].join(';')
    btn.addEventListener('mouseenter', function () {
      btn.style.background = '#1d4ed8'
    })
    btn.addEventListener('mouseleave', function () {
      btn.style.background = '#2563eb'
    })
    btn.addEventListener('click', function () {
      window.open(theiaUrl(), '_blank', 'noopener')
    })
    return btn
  }

  function mount() {
    if (document.getElementById(BTN_ID)) return
    if (!document.body) return
    document.body.appendChild(makeButton())
  }

  if (document.readyState === 'loading') {
    addEventListener('DOMContentLoaded', mount)
  } else {
    mount()
  }
  // jean re-renders its React tree; if the button ever gets detached, re-add it.
  new MutationObserver(function () {
    if (!document.getElementById(BTN_ID)) mount()
  }).observe(document.documentElement, { childList: true, subtree: true })
})()
