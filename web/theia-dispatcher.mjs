// @wrapper-status: STOPGAP - bundled Theia IDE backend; remove if jean ships a
// built-in browser IDE.
// Per-worktree Theia dispatcher (zero external deps; node builtins only).
//
// One Theia process can only have one workspace root, so to give each repo/branch a
// scoped sidebar we run a Theia per git worktree, lazily, and route by hostname:
//
//   <slug>.<host>  ->  Theia rooted at that worktree's directory
//   ide.<host>     ->  a picker listing every repo > branch worktree under /workspace
//
// Caddy applies the preview basic-auth gate BEFORE forwarding here, then reverse-proxies
// every non-numeric leading label to this service. We trust incoming requests.
//
// IMPORTANT: this is COSMETIC scoping only - NOT a security boundary. Each Theia roots
// the file explorer at one worktree, but its integrated terminal still runs as root and
// can reach all of /workspace. Real isolation needs a container/user per repo.
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'

const WORKSPACE = process.env.THEIA_WORKSPACE || '/workspace'
const MAIN = process.env.THEIA_MAIN || '/opt/theia/src-gen/backend/main.js'
const LISTEN_PORT = parseInt(process.env.THEIA_DISPATCH_PORT || '8444', 10)
// Default loopback (reached only via Caddy). Set to 0.0.0.0 for the Tailscale path,
// where the client hits this dispatcher directly at <tailscale-ip>:<port> (no
// subdomain routing) and scopes worktrees via ?ws=/?repo=&branch= query hints.
const LISTEN_HOST = process.env.THEIA_DISPATCH_HOST || '127.0.0.1'
// Host the per-worktree Theia instances bind. Loopback by default (reached only via
// this dispatcher); 0.0.0.0 on the Tailscale path so /__open can redirect the client
// straight to <tailscale-ip>:<instance-port>.
const INSTANCE_HOST = process.env.THEIA_INSTANCE_HOST || '127.0.0.1'
const PORT_BASE = parseInt(process.env.THEIA_INSTANCE_PORT_BASE || '8500', 10)
const IDLE_MS = parseInt(process.env.THEIA_IDLE_MINUTES || '15', 10) * 60_000
const READY_TIMEOUT_MS = 60_000

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
const log = (...a) => console.log('[theia-dispatcher]', ...a)

// dir -> { dir, port, proc, ready: Promise<void>, lastSeen }. Keyed by worktree dir so
// the same worktree reached via different host slugs reuses one Theia (no duplicates).
const instances = new Map()
let nextPort = PORT_BASE

