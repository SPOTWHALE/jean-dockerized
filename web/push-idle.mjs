// @wrapper-status: STOPGAP - part of the push relay; remove when jean ships web push.
// Pure dedup for the Claude-backend "terminal went idle" notification.
//
// The relay notifies when a terminal stops emitting output for IDLE_MS. But Claude's
// TUI redraws sporadically while WAITING for you (status bar, cursor), so a naive
// timer re-fires for the SAME idle state every time a tiny redraw lands and goes quiet
// again - the duplicate-notification bug. This latch fixes it: after we notify a
// terminal idle, we stay quiet until a real new turn has produced at least
// `turnMinBytes` of fresh output. A redraw blip is small and never crosses it; an
// actual agent turn streams far more, so the next genuine end-of-turn notifies once.
//
// No timers here (the relay owns those) - just the decision, so it is trivially testable.
export function createIdleTracker({ turnMinBytes = 256 } = {}) {
  const state = new Map() // termId -> { notified, bytes }
  const get = (id) => {
    let s = state.get(id)
    if (!s) { s = { notified: false, bytes: 0 }; state.set(id, s) }
    return s
  }
  return {
    // Call on each terminal:output chunk. `len` is the chunk's text length; when the
    // payload shape is unknown it falls back to a nominal 16 so many chunks still add up.
    onOutput(termId, len) {
      const s = get(termId)
      s.bytes += len > 0 ? len : 16
      if (s.notified && s.bytes >= turnMinBytes) s.notified = false // real new turn -> re-arm
    },
    // Call when the idle timer fires. Returns true only if we should actually notify.
    onIdle(termId) {
      const s = get(termId)
      if (s.notified) return false // already told you about this idle; nothing new since
      s.notified = true
      s.bytes = 0
      return true
    },
    clear(termId) { state.delete(termId) },
  }
}
