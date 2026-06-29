// @wrapper-status: STOPGAP - remove when jean ships a mobile terminal key-bar +
// touch-scroll for its TUI. See AGENTS.md "Injected patch layer".
// Mobile accessory key-bar for jean's built-in terminal. Phone soft keyboards
// lack Esc / Tab / Ctrl / arrows, but jean's Claude backend runs an interactive
// TUI in jean's own terminal panel that needs them. A PWA can't swap the OS
// keyboard, so we render our own keys and feed synthetic KeyboardEvents straight
// to xterm.js's hidden helper textarea (the element xterm itself listens on).
// jean is NOT forked - this only touches rendered DOM, like push-init.js.
//
// UX: the key panel is hidden by default so it never covers the terminal's input
// line; a small floating "keyboard" button (FAB) toggles it open/closed. Keys
// fire on tap-RELEASE (pointerup), not press, and a drag of more than a few px
// cancels - so a mis-touch or a scroll gesture doesn't fire a command.
//
// The FAB/keys are INDEPENDENT of the OS keyboard: the FAB shows whenever a
// terminal exists (not only when the textarea is focused), and keys are
// dispatched to xterm's textarea via dispatchEvent, which xterm processes
// without the element being focused. So opening the bar does NOT pop the phone
// keyboard, and the terminal stays full-height for scrolling. All taps
// preventDefault so they never focus the textarea (which would open the OS
// keyboard); tap the terminal itself to type with the system keyboard.
(function () {
  // Only touch devices need this; a desktop has the real keys. Gate on a coarse
  // pointer so the bar never appears on a mouse + keyboard machine.
  if (!window.matchMedia || !window.matchMedia('(pointer: coarse)').matches) return

  var BAR_ID = 'jd-keybar'
  var bar = null // the key panel (hidden until toggled open)
  var fab = null // the floating toggle button
  var panelOpen = false
  var sticky = { ctrl: false, alt: false } // one-shot modifiers, cleared after use

  // xterm's hidden input - the element its key handler listens on. Resolved live
  // (not cached on focus) so keys work without focusing it (no OS keyboard).
  function termTextarea() {
    return document.querySelector('.xterm-helper-textarea') ||
      document.querySelector('.xterm textarea')
  }

  // Dismiss the OS keyboard: if the xterm textarea (or anything in it) holds
  // focus, blur it. Keys still reach xterm via dispatchEvent (no focus needed),
  // so the keybar works with the keyboard down - which is the whole point.
  function dismissKeyboard() {
    var ae = document.activeElement
    if (ae && typeof ae.blur === 'function' &&
        (ae === termTextarea() || (ae.closest && ae.closest('.xterm')))) {
      ae.blur()
    }
  }

  // Each entry is one of: a key to send (key/code/kc, via synthetic keydown), a
  // sticky modifier toggle (`mod`), or a printable string (`text`). Control keys
  // (Esc/Tab/Enter/arrows/Ctrl-combos) go through keydown; xterm acts on those.
  // Printable chars (like `?`) are NOT delivered by a synthetic keydown - xterm
  // reads typed text from the textarea's `input` event - so `text` entries are
  // injected that way instead. keyCode/which are forced because a constructed
  // KeyboardEvent always reports 0, which older xterm needs for Ctrl+letter.
  var KEYS = [
    { id: 'esc', label: 'Esc', key: 'Escape', code: 'Escape', kc: 27 },
    { id: 'tab', label: 'Tab', key: 'Tab', code: 'Tab', kc: 9 },
    { id: 'enter', label: '⏎', key: 'Enter', code: 'Enter', kc: 13 },
    { id: 'ctrl', label: 'Ctrl', mod: 'ctrl' },
    { id: 'alt', label: 'Alt', mod: 'alt' },
    { id: 'left', label: '←', key: 'ArrowLeft', code: 'ArrowLeft', kc: 37 },
    { id: 'up', label: '↑', key: 'ArrowUp', code: 'ArrowUp', kc: 38 },
    { id: 'down', label: '↓', key: 'ArrowDown', code: 'ArrowDown', kc: 40 },
    { id: 'right', label: '→', key: 'ArrowRight', code: 'ArrowRight', kc: 39 },
    { id: 'qmark', label: '?', text: '?' },
    { id: 'slash', label: '/', text: '/' },
    // Common control combos, one tap away (xterm emits the control byte from a
    // synthetic Ctrl+<letter> keydown): SIGINT, EOF, reverse-search, suspend.
    { id: 'c-c', label: '^C', key: 'c', code: 'KeyC', kc: 67, ctrl: true },
    { id: 'c-d', label: '^D', key: 'd', code: 'KeyD', kc: 68, ctrl: true },
    { id: 'c-r', label: '^R', key: 'r', code: 'KeyR', kc: 82, ctrl: true },
    { id: 'c-z', label: '^Z', key: 'z', code: 'KeyZ', kc: 90, ctrl: true },
  ]

  function send(spec) {
    var ta = termTextarea()
    if (!ta) return
    var ev = new KeyboardEvent('keydown', {
      key: spec.key,
      code: spec.code,
      bubbles: true,
      cancelable: true,
      ctrlKey: !!spec.ctrl || sticky.ctrl,
      altKey: !!spec.alt || sticky.alt,
    })
    // Constructed KeyboardEvents always report keyCode/which 0; older xterm
    // reads them (and needs them for Ctrl+letter), so force the real code.
    try {
      Object.defineProperty(ev, 'keyCode', { get: function () { return spec.kc } })
      Object.defineProperty(ev, 'which', { get: function () { return spec.kc } })
    } catch (e) { /* non-configurable in some engines; key/code still carries it */ }
    ta.dispatchEvent(ev)
    // xterm may re-focus its textarea on input; blur it back so the OS keyboard
    // doesn't pop up from using the bar.
    dismissKeyboard()
    if (sticky.ctrl || sticky.alt) {
      sticky.ctrl = sticky.alt = false
      paintMods()
    }
  }

  function paintMods() {
    KEYS.forEach(function (k) {
      if (!k.mod) return
      var b = document.getElementById(BAR_ID + '-' + k.id)
      if (b) b.style.background = sticky[k.mod] ? '#2563eb' : '#1f2937'
    })
  }

  // Inject a printable char the way xterm expects typed text: set the textarea
  // value and fire an `input` event, which xterm reads and forwards to the PTY.
  // (A synthetic keydown does NOT produce the character.)
  function sendText(ch) {
    var ta = termTextarea()
    if (!ta) return
    var prev = ta.value
    try {
      ta.value = ch
      ta.dispatchEvent(new InputEvent('input', { data: ch, inputType: 'insertText', bubbles: true }))
    } catch (e) { /* InputEvent unsupported -> give up quietly */ }
    ta.value = prev || ''
    dismissKeyboard()
  }

  // Commit a key on a clean tap-release. Modifier -> toggle sticky; printable
  // `text` -> inject as typed text; everything else -> synthetic keydown.
  function commit(spec) {
    if (spec.mod) {
      sticky[spec.mod] = !sticky[spec.mod]
      paintMods()
      return
    }
    if (spec.text != null) { sendText(spec.text); return }
    send(spec)
  }

  // Resting background for a button (mod buttons show their sticky state).
  function restingBg(k) {
    return k.mod && sticky[k.mod] ? '#2563eb' : '#1f2937'
  }

  // Tap-to-commit binding: arm on pointerdown, cancel if the finger slides > ~10px
  // or the browser takes the gesture over for horizontal panning (pointercancel),
  // commit only on a clean pointerup. Does NOT preventDefault, so the panel's
  // native horizontal scroll works and the tap doesn't keep the keyboard up.
  function bindKey(b, k) {
    var armed = false, sx = 0, sy = 0
    function disarm() { armed = false; b.style.background = restingBg(k) }
    b.addEventListener('pointerdown', function (e) {
      armed = true; sx = e.clientX; sy = e.clientY
      b.style.background = '#3b4658'
    })
    b.addEventListener('pointermove', function (e) {
      if (armed && (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10)) disarm()
    })
    b.addEventListener('pointerup', function () {
      if (!armed) return
      disarm()
      commit(k)
    })
    b.addEventListener('pointercancel', disarm)
    b.addEventListener('pointerleave', function () { if (armed) disarm() })
  }

  function build() {
    // Push-up style: when <html> carries .jd-keybar-open, shrink jean's full-height
    // (100dvh) containers by the bar's height (--jd-kb) so the bar adds to the
    // layout and pushes the terminal up instead of overlaying it. Targets jean's
    // dvh utility classes plus #root/body. Inert until the class is set.
    var st = document.createElement('style')
    st.textContent =
      'html.jd-keybar-open body,html.jd-keybar-open #root,' +
      'html.jd-keybar-open .h-dvh,html.jd-keybar-open .\\!h-dvh,' +
      'html.jd-keybar-open .h-\\[100dvh\\],html.jd-keybar-open .\\!h-\\[100dvh\\]{' +
      'height:calc(100dvh - var(--jd-kb,0px))!important;' +
      'min-height:calc(100dvh - var(--jd-kb,0px))!important}'
    document.head.appendChild(st)

    // The key panel - a horizontally scrollable row, hidden until toggled.
    bar = document.createElement('div')
    bar.id = BAR_ID
    bar.style.cssText = [
      'position:fixed', 'left:0', 'right:0', 'bottom:0', 'z-index:2147483647',
      'display:none', 'gap:8px', 'padding:8px 12px', 'box-sizing:border-box',
      'overflow-x:auto', 'white-space:nowrap', '-webkit-overflow-scrolling:touch',
      'background:#0b0b0c', 'border-top:1px solid #2a2a2a',
      'font:600 15px system-ui,-apple-system,sans-serif', 'user-select:none',
      'touch-action:pan-x',
    ].join(';')

    KEYS.forEach(function (k) {
      var b = document.createElement('button')
      b.type = 'button'
      b.id = BAR_ID + '-' + k.id
      b.textContent = k.label
      b.style.cssText = [
        'flex:0 0 auto', 'min-width:46px', 'height:46px', 'padding:0 14px',
        'border:0', 'border-radius:8px', 'color:#e5e7eb', 'background:#1f2937',
        'font:inherit', 'cursor:pointer', 'touch-action:pan-x',
      ].join(';')
      bindKey(b, k)
      bar.appendChild(b)
    })
    document.body.appendChild(bar)

    // Floating toggle. Closed by default so the panel never sits over the input;
    // tap to reveal the keys, tap again (now an "x") to hide them.
    fab = document.createElement('button')
    fab.type = 'button'
    fab.id = BAR_ID + '-fab'
    fab.style.cssText = [
      'position:fixed', 'right:12px', 'bottom:12px', 'z-index:2147483647',
      'display:none', 'width:48px', 'height:48px', 'border:0', 'border-radius:50%',
      'color:#fff', 'background:#2563eb', 'box-shadow:0 2px 10px rgba(0,0,0,.5)',
      'font:600 20px system-ui,-apple-system,sans-serif', 'cursor:pointer',
      'touch-action:manipulation',
    ].join(';')
    setFabIcon()
    fab.addEventListener('pointerup', function (e) { e.stopPropagation(); togglePanel() })
    document.body.appendChild(fab)

    // Track terminal presence (appears/disappears as panes open/close).
    scheduleRefresh()
    new MutationObserver(scheduleRefresh).observe(document.documentElement, { childList: true, subtree: true })
  }

  function setFabIcon() {
    if (fab) fab.textContent = panelOpen ? '✕' : '⌨' // ✕ / ⌨
  }

  // Let xterm's FitAddon re-fit to the new height after we shrink/restore the
  // layout (it listens for window resize).
  function fireResize() {
    setTimeout(function () { window.dispatchEvent(new Event('resize')) }, 60)
  }

  function openPanel() {
    if (!bar) return
    panelOpen = true
    bar.style.display = 'flex'
    // Opening means "special keys, not typing" - drop the OS keyboard so it isn't
    // fighting the bar for the bottom of the screen.
    dismissKeyboard()
    var h = bar.offsetHeight || 58
    document.documentElement.style.setProperty('--jd-kb', h + 'px')
    document.documentElement.classList.add('jd-keybar-open')
    setFabIcon()
    place()
    fireResize()
  }
  function closePanel() {
    panelOpen = false
    if (bar) bar.style.display = 'none'
    document.documentElement.classList.remove('jd-keybar-open')
    document.documentElement.style.setProperty('--jd-kb', '0px')
    setFabIcon()
    place()
    fireResize()
  }
  function togglePanel() { if (panelOpen) closePanel(); else openPanel() }

  // The panel docks at the real bottom (content above it is pushed up via the
  // push-up style). The FAB rides just above the panel when open; when closed it
  // floats bottom-right, lifted above the soft keyboard if one is up (the gap
  // visualViewport leaves below itself).
  function place() {
    var vv = window.visualViewport
    var gap = vv ? window.innerHeight - vv.height - vv.offsetTop : 0
    if (gap < 0) gap = 0
    if (bar) bar.style.bottom = '0px'
    if (fab) {
      var barH = panelOpen && bar ? bar.offsetHeight || 58 : 0
      fab.style.bottom = (Math.max(gap, barH) + 12) + 'px'
    }
  }

  // Presence controls ONLY the FAB's visibility, and acts only on a real change,
  // so the constant DOM churn of a streaming terminal can't reset panelOpen (the
  // bug where the bar reopened/closed on its own). The panel is closed only if the
  // terminal genuinely disappears. Debounced via rAF.
  var termPresent = false
  function applyPresence() {
    var present = !!document.querySelector('.xterm')
    if (present === termPresent) return
    termPresent = present
    if (fab) fab.style.display = present ? 'block' : 'none'
    if (!present && panelOpen) closePanel()
    place()
  }
  var presenceRaf = 0
  function scheduleRefresh() {
    if (presenceRaf) return
    presenceRaf = requestAnimationFrame(function () { presenceRaf = 0; applyPresence() })
  }

  if (window.visualViewport) {
    var reposition = function () { if (fab && fab.style.display !== 'none') place() }
    window.visualViewport.addEventListener('resize', reposition)
    window.visualViewport.addEventListener('scroll', reposition)
  }

  // --- Touch-scroll for the Claude TUI ------------------------------------
  // The Claude backend runs a full-screen TUI in xterm, which keeps NO DOM
  // scrollback (the viewport's scrollHeight == clientHeight, confirmed on
  // device), so a finger drag has nothing to scroll natively. Desktop users
  // scroll it with the mouse wheel - xterm forwards wheel to the app, which
  // scrolls its own transcript. Replicate that on touch: translate a vertical
  // one-finger drag over the terminal into WheelEvents on the xterm viewport.
  // Same input path as desktop, so if wheel scrolls Claude on desktop it scrolls
  // here too. A small threshold lets taps (place cursor / select) through.
  var tScroll = { on: false, y: 0 }
  function inTerm(t) { return !!(t && t.closest && t.closest('.xterm')) }
  document.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 1 || !inTerm(e.target)) { tScroll.on = false; return }
    tScroll.on = true
    tScroll.y = e.touches[0].clientY
  }, { passive: true })
  document.addEventListener('touchmove', function (e) {
    if (!tScroll.on || e.touches.length !== 1) return
    var vp = document.querySelector('.xterm-viewport')
    if (!vp) return
    var y = e.touches[0].clientY
    var dy = tScroll.y - y // drag up (finger up) -> positive deltaY -> scroll down
    if (Math.abs(dy) < 2) return
    tScroll.y = y
    e.preventDefault() // stop the page rubber-banding while we drive the terminal
    vp.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, deltaMode: 0, bubbles: true, cancelable: true }))
  }, { passive: false })
  document.addEventListener('touchend', function () { tScroll.on = false }, { passive: true })

  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', build)
  else build()
})()
