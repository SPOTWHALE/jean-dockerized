// @wrapper-status: STOPGAP - remove when jean delivers web push itself. See
// AGENTS.md "Injected patch layer".
// Web Push relay: turns jean's agent activity into phone notifications, so you
// can fire a task, pocket the phone, and get buzzed when the agent finishes or
// needs you. jean is NOT forked - this only *observes* jean's own WebSocket and
// fans the interesting events out as Web Push messages to subscribed browsers.
//
// Pieces:
//   - a WebSocket CLIENT to jean (ws://127.0.0.1:<JEAN_PORT>/ws?token=...), the
//     same socket jean's own UI uses; we read its `{type:"event", event, payload}`
//     stream and map a few event names to notifications.
//   - a tiny loopback HTTP server the browser talks to (through the preview proxy
//     at jdpush.<wildcard>) to fetch the VAPID public key and register/unregister
//     its push subscription.
//
// Token: JEAN_TOKEN if set, else jean's auto-generated http_server_token read
// from its prefs file (so push works with the generated token). It's needed to
// open jean's WS, and subscribe/unsubscribe require that same token, so only an
// authenticated jean user can register a device. The VAPID public key is, by
// design, public (it gates nothing).
//
// Zero-runtime-config crypto is delegated to `web-push` (RFC 8291/8292 payload
// encryption + VAPID JWT). It resolves from /opt/push/node_modules (installed in
// the Dockerfile). Node 22's global `WebSocket` drives the jean client - no `ws`.
import http from 'node:http'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import webpush from 'web-push'
import { createIdleTracker } from './push-idle.mjs'

const JEAN_PORT = process.env.JEAN_PORT || '3456'
const PUSH_PORT = Number(process.env.PUSH_PORT || 8455)
let TOKEN = process.env.JEAN_TOKEN || ''
// Where jean persists its auto-generated HTTP token (HOME=/workspace). Used as a
// fallback so push works without anyone setting JEAN_TOKEN.
const PREFS = process.env.JEAN_PREFS || '/workspace/.local/share/com.jean.desktop/preferences.json'
const SUBJECT = process.env.PUSH_SUBJECT || 'mailto:push@jean-dockerized.local'
const STATE_DIR = process.env.PUSH_STATE_DIR || '/workspace/.jean-push'
// jean's "Claude backend" runs Claude Code as a TUI in a terminal pane, which
// emits ONLY terminal:* events (never chat:done / chat:codex_*). So for that
// backend the chat-event map below never fires; we instead detect end-of-turn
// by terminal idle: Claude animates its spinner while working, so a gap with no
// terminal:output means it finished or is waiting for you. PUSH_IDLE_MS is that
// gap (0 disables idle push, leaving only the chat-event notifications).
// Heuristic, not exact: Claude's spinner does NOT stream, so silent gaps of
// several seconds are normal mid-turn (a quiet tool call) - measured gaps up to
// ~11s. Default 20s trades promptness for fewer mid-work false fires; same-tag
// notifications replace rather than stack, so a false fire is corrected by the
// real one. Lower it if you prefer faster (noisier) pings.
const IDLE_MS = Number(process.env.PUSH_IDLE_MS || 20000)

// No explicit JEAN_TOKEN? Fall back to jean's auto-generated, persisted token.
// The relay is launched just before jean, so on first boot the prefs file may
// not exist yet - poll for http_server_token rather than fail. This is what lets
// push work with the generated token (no manual JEAN_TOKEN needed). Top-level
// await is fine in this ESM module on Node 22.
if (!TOKEN) {
  console.log('[push] no JEAN_TOKEN set; waiting for jean http_server_token in prefs...')
  for (let i = 0; i < 180 && !TOKEN; i++) {
    try {
      const prefs = JSON.parse(readFileSync(PREFS, 'utf8'))
      if (prefs && typeof prefs.http_server_token === 'string' && prefs.http_server_token) {
        TOKEN = prefs.http_server_token
      }
    } catch {
      /* prefs not written yet */
    }
    if (!TOKEN) await new Promise((r) => setTimeout(r, 1000))
  }
}
if (!TOKEN) {
  console.error('[push] no token (JEAN_TOKEN unset and no http_server_token in prefs); relay disabled')
  process.exit(0)
}
console.log('[push] token resolved; relay starting')

