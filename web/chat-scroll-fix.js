// PROBE-FIX for "can't scroll up the whole conversation on phone" in jean's chat
// transcript (the Claude-backend output is a React message list, NOT a terminal -
// ghostty/xterm are unrelated here). On short mobile viewports the transcript hits
// a hard wall partway up. The leading cause is the classic flex bug: a scroll child
// with flex:1 but no `min-height:0` refuses to shrink, so it overflows a flex
// ancestor whose overflow is clipped and the TOP of the history gets cut off
// (desktop has a tall enough viewport to dodge it). jean is NOT forked - this only
// touches rendered DOM, same pattern as term-keybar.js / push-init.js.
//
// It does two things:
//   1) FIX (touch devices): find the transcript scroll container and apply
//      `min-height:0` up its ancestor chain (lets flex children shrink so the
//      scroller is height-bounded and its overflow actually scrolls), plus
//      overscroll-behavior:contain + -webkit-overflow-scrolling:touch.
//   2) DIAGNOSE: a small dismissible badge prints the scroller's scrollHeight /
//      clientHeight / max scroll so the real cause can be confirmed from the phone
//      without remote debugging. Also exposed as window.__jdScrollDiag().
//
// If the fix frees the scroll -> the wall was a clip and this is the real fix
// (drop the badge later). If it stays walled and the badge shows scrollHeight
// barely above clientHeight -> the history is virtualized/unmounted upstream and
// only jean can fix it.
(function () {
  var COARSE = window.matchMedia && window.matchMedia('(pointer: coarse)').matches
  var BADGE_ID = 'jd-scrollfix-badge'

  // Biggest vertically-scrollable region on the page = the transcript. Skips tiny
  // inner scrollers (code/tool blocks) via the clientHeight floor.
  function findScroller() {
    var best = null, bestScore = -1
    var els = document.body ? document.body.getElementsByTagName('*') : []
    for (var k = 0; k < els.length; k++) {
      var el = els[k]
      if (el.clientHeight < 120) continue
      if (el.scrollHeight - el.clientHeight < 24) continue
      var oy = getComputedStyle(el).overflowY
      if (oy !== 'auto' && oy !== 'scroll') continue
      var score = (el.scrollHeight - el.clientHeight) + el.childElementCount * 50
      if (score > bestScore) { bestScore = score; best = el }
    }
    return best
  }

  function applyFix(el) {
    if (!el) return
    el.style.overscrollBehavior = 'contain'
    el.style.webkitOverflowScrolling = 'touch'
    // min-height:0 up the chain is harmless outside flex and fixes the flex clip
    // inside it. Stop at body; cap depth so a detached node can't loop forever.
    var n = el
    for (var d = 0; n && n !== document.body && d < 40; d++) {
      n.style.minHeight = '0'
      n = n.parentElement
    }
  }

  function info(el) {
    if (!el) return null
    return {
      tag: el.tagName.toLowerCase(),
      cls: String(el.className || '').slice(0, 50),
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      maxScroll: el.scrollHeight - el.clientHeight,
      children: el.childElementCount,
    }
  }
  window.__jdScrollDiag = function () { return info(findScroller()) }

  function badge(d) {
    if (!COARSE) return
    var b = document.getElementById(BADGE_ID)
    if (!b) {
      b = document.createElement('div')
      b.id = BADGE_ID
      b.style.cssText = [
        'position:fixed', 'left:6px', 'bottom:6px', 'z-index:2147483647',
        'max-width:70vw', 'padding:6px 9px', 'border-radius:8px',
        'background:rgba(0,0,0,.82)', 'color:#9ae6b4', 'border:1px solid #2a2a2a',
        'font:600 11px ui-monospace,monospace', 'line-height:1.35',
        'white-space:pre', 'pointer-events:auto',
      ].join(';')
      b.title = 'tap to hide (jean scroll probe)'
      b.addEventListener('click', function () { b.remove() })
      document.body.appendChild(b)
    }
    b.textContent = d
      ? 'scroll-probe\nsh ' + d.scrollHeight + ' ch ' + d.clientHeight +
        '\nmax ' + d.maxScroll + ' kids ' + d.children + '\n<' + d.tag + '> ' + d.cls
      : 'scroll-probe\nno scroll container found'
  }

  var raf = 0
  function run() {
    if (raf) return
    raf = requestAnimationFrame(function () {
      raf = 0
      var el = findScroller()
      if (COARSE) applyFix(el)
      badge(info(el))
    })
  }

  function start() {
    run()
    // The transcript streams in; re-find + re-fix as it grows and on resize
    // (e.g. soft keyboard open/close changing the viewport height).
    new MutationObserver(run).observe(document.documentElement, { childList: true, subtree: true })
    if (window.visualViewport) window.visualViewport.addEventListener('resize', run)
    addEventListener('resize', run)
  }

  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', start)
  else start()
})()
