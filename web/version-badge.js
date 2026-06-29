// @wrapper-status: WRAPPER - intrinsic: re-points jean's badge to THIS repo's
// releases; lives as long as this is a separate packaging repo.
// Re-points jean's top-right version badge to THIS image's release and shows an
// "Update available" pill when SPOTWHALE/jean-dockerized has a newer release.
//
// Loaded only by the headless web UI (injected by web/inject-pwa.mjs). jean is
// not forked - we can't touch its React tree, so we mutate the rendered DOM and
// intercept the badge click. The image version is baked in at build time as
// window.__IMAGE_VERSION__; with no version (local/dev build) this no-ops.
(function () {
  var VERSION = window.__IMAGE_VERSION__
  if (!VERSION) return

  var REPO = 'SPOTWHALE/jean-dockerized'
  var RELEASES = 'https://github.com/' + REPO + '/releases'
  var API = 'https://api.github.com/repos/' + REPO + '/releases/latest'
  var PILL_ID = 'jd-update-pill'

  // Newer release tag once the update check finds one (else null).
  var latest = null

  // Cache the located node so the common case is a cheap isConnected check
  // instead of scanning every <button> on each DOM mutation.
  var badgeEl = null

  // jean's badge: a <button> carrying this Tailwind class whose text is "vX.Y.Z".
  function findBadge() {
    if (badgeEl && badgeEl.isConnected) return badgeEl
    badgeEl = null
    var btns = document.getElementsByTagName('button')
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i]
      if (
        typeof b.className === 'string' &&
        b.className.indexOf('text-foreground/40') !== -1 &&
        /^v\d+\.\d+\.\d+/.test(b.textContent.trim())
      ) {
        badgeEl = b
        return b
      }
    }
    return null
  }

  function openOurs(path) {
    window.open(RELEASES + path, '_blank', 'noopener')
  }

  function makePill() {
    var pill = document.createElement('button')
    pill.id = PILL_ID
    pill.type = 'button'
    // Honest about what the click does: this is not an in-app self-update (the
    // container can't update itself), it opens the release notes to redeploy.
    pill.title =
      'New release ' + latest + '. Opens release notes; update by redeploying the image.'
    // Mirrors jean's own UpdateIndicator styling/slot.
    pill.className =
      'mr-1.5 flex items-center gap-1 rounded-md bg-primary/15 px-1.5 py-0.5 ' +
      'text-[0.625rem] font-medium text-primary hover:bg-primary/25 ' +
      'transition-colors cursor-pointer'
    pill.textContent = latest + ' available'
    pill.addEventListener('click', function (e) {
      e.preventDefault()
      e.stopImmediatePropagation()
      // /releases/latest redirects to the newest published release.
      openOurs('/latest')
    })
    return pill
  }

  // Keep the badge (and pill) in our desired state. Re-runs on every DOM
  // mutation so React re-renders can't quietly revert us.
  function apply() {
    var badge = findBadge()
    if (!badge) return

    if (badge.textContent.trim() !== VERSION) badge.textContent = VERSION

    // Hijack the click. Capture phase on the button fires before the event
    // bubbles to React's root listener, so jean's coollabsio/jean handler never
    // runs. dataset flag survives text edits; if React swaps the node the flag
    // is gone and we rebind on the new one.
    if (!badge.dataset.jdBound) {
      badge.dataset.jdBound = '1'
      badge.addEventListener(
        'click',
        function (e) {
          e.preventDefault()
          e.stopImmediatePropagation()
          openOurs('/tag/' + VERSION)
        },
        true
      )
    }

    if (latest && !document.getElementById(PILL_ID) && badge.parentNode) {
      badge.parentNode.insertBefore(makePill(), badge)
    }
  }

  function check() {
    fetch(API, { headers: { Accept: 'application/vnd.github+json' } })
      .then(function (r) {
        return r.ok ? r.json() : null
      })
      .then(function (d) {
        if (d && d.tag_name && d.tag_name !== VERSION) {
          latest = d.tag_name
          apply()
        }
      })
      .catch(function () {
        // Offline / rate-limited: stay quiet, retry on the next interval.
      })
  }

  // Coalesce mutation bursts (streaming chat tokens, terminal output) into at
  // most one apply() per frame so the observer isn't a hot loop. characterData
  // is intentionally not observed; badge/pill changes are childList-level.
  var scheduled = false
  function schedule() {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(function () {
      scheduled = false
      apply()
    })
  }

  new MutationObserver(schedule).observe(document.body, {
    childList: true,
    subtree: true
  })

  apply()
  check()
  // Long-running PWA sessions: re-check periodically (6h).
  setInterval(check, 6 * 60 * 60 * 1000)
})()
