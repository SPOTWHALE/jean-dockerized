// Mobile accessory key-bar for jean's built-in terminal. Phone soft keyboards
// lack Esc / Tab / Ctrl / arrows, but jean's Claude backend runs an interactive
// TUI in jean's own terminal panel that needs them. A PWA can't swap the OS
// keyboard, so we render our own row of keys above it and feed synthetic
// KeyboardEvents straight to xterm.js's hidden helper textarea (the element
// xterm itself listens on). jean is NOT forked - this only touches rendered DOM
// and the browser, same pattern as push-init.js / theia-launch.js.
(function () {
  // Only touch devices need this; a desktop has the real keys. Gate on a coarse
  // pointer so the bar never appears on a mouse + keyboard machine.
  if (!window.matchMedia || !window.matchMedia('(pointer: coarse)').matches) return

  var BAR_ID = 'jd-keybar'
  var bar = null
  var activeTextarea = null // the xterm helper textarea currently focused
  var sticky = { ctrl: false, alt: false } // one-shot modifiers, cleared after use

  // Each entry is either a key to send or a sticky modifier toggle (`mod`).
  // Modern xterm reads event.key / event.code; older builds read keyCode (esp.
  // for Ctrl+letter -> control byte), which a constructed KeyboardEvent always
  // reports as 0 - so we also override keyCode/which below. Printable chars are
  // intentionally omitted: the soft keyboard's symbol layer already has them,
  // and xterm types those via input events, not synthetic keydown.
  var KEYS = [
    { id: 'esc', label: 'Esc', key: 'Escape', code: 'Escape', kc: 27 },
    { id: 'tab', label: 'Tab', key: 'Tab', code: 'Tab', kc: 9 },
    { id: 'ctrl', label: 'Ctrl', mod: 'ctrl' },
    { id: 'alt', label: 'Alt', mod: 'alt' },
    { id: 'left', label: '←', key: 'ArrowLeft', code: 'ArrowLeft', kc: 37 },
    { id: 'up', label: '↑', key: 'ArrowUp', code: 'ArrowUp', kc: 38 },
    { id: 'down', label: '↓', key: 'ArrowDown', code: 'ArrowDown', kc: 40 },
    { id: 'right', label: '→', key: 'ArrowRight', code: 'ArrowRight', kc: 39 },
    // Common control combos, one tap away (xterm emits the control byte from a
    // synthetic Ctrl+<letter> keydown): SIGINT, EOF, reverse-search, suspend.
    { id: 'c-c', label: '^C', key: 'c', code: 'KeyC', kc: 67, ctrl: true },
    { id: 'c-d', label: '^D', key: 'd', code: 'KeyD', kc: 68, ctrl: true },
    { id: 'c-r', label: '^R', key: 'r', code: 'KeyR', kc: 82, ctrl: true },
    { id: 'c-z', label: '^Z', key: 'z', code: 'KeyZ', kc: 90, ctrl: true },
  ]

  function send(spec) {
    if (!activeTextarea) return
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
    activeTextarea.dispatchEvent(ev)
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

  function press(spec, e) {
    // preventDefault keeps focus on the textarea so the soft keyboard stays up
    // and the button never becomes activeElement.
    e.preventDefault()
    e.stopPropagation()
    if (spec.mod) {
      sticky[spec.mod] = !sticky[spec.mod]
      paintMods()
      return
    }
    send(spec)
  }

  function build() {
    bar = document.createElement('div')
    bar.id = BAR_ID
    bar.style.cssText = [
      'position:fixed', 'left:0', 'right:0', 'bottom:0', 'z-index:2147483647',
      'display:none', 'gap:6px', 'padding:6px', 'box-sizing:border-box',
      'overflow-x:auto', 'white-space:nowrap', '-webkit-overflow-scrolling:touch',
      'background:#0b0b0c', 'border-top:1px solid #2a2a2a',
      'font:600 15px system-ui,-apple-system,sans-serif', 'user-select:none',
      'touch-action:manipulation',
    ].join(';')

    KEYS.forEach(function (k) {
      var b = document.createElement('button')
      b.type = 'button'
      b.id = BAR_ID + '-' + k.id
      b.textContent = k.label
      b.style.cssText = [
        'flex:0 0 auto', 'min-width:44px', 'height:40px', 'padding:0 12px',
        'border:0', 'border-radius:8px', 'color:#e5e7eb', 'background:#1f2937',
        'font:inherit', 'cursor:pointer',
      ].join(';')
      // Act on pointerdown (with preventDefault) so focus never leaves the
      // textarea; also swallow mousedown for engines that fire it first.
      b.addEventListener('pointerdown', function (e) { press(k, e) })
      b.addEventListener('mousedown', function (e) { e.preventDefault() })
      bar.appendChild(b)
    })
    document.body.appendChild(bar)
  }

  // Sit the bar right on top of the soft keyboard. visualViewport shrinks to the
  // visible area above the keyboard, so the gap below it is innerHeight - height.
  function place() {
    var vv = window.visualViewport
    if (!vv || !bar) return
    var gap = window.innerHeight - vv.height - vv.offsetTop
    bar.style.bottom = (gap > 0 ? gap : 0) + 'px'
  }

  function show() { if (bar) { bar.style.display = 'flex'; place() } }
  function hide() {
    if (!bar) return
    bar.style.display = 'none'
    sticky.ctrl = sticky.alt = false
    paintMods()
  }

  function isTermInput(el) {
    return !!el && el.tagName === 'TEXTAREA' &&
      ((el.classList && el.classList.contains('xterm-helper-textarea')) ||
        (el.closest && el.closest('.xterm')))
  }

  document.addEventListener('focusin', function (e) {
    if (isTermInput(e.target)) { activeTextarea = e.target; show() }
  })
  document.addEventListener('focusout', function (e) {
    if (!isTermInput(e.target)) return
    // Tapping a bar button never blurs the textarea (preventDefault). A real
    // blur (keyboard dismissed / focus elsewhere) hides the bar.
    setTimeout(function () {
      if (!isTermInput(document.activeElement)) { activeTextarea = null; hide() }
    }, 100)
  })

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', function () {
      if (bar && bar.style.display !== 'none') place()
    })
    window.visualViewport.addEventListener('scroll', function () {
      if (bar && bar.style.display !== 'none') place()
    })
  }

  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', build)
  else build()
})()