// Enumerate worktrees layout-agnostically: every top-level repo under /workspace, then
// `git worktree list` for each (covers the main checkout AND linked branch worktrees,
// wherever jean places them).
function listWorktrees() {
  const seen = new Set()
  const out = []
  let entries = []
  try {
    entries = fs.readdirSync(WORKSPACE, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
  } catch { /* workspace may be empty */ }
  for (const e of entries) {
    const repoDir = path.join(WORKSPACE, e.name)
    if (!fs.existsSync(path.join(repoDir, '.git'))) continue
    let porcelain
    try {
      porcelain = execFileSync('git', ['-C', repoDir, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })
    } catch { continue }
    let cur = {}
    const flush = () => {
      if (!cur.dir || seen.has(cur.dir)) { cur = {}; return }
      seen.add(cur.dir)
      const branch = cur.branch ? cur.branch.replace('refs/heads/', '') : '(detached)'
      out.push({ repo: e.name, branch, dir: cur.dir, slug: slugify(`${e.name}-${branch}`) })
      cur = {}
    }
    for (const line of porcelain.split('\n')) {
      if (line.startsWith('worktree ')) { flush(); cur.dir = line.slice(9) }
      else if (line.startsWith('branch ')) cur.branch = line.slice(7)
      else if (line === '') flush()
    }
    flush()
  }
  return out
}

// Resolve a request to a worktree dir, in order of confidence:
//   ?ws=<path>            explicit dir (validated under /workspace)
//   ?repo=&branch=        from the button's document.title parse (robust on load)
//   <slug> host label     matches the on-disk scan's repo-branch slug
//   single repo match     repo given, one worktree -> that one
// Returns an absolute dir under WORKSPACE, or null (-> picker).
function resolveDir(slug, { ws, repo, branch } = {}) {
  if (ws) {
    try {
      const real = fs.realpathSync(ws)
      const root = fs.realpathSync(WORKSPACE)
      if ((real === root || real.startsWith(root + path.sep)) && fs.statSync(real).isDirectory()) return real
    } catch { /* fall through */ }
  }
  const list = listWorktrees()
  const sl = (x) => slugify(x)
  // branch from git may be "feat/x"; the title may show just "x" - compare both.
  const branchMatches = (w) => !branch || sl(w.branch) === sl(branch) || sl(w.branch.split('/').pop()) === sl(branch)
  let m = repo ? list.find((w) => sl(w.repo) === sl(repo) && branchMatches(w)) : null
  if (!m) m = list.find((w) => w.slug === slug)
  if (!m && repo) {
    const byRepo = list.filter((w) => sl(w.repo) === sl(repo))
    if (byRepo.length === 1) m = byRepo[0]
  }
  return m ? m.dir : null
}

function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const s = net.connect(port, '127.0.0.1')
      s.once('connect', () => { s.destroy(); resolve() })
      s.once('error', () => {
        s.destroy()
        if (Date.now() > deadline) reject(new Error('Theia did not start in time'))
        else setTimeout(tryOnce, 250)
      })
    }
    tryOnce()
  })
}

function ensureInstance(dir) {
  let it = instances.get(dir)
  if (it) { it.lastSeen = Date.now(); return it }
  const port = nextPort++
  log(`spawn Theia dir=${dir} port=${port}`)
  const proc = spawn('node', [MAIN, dir, '--hostname', INSTANCE_HOST, '--port', String(port)],
    { stdio: 'ignore', env: process.env })
  it = { dir, port, proc, lastSeen: Date.now(), ready: waitForPort(port, READY_TIMEOUT_MS) }
  instances.set(dir, it)
  proc.on('exit', (code) => { log(`Theia dir=${dir} exited (${code})`); instances.delete(dir) })
  return it
}

const slugOf = (host) => {
  const label = String(host || '').split(':')[0].split('.')[0]
  return slugify(label)
}

// Direct (Tailscale) access has no wildcard subdomain to route by - a bare IP or a
// MagicDNS (…​.ts.net) host - so the picker links to the dispatcher's /__open instead.
const isDirectHost = (h) => {
  const host = String(h || '').split(':')[0]
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /\.ts\.net$/i.test(host)
}