// --- VAPID keys: generate once, persist on the volume so subscriptions made by
// browsers stay valid across restarts (the key pair is the subscription's identity).
mkdirSync(STATE_DIR, { recursive: true })
const VAPID_FILE = join(STATE_DIR, 'vapid.json')
const SUBS_FILE = join(STATE_DIR, 'subs.json')

let vapid
if (existsSync(VAPID_FILE)) {
  vapid = JSON.parse(readFileSync(VAPID_FILE, 'utf8'))
} else {
  vapid = webpush.generateVAPIDKeys()
  writeFileSync(VAPID_FILE, JSON.stringify(vapid))
  console.log('[push] generated VAPID key pair')
}
webpush.setVapidDetails(SUBJECT, vapid.publicKey, vapid.privateKey)

// --- Subscriptions: a Map keyed by endpoint (the browser's unique push URL), so
// re-subscribing the same device replaces rather than duplicates.
const subs = new Map()
if (existsSync(SUBS_FILE)) {
  try {
    for (const s of JSON.parse(readFileSync(SUBS_FILE, 'utf8'))) subs.set(s.endpoint, s)
  } catch {
    /* corrupt file -> start empty */
  }
}
let saveTimer = null
function saveSubs() {
  // Debounce: bursts of (un)subscribes coalesce into one write.
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      writeFileSync(SUBS_FILE, JSON.stringify([...subs.values()]))
    } catch (e) {
      console.error('[push] failed to persist subs:', e.message)
    }
  }, 250)
}

function tokenOk(given) {
  if (typeof given !== 'string' || given.length !== TOKEN.length) return false
  try {
    return timingSafeEqual(Buffer.from(given), Buffer.from(TOKEN))
  } catch {
    return false
  }
}

async function broadcast({ title, body, tag, url }) {
  if (!subs.size) return
  const payload = JSON.stringify({ title, body, tag, url: url || '/' })
  await Promise.all(
    [...subs.values()].map(async (sub) => {
      try {
        await webpush.sendNotification(sub, payload)
      } catch (e) {
        // 404/410 => the browser dropped this subscription; prune it. Other
        // errors (transient network/5xx) are left in place to retry next event.
        if (e.statusCode === 404 || e.statusCode === 410) {
          subs.delete(sub.endpoint)
          saveSubs()
        } else {
          console.error('[push] send failed:', e.statusCode || e.message)
        }
      }
    })
  )
}

// --- Map jean's WS events to notifications. session_id tags the notification so
// repeated events for the same chat replace the previous card instead of stacking.
function notificationFor(event, payload) {
  const tag = (payload && payload.session_id) || 'jean'
  switch (event) {
    case 'chat:done':
      return { title: 'Jean: agent finished', body: 'Your agent finished its turn.', tag }
    case 'chat:error':
      return { title: 'Jean: agent error', body: 'The agent hit an error and stopped.', tag }
    case 'chat:codex_command_approval_request':
    case 'chat:codex_permission_request':
    case 'chat:codex_user_input_request':
    case 'chat:codex_dynamic_tool_call_request':
    case 'chat:codex_mcp_elicitation_request':
      return { title: 'Jean: needs your approval', body: 'The agent is waiting for you to respond.', tag }
    default:
      return null
  }
}

// --- Terminal idle detection (Claude-backend "end of turn"). Keyed by the
// terminal_id on every terminal:output; each new chunk reschedules the timer, so
// it only fires after IDLE_MS of true silence. The idle tracker dedups: it returns
// true only on the FIRST idle of a turn, then stays quiet until enough fresh output
// proves a new turn started - so a TUI redraw blip can't re-buzz the same idle state.
const idle = createIdleTracker({ turnMinBytes: Number(process.env.PUSH_TURN_MIN_BYTES || 256) })
const termTimers = new Map()
function noteTerminalOutput(termId, len) {
  if (!IDLE_MS || !termId) return
  idle.onOutput(termId, len)
  clearTimeout(termTimers.get(termId))
  termTimers.set(
    termId,
    setTimeout(() => {
      termTimers.delete(termId)
      if (!idle.onIdle(termId)) return // already notified this idle; nothing new since
      broadcast({
        title: 'Jean: Claude is idle',
        body: 'Claude stopped output - it finished or is waiting for you.',
        tag: 'term:' + termId,
      }).catch(() => {})
    }, IDLE_MS)
  )
}
function clearTerminal(termId) {
  if (!termId) return
  clearTimeout(termTimers.get(termId))
  termTimers.delete(termId)
  idle.clear(termId)
}
// Best-effort length of a terminal:output chunk across possible payload shapes; feeds
// the idle tracker's "real turn vs redraw blip" threshold.
const outLen = (p) => {
  const s = p && (p.data ?? p.output ?? p.text)
  return typeof s === 'string' ? s.length : 0
}

