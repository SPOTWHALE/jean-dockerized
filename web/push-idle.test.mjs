// Run: node web/push-idle.test.mjs   (no framework; asserts + exit code)
import assert from 'node:assert/strict'
import { createIdleTracker } from './push-idle.mjs'

// A real turn (lots of output) then idle -> notify exactly once.
let t = createIdleTracker({ turnMinBytes: 256 })
t.onOutput('a', 500)
assert.equal(t.onIdle('a'), true, 'first idle after real output should notify')
assert.equal(t.onIdle('a'), false, 'second idle with no new output must NOT re-notify')

// Redraw blips (small, below threshold) must not re-arm the notification.
t.onOutput('a', 10)
t.onOutput('a', 10)
assert.equal(t.onIdle('a'), false, 'tiny redraw blips should not cause a duplicate notify')

// A genuine new turn (output past the threshold) re-arms and notifies again.
t.onOutput('a', 300)
assert.equal(t.onIdle('a'), true, 'a real new turn should notify again')

// Per-terminal isolation.
assert.equal(t.onIdle('b'), true, 'a different terminal notifies independently')

// Unknown payload size (len 0) falls back to a nominal count: enough chunks = a turn.
t = createIdleTracker({ turnMinBytes: 256 })
assert.equal(t.onIdle('c'), true)
for (let i = 0; i < 20; i++) t.onOutput('c', 0) // 20 * 16 = 320 >= 256
assert.equal(t.onIdle('c'), true, 'many unknown-size chunks should count as a real turn')

console.log('push-idle: all assertions passed')