function pickerHtml(reqHost) {
  const direct = isDirectHost(reqHost)
  const rows = listWorktrees().map((w) => {
    // Direct/Tailscale: hit /__open, which redirects to this worktree's own Theia port
    // (every port is reachable over the tailnet) so Theia's later asset/WS requests go
    // straight to that instance. Domain path keeps the wildcard-subdomain link.
    const href = direct ? `/__open?ws=${encodeURIComponent(w.dir)}` : `//${w.slug}.__SUFFIXHOST__`
    return `<li><a href="${href}">${escapeHtml(w.repo)} <span class="b">&rsaquo; ${escapeHtml(w.branch)}</span></a></li>`
  }).join('')
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Open in IDE</title>
<style>body{margin:0;min-height:100dvh;background:#0b0b0c;color:#e7e7ea;font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;padding:24px}
.card{width:min(560px,100%)}h1{font-size:18px;margin:0 0 4px}p{color:#9b9ba3;margin:0 0 16px;font-size:13px}
ul{list-style:none;margin:0;padding:0;border:1px solid #26262b;border-radius:10px;overflow:hidden}
li+li{border-top:1px solid #26262b}a{display:block;padding:12px 16px;color:#e7e7ea;text-decoration:none}
a:hover{background:#1b1b1f}.b{color:#8a8a93}.empty{padding:16px;color:#9b9ba3}</style>
<div class=card><h1>Open a worktree in the IDE</h1><p>Scoped editor per repo &amp; branch. Not a security boundary &mdash; the terminal can still reach all of /workspace.</p>
<ul>${rows || '<li class=empty>No git repos found under /workspace yet. Clone one in jean first.</li>'}</ul></div>`
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

// The picker links need the wildcard host suffix (everything after the leading label).
function suffixHost(reqHost) {
  const [host, port] = String(reqHost || '').split(':')
  const rest = host.split('.').slice(1).join('.')
  return rest + (port ? ':' + port : '')
}

function servePicker(req, res) {
  const html = pickerHtml(req.headers.host)
    .replaceAll('__SUFFIXHOST__', escapeHtml(suffixHost(req.headers.host)))
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(html)
}

function badGateway(res, msg) {
  res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('Theia dispatcher: ' + msg)
}

const hints = (req) => {
  const q = new URL(req.url, 'http://x').searchParams
  return { ws: q.get('ws'), repo: q.get('repo'), branch: q.get('branch') }
}

const server = http.createServer(async (req, res) => {
  // Direct/Tailscale entry point: resolve the worktree from query hints, then redirect
  // the client to that worktree's own Theia port (reachable over the tailnet), so every
  // later request hits the instance directly instead of routing by an absent subdomain.
  if (req.url.split('?')[0] === '/__open') {
    const dir = resolveDir(null, hints(req))
    if (!dir) return servePicker(req, res)
    const it = ensureInstance(dir)
    it.lastSeen = Date.now()
    try { await it.ready } catch { return badGateway(res, 'instance failed to start') }
    const ip = String(req.headers.host || '').split(':')[0]
    res.writeHead(302, { location: `//${ip}:${it.port}/`, 'cache-control': 'no-store' })
    return res.end()
  }
  const slug = slugOf(req.headers.host)
  if (!slug || slug === 'ide') return servePicker(req, res)
  const dir = resolveDir(slug, hints(req))
  if (!dir) return servePicker(req, res)
  const it = ensureInstance(dir)
  it.lastSeen = Date.now()
  try { await it.ready } catch { return badGateway(res, 'instance failed to start') }
  const proxy = http.request(
    { host: '127.0.0.1', port: it.port, method: req.method, path: req.url, headers: req.headers },
    (pres) => { res.writeHead(pres.statusCode || 502, pres.headers); pres.pipe(res) }
  )
  proxy.on('error', () => badGateway(res, 'upstream error'))
  req.pipe(proxy)
})

// WebSocket / upgrade passthrough (Theia's frontend<->backend channel is a WebSocket).
server.on('upgrade', async (req, socket, head) => {
  const slug = slugOf(req.headers.host)
  if (!slug || slug === 'ide') { socket.destroy(); return }
  const dir = resolveDir(slug, hints(req))
  if (!dir) { socket.destroy(); return }
  const it = ensureInstance(dir)
  it.lastSeen = Date.now()
  try { await it.ready } catch { socket.destroy(); return }
  const up = net.connect(it.port, '127.0.0.1', () => {
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n` +
      Object.entries(req.headers).map(([k, v]) => `${k}: ${v}\r\n`).join('') + '\r\n')
    if (head && head.length) up.write(head)
    socket.pipe(up)
    up.pipe(socket)
  })
  up.on('error', () => socket.destroy())
  socket.on('error', () => up.destroy())
})

// Idle reaper: stop Theia instances with no traffic for IDLE_MS.
setInterval(() => {
  const now = Date.now()
  for (const [dir, it] of instances) {
    if (now - it.lastSeen > IDLE_MS) { log(`reaping idle dir=${dir}`); try { it.proc.kill() } catch {} }
  }
}, 60_000).unref()

server.listen(LISTEN_PORT, LISTEN_HOST, () => log(`listening on ${LISTEN_HOST}:${LISTEN_PORT}, workspace=${WORKSPACE}`))