// --- WebSocket client to jean. Reconnects with backoff; jean's heartbeats keep
// it alive and we simply ignore everything that isn't a notify-worthy event.
let backoff = 1000
function connectJean() {
  const ws = new WebSocket(`ws://127.0.0.1:${JEAN_PORT}/ws?token=${encodeURIComponent(TOKEN)}`)
  ws.addEventListener('open', () => {
    backoff = 1000
    console.log('[push] connected to jean WS')
  })
  ws.addEventListener('message', (ev) => {
    let msg
    try {
      msg = JSON.parse(ev.data)
    } catch {
      return
    }
    if (msg.type !== 'event' || !msg.event) return
    // Terminal (Claude-backend) idle tracking. terminal:stopped means the shell
    // exited, so cancel any pending idle push for it.
    if (msg.event === 'terminal:output') return noteTerminalOutput(msg.payload && msg.payload.terminal_id, outLen(msg.payload))
    if (msg.event === 'terminal:stopped') return clearTerminal(msg.payload && msg.payload.terminal_id)
    const n = notificationFor(msg.event, msg.payload)
    if (n) broadcast(n).catch(() => {})
  })
  // Retry on BOTH error and close, guarded so the pair doesn't double-schedule.
  // A refused initial connect (jean not up yet at boot) fires 'error' but often
  // no 'close' under Node's global WebSocket, so retrying on 'close' alone would
  // stall forever - the relay must keep retrying until jean's WS is listening.
  let retried = false
  const retry = () => {
    if (retried) return
    retried = true
    backoff = Math.min(backoff * 2, 30000)
    setTimeout(connectJean, backoff)
  }
  ws.addEventListener('close', retry)
  ws.addEventListener('error', () => {
    try {
      ws.close()
    } catch {
      /* already closing */
    }
    retry()
  })
}
connectJean()

// --- HTTP API (loopback only; reached by the browser through the preview proxy).
// CORS is open because the page lives on jean's origin while this is served from
// jdpush.<wildcard> - a different origin. No cookies are used; auth is the jean
// token carried in the JSON body, so `*` is safe here.
function send(res, code, obj) {
  const body = obj == null ? '' : JSON.stringify(obj)
  res.writeHead(code, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
  })
  res.end(body)
}

function readJson(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > 1e5) req.destroy() // 100KB cap
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'))
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (req.method === 'OPTIONS') return send(res, 204, null)

    // Public: the VAPID application server key the browser needs to subscribe.
    if (req.method === 'GET' && url.pathname === '/key') {
      return send(res, 200, { key: vapid.publicKey })
    }

    if (req.method === 'POST' && url.pathname === '/subscribe') {
      const b = await readJson(req)
      if (!b || !tokenOk(b.token)) return send(res, 401, { error: 'unauthorized' })
      const sub = b.subscription
      if (!sub || !sub.endpoint) return send(res, 400, { error: 'bad subscription' })
      subs.set(sub.endpoint, sub)
      saveSubs()
      return send(res, 201, { ok: true })
    }

    if (req.method === 'POST' && url.pathname === '/unsubscribe') {
      const b = await readJson(req)
      if (!b || !tokenOk(b.token)) return send(res, 401, { error: 'unauthorized' })
      if (b.endpoint) {
        subs.delete(b.endpoint)
        saveSubs()
      }
      return send(res, 200, { ok: true })
    }

    return send(res, 404, { error: 'not found' })
  })
  .listen(PUSH_PORT, '127.0.0.1', () => {
    console.log(`[push] relay HTTP on 127.0.0.1:${PUSH_PORT}`)
  })
