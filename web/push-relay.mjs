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
// Fail-closed: this process is only started by entrypoint.sh when JEAN_TOKEN is
// set (it needs the token to open jean's WS anyway). Subscribe/unsubscribe
// require that same token, so only an authenticated jean user can register a
// device. The VAPID public key is, by design, public (it gates nothing).
//
// Zero-runtime-config crypto is delegated to `web-push` (RFC 8291/8292 payload
// encryption + VAPID JWT). It resolves from /opt/push/node_modules (installed in
// the Dockerfile). Node 22's global `WebSocket` drives the jean client - no `ws`.
import http from 'node:http'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import webpush from 'web-push'

const JEAN_PORT = process.env.JEAN_PORT || '3456'
const PUSH_PORT = Number(process.env.PUSH_PORT || 8455)
const JEAN_TOKEN = process.env.JEAN_TOKEN || ''
const SUBJECT = process.env.PUSH_SUBJECT || 'mailto:push@jean-dockerized.local'
const STATE_DIR = process.env.PUSH_STATE_DIR || '/workspace/.jean-push'

if (!JEAN_TOKEN) {
  // Should never happen (entrypoint guards it) - but never run token-less.
  console.error('[push] JEAN_TOKEN not set; relay disabled')
  process.exit(0)
}

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
  if (typeof given !== 'string' || given.length !== JEAN_TOKEN.length) return false
  try {
    return timingSafeEqual(Buffer.from(given), Buffer.from(JEAN_TOKEN))
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
    case 'chat:codex_mcp_elicitation_request':
      return { title: 'Jean: needs your approval', body: 'The agent is waiting for you to respond.', tag }
    default:
      return null
  }
}

// --- WebSocket client to jean. Reconnects with backoff; jean's heartbeats keep
// it alive and we simply ignore everything that isn't a notify-worthy event.
let backoff = 1000
function connectJean() {
  const ws = new WebSocket(`ws://127.0.0.1:${JEAN_PORT}/ws?token=${encodeURIComponent(JEAN_TOKEN)}`)
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
    const n = notificationFor(msg.event, msg.payload)
    if (n) broadcast(n).catch(() => {})
  })
  const retry = () => {
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
