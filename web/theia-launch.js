// @wrapper-status: STOPGAP - our bundled Theia IDE button; remove if jean ships
// a built-in browser IDE. See AGENTS.md "Injected patch layer".
// Adds a "</> IDE" button to jean's top-right session toolbar. It opens a per-worktree
// scoped Eclipse Theia editor (one Theia rooted at the active repo/branch worktree),
// served by web/theia-dispatcher.mjs through the preview proxy:
//
//   known worktree -> <slug>.<suffix>/?ws=<path>   (dispatcher roots Theia at <path>)
//   unknown        -> ide.<suffix>                 (dispatcher's worktree picker)
//
// COSMETIC scoping only - NOT a security boundary (the Theia terminal still reaches all
// of /workspace). jean is NOT forked; like version-badge.js we only touch rendered DOM
// and listen to jean's own CustomEvents - we never reach into its React state.
//
// The host suffix comes from /theia-config.js (window.__THEIA_HOST_SUFFIX__), written by
// entrypoint.sh as subdomains of JEAN_PUBLIC_URL's host (the preview wildcard, e.g.
// .jean.example.com). Auth is the preview basic-auth gate (fails closed without PREVIEW_PASSWORD).
(function () {
  var BTN_ID = 'jd-ide-btn'
  // Latest worktree directory jean told us about, via its CustomEvents. Null until the
  // user opens/switches a worktree; the button falls back to the picker meanwhile.
  var currentWorktreePath = null

  function slugify(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  }
  function suffix() {
    var s = window.__THEIA_HOST_SUFFIX__ || ('.' + location.host)
    return s.charAt(0) === '.' ? s : '.' + s
  }
  // Tailscale path: no wildcard subdomain to route by, so when reached over a bare IP
  // (and the dispatcher port was published via /theia-config.js) target the dispatcher's
  // /__open directly - it redirects to the worktree's own Theia port. __THEIA_DISPATCH_PORT__
  // is set by entrypoint.sh only when TS_AUTHKEY is on, so domain deploys never take this path.
  var DISPATCH_PORT = window.__THEIA_DISPATCH_PORT__
  function isDirectHost() {
    // Bare tailnet IP, or a Tailscale MagicDNS name (…​.ts.net) - neither can host a
    // wildcard subdomain, so route through the dispatcher's direct-port /__open.
    return !!DISPATCH_PORT && (/^\d{1,3}(\.\d{1,3}){3}$/.test(location.hostname) || /\.ts\.net$/i.test(location.hostname))
  }
  function directBase() {
    return location.protocol + '//' + location.hostname + ':' + DISPATCH_PORT
  }
  // jean sets document.title to "<repo> › <worktree> (<branch>)" for the active
  // worktree (just "Jean" when nothing is open) - a reliable on-load signal that needs
  // no React/DOM coupling. Parse repo+branch from it.
  function fromTitle() {
    var t = document.title || ''
    var i = t.indexOf('›') // ›
    if (i < 0) return null
    var repo = t.slice(0, i).trim()
    var rest = t.slice(i + 1).trim()
    var m = rest.match(/\(([^)]+)\)\s*$/) // branch in parens when it differs from name
    var branch = (m ? m[1] : rest).trim()
    return repo && branch ? { repo: repo, branch: branch } : null
  }
  function targetUrl() {
    // Tailscale/direct-IP access: route through the dispatcher's /__open redirect.
    if (isDirectHost()) {
      if (currentWorktreePath) return directBase() + '/__open?ws=' + encodeURIComponent(currentWorktreePath)
      var td = fromTitle()
      if (td) return directBase() + '/__open?repo=' + encodeURIComponent(td.repo) + '&branch=' + encodeURIComponent(td.branch)
      return directBase() + '/' // picker
    }
    // Most precise: an exact worktree path captured from a jean switch event.
    if (currentWorktreePath) {
      var leaf = currentWorktreePath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'workspace'
      return location.protocol + '//' + slugify(leaf) + suffix() +
        '/?ws=' + encodeURIComponent(currentWorktreePath)
    }
    // On load: derive repo+branch from the title; the dispatcher resolves the worktree.
    var t = fromTitle()
    if (t) {
      return location.protocol + '//' + slugify(t.repo + '-' + t.branch) + suffix() +
        '/?repo=' + encodeURIComponent(t.repo) + '&branch=' + encodeURIComponent(t.branch)
    }
    // Nothing open -> the picker.
    return location.protocol + '//ide' + suffix() + '/'
  }

  // jean broadcasts worktree/session activity as window CustomEvents whose detail often
  // carries the worktree path (e.g. open-worktree-modal -> {worktreeId, worktreePath}).
  // Track the most recent one so the button opens "the current worktree".
  ;['open-worktree-modal', 'switch-session', 'session-opened', 'open-worktree-by-index',
    'create-new-session', 'create-new-worktree', 'switch-worktree'].forEach(function (name) {
    window.addEventListener(name, function (e) {
      var d = (e && e.detail) || {}
      var p = d.worktreePath || d.path || (d.worktree && d.worktree.path)
      if (p && typeof p === 'string') currentWorktreePath = p
    })
  })

  function makeButton(template) {
    var btn = template.cloneNode(true)
    btn.id = BTN_ID
    btn.setAttribute('type', 'button')
    btn.setAttribute('aria-label', 'Open the Theia IDE')
    btn.setAttribute('title', 'Open the Theia IDE for the current worktree (needs PREVIEW_PASSWORD)')
    btn.removeAttribute('data-state')
    btn.removeAttribute('data-slot')
    while (btn.firstChild) btn.removeChild(btn.firstChild)
    var glyph = document.createElement('span')
    glyph.textContent = '</>'
    glyph.style.fontWeight = '700'
    btn.appendChild(glyph)
    btn.appendChild(document.createTextNode(' IDE'))
    btn.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation()
      window.open(targetUrl(), '_blank', 'noopener')
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
})()
