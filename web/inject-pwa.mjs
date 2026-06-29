// @wrapper-status: WRAPPER - injector infra; needed as long as any patch exists.
// See AGENTS.md "Injected patch layer".
// Injects PWA <head> tags into jean's built index.html. Run at Docker build
// time against /src/dist/index.html. Idempotent: skips if already injected.
// Jean's own source is never modified - only the static build output.
import { readFileSync, writeFileSync } from 'node:fs'

const file = process.argv[2]
if (!file) {
  console.error('usage: node inject-pwa.mjs <path-to-index.html>')
  process.exit(1)
}

let html = readFileSync(file, 'utf8')

if (html.includes('manifest.webmanifest')) {
  console.log('[pwa] head already injected - skipping')
  process.exit(0)
}

// Runs before jean's bundle (first thing in <head>). If no token is available
// - none stored from a previous visit and none in the URL - send the user to
// the token-entry page instead of letting jean render its "no token" error.
// Guard fires on ALL paths (not just /), so deep links don't bypass it.
// Excludes /token.html itself to avoid an infinite redirect loop.
const guard = `<script>(function(){try{var u=/[?&]token=/.test(location.search);var s=!!localStorage.getItem('jean-http-token');if(!u&&!s&&location.pathname!=='/token.html'){location.replace('/token.html')}}catch(e){}})()</script>
`

// Baked at build time (release.yml passes the wrapper release tag, e.g.
// v0.1.58b). When set, version-badge.js re-points jean's version badge to our
// repo and shows an update pill. Absent on local/dev builds -> the badge is
// left untouched (the script no-ops without a version).
const imageVersion = process.env.IMAGE_VERSION || ''
// jean serves every static asset with `Cache-Control: immutable, max-age=1yr`,
// and our injected files have stable (non-hashed) names, so a browser that
// visited once NEVER refetches an updated version-badge.js / push-init.js /
// term-keybar.js / chat-scroll-fix.js. Bake a per-build cache-bust token into
// each injected URL so every image build is a fresh URL the cache must refetch.
// IMAGE_VERSION on releases; a build timestamp on local/dev builds.
const bust = imageVersion || `dev${Date.now()}`
const v = `?v=${encodeURIComponent(bust)}`
const versionTags = imageVersion
  ? `    <script>window.__IMAGE_VERSION__=${JSON.stringify(imageVersion)}</script>
    <script src="/version-badge.js${v}" defer></script>
`
  : ''

const tags = `
    <link rel="manifest" href="/manifest.webmanifest${v}">
    <meta name="theme-color" content="#0b0b0c">
    <link rel="apple-touch-icon" href="/apple-touch-icon.png${v}">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="apple-mobile-web-app-title" content="Jean">
    <script>if('serviceWorker' in navigator){addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){})})}</script>
${versionTags}    <script src="/theia-config.js${v}" defer></script>
    <script src="/theia-launch.js${v}" defer></script>
    <script src="/push-config.js${v}" defer></script>
    <script src="/push-init.js${v}" defer></script>
    <script src="/term-keybar.js${v}" defer></script>
`

if (!html.includes('</head>') || !html.includes('<head>')) {
  console.error('[pwa] no <head>…</head> found in index.html')
  process.exit(1)
}

// Guard goes first so it can redirect before the (deferred) app bundle loads.
html = html.replace('<head>', '<head>\n    ' + guard)
html = html.replace('</head>', tags + '  </head>')
writeFileSync(file, html)
console.log(
  '[pwa] injected token guard, manifest, icons, service worker, Theia launcher, and push' +
    (imageVersion ? ` + version badge (${imageVersion})` : '')
)
