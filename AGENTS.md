# AGENTS.md

This is the canonical instruction file for coding agents working in this repository.
([`CLAUDE.md`](./CLAUDE.md) points here.)

## What this repo is

A thin **packaging wrapper** that runs [coollabsio/jean](https://github.com/coollabsio/jean)
headless in Docker so AI-agent coding works from any browser against a VPS. Jean is **not
forked or modified** - the image downloads jean's **official prebuilt Linux binary** from the
GitHub release `.deb` (no Rust/Tauri compile). The first-party code here is `Dockerfile`,
`docker-compose.yml`, `entrypoint.sh`, `proxy/Caddyfile`, and the `web/` PWA assets.

This means: there is **no application source tree to edit**. Almost all changes are to the
build/run plumbing.

## Common commands

```bash
# Theia is prebuilt under the `theia-base` tag of the same image repo. Build it
# once (slow: webpack), then the main image just COPYs it in. Re-run only after
# changing theia/.
docker build -f Dockerfile.theia -t spotwhale/jean-dockerized:theia-base .   # ~5-10 min
docker build --build-arg JEAN_REF=v0.1.57 -t spotwhale/jean-dockerized . # ~2 min (no compile)
docker compose up -d            # run (uses the published/built image; no build: section)
docker compose logs -f          # follow runtime logs; startup banner prints the auth token
docker compose ps               # container status
docker compose down             # stop (volumes persist); add -v to wipe all state
docker compose exec jean bash   # shell into the running container (e.g. to run CLI login flows)
```

`JEAN_REF` must be a **published jean release tag** (the `.deb` only exists for releases),
not a branch. There is no test/lint suite - this repo is infrastructure config, not an app.

## Architecture (the parts that span files)

Single-stage `Dockerfile` (`debian:bookworm-slim`):
- `ADD`s jean's prebuilt `.deb` for `${JEAN_REF}` (filename uses the version sans leading `v`,
  e.g. `Jean_0.1.57_amd64.deb`), `dpkg-deb -x` unpacks it, then copies `usr/bin/jean` to
  `/usr/local/bin/jean` and `usr/lib/Jean/dist` to `/usr/local/bin/dist`. No compile.
- installs git/ssh + the AI CLIs (`@anthropic-ai/claude-code`, `@openai/codex`) + a static
  Caddy binary (`COPY --from=caddy:2.11.4`) for the preview proxy.

**Multi-arch (native runners, no QEMU).** The image builds for `linux/amd64` **and**
`linux/arm64`. `release.yml` is a 3-job pipeline: `prepare` resolves the jean ref + wrapper
version tag + pinned Theia base digest; `build` is a matrix that builds each arch on its OWN
native runner (`ubuntu-latest` for amd64, `ubuntu-24.04-arm` for arm64) and pushes by digest;
`release` stitches the digests into the multi-arch manifest, tags it, and creates the GitHub
Release. No emulation - the old single-job `platforms: amd64,arm64` build compiled Theia under
QEMU for arm64 and timed out at 30m. The Dockerfile still reads buildx's `TARGETARCH`
(`amd64`/`arm64`, which match Debian's arch names and jean's `.deb` asset suffix) to fetch the
right jean `.deb` and Docker apt repo. Don't hard-code `amd64` again.

**Supply chain.** The base is pinned by digest (`debian:bookworm-slim@sha256:…`, the multi-arch
index digest so buildx still picks per-arch); bump with `docker buildx imagetools inspect
debian:bookworm-slim`. The jean `.deb` is verified before unpacking: jean signs every release
asset with a Tauri **minisign** key, so the Dockerfile `ADD`s the `.deb.sig` too, base64-decodes
it (the asset is base64-wrapped) and runs `minisign -Vp jean-release.pub`. `jean-release.pub` is
the pinned public key from upstream `src-tauri/tauri.conf.json` (`pubkey`, base64-decoded). If
jean ever rotates that key, update `jean-release.pub` or every build fails the verify step.

Two non-obvious runtime constraints, both load-bearing - do not "clean them up":
1. **Xvfb is required.** The Tauri binary initializes a GTK event loop even in `--headless`
   mode and panics `Failed to initialize GTK` without a display. `entrypoint.sh` starts
   `Xvfb :99` and exports `DISPLAY=:99` before launching jean. The runtime image therefore
   keeps `libwebkit2gtk`/`libgtk-3`/`xvfb` despite being headless.
2. **Frontend is served from disk, not embedded.** Headless jean looks for
   `{executable_parent}/dist/index.html`, so the Dockerfile copies the built `dist` to
   `/usr/local/bin/dist` (next to the binary). If you move the binary, move `dist` too.
3. **PWA assets are injected, not forked.** After unpacking the `.deb`, the Dockerfile drops
   the files in `web/` into `/usr/local/bin/dist` (manifest, `sw.js`, `token.html`,
   rsvg-rendered icons) and runs `web/inject-pwa.mjs` to add the manifest/icon/SW tags to
   `index.html`. This makes
   the headless web UI installable. `token.html` exists because jean's web client only reads
   the token from a `?token=` URL or `localStorage('jean-http-token')` (see upstream
   `src/lib/transport.ts`) - there is no manual token field, which breaks iOS home-screen
   apps (isolated storage). The injector also adds a guard script at the top of `index.html`:
   on `/` with no stored/URL token it redirects to `token.html`, so the bare domain self-serves
   the prompt (PWA `start_url` is `/`). `token.html` writes that exact key and redirects back.
   `token.html` never auto-redirects away when visited directly (only on a `?token=` link), and
   `?reset` clears the stored token - this is the **only** escape from a wrong/stale token, since
   the app shows its own error and the guard would otherwise bounce you back into it. Don't
   reintroduce an unconditional "token stored -> redirect to /" branch.
   Edit assets in `web/`, never jean's source.
4. **Version badge is re-pointed, not forked.** jean's top-right badge shows
   *jean's* version linking to `coollabsio/jean`, and its "Update available"
   indicator only fires from the Tauri desktop updater (dead in headless web). So
   `inject-pwa.mjs` bakes this image's release tag in as `window.__IMAGE_VERSION__`
   (from the `IMAGE_VERSION` build-arg, set by `release.yml` to `steps.ver.tag`)
   and ships `web/version-badge.js`. That script can't touch jean's React tree, so
   it uses a `MutationObserver` to rewrite the badge to our version, hijacks its
   click (capture phase, before React's root listener) to open
   `SPOTWHALE/jean-dockerized` releases, and polls our `releases/latest` to show
   our own update pill when the tag differs. `IMAGE_VERSION` blank (local build)
   -> the script no-ops and jean's badge is left as-is.

**Preview proxy.** A static Caddy binary (`COPY --from=caddy:2`) runs in the background from
`entrypoint.sh`, configured by `proxy/Caddyfile`. It listens on `PREVIEW_PORT` (8088) and maps
the leading numeric label of the Host (`<port>.<anything>`) to `127.0.0.1:<port>` - so dev
servers the agent starts in the container are reachable via a wildcard domain. Traefik/Coolify
terminates TLS and forwards `*.apps.<domain>` → 8088; Caddy speaks plain HTTP (`auto_https off`).
This split exists because Traefik routes host→fixed-port and can't derive the port from the
subdomain. Dev servers must bind `0.0.0.0`. Each preview port's `route` `import`s
`/etc/caddy/auth.import` (wrapped in `route` so the gate runs before `reverse_proxy`);
`entrypoint.sh` writes that file at startup. Previews **fail closed**: a `basic_auth` block
(bcrypt via `caddy hash-password`) when `PREVIEW_PASSWORD` is set, otherwise a `respond 403`.
So previews are disabled until `PREVIEW_PASSWORD` is set, then gated behind one login. Don't
revert this to an empty/open default - it would expose every loopback port to the internet.

**Built-in IDE (Theia).** A browser-flavored Eclipse Theia app (`theia/package.json`) is built in
a **prebuilt base image** (`Dockerfile.theia`, `FROM node:22-bookworm`, matched to the final
image's Debian/Node so `node-pty` is ABI-compatible), published multi-arch under the
`theia-base` tag of the **same** repo (`spotwhale/jean-dockerized:theia-base`, not a separate
repo) by `.github/workflows/theia-base.yml` (native matrix runners, push-by-digest + manifest
merge; triggers on `theia/**`). The main Dockerfile aliases it as a stage (`FROM ${THEIA_BASE}
AS theia` - `--from` can't expand a var directly) and pulls the built app via `COPY --from=theia
/opt/theia /opt/theia`. `THEIA_BASE` is pinned to a digest by `release.yml`'s `prepare` job and
defaults to the `theia-base` tag for local builds. This keeps Theia's slow webpack build off the
jean-release hot path - releases no longer compile it. `entrypoint.sh`
runs it headless on `127.0.0.1:${THEIA_PORT}` (default 8443) with a crash watchdog, so it is
reachable **only through the preview proxy** at `https://<THEIA_PORT>.<wildcard>` - no extra host
port. Theia ships **no auth**, so the preview basic-auth gate is the lock (unset `PREVIEW_PASSWORD`
→ 403, same as previews). `THEIA_WEBVIEW_EXTERNAL_ENDPOINT={{hostname}}` keeps webviews same-origin
because the numeric-only proxy can't route Theia's default `*.webview.<host>` subdomain. The UI
entry point is `web/theia-launch.js` (a floating `</> IDE` button injected by `inject-pwa.mjs`,
same pattern as `version-badge.js`); it opens `window.__THEIA_URL__` from `theia-config.js`, which
`entrypoint.sh` writes from `THEIA_PUBLIC_URL` (falling back to `<port>.<current-host>`). Theia
shares `/workspace`; its settings persist under `/workspace/.theia`. Extensions install at runtime
from Open VSX (`@theia/vsx-registry`), so `theiaPlugins` is intentionally empty. The image-status
badge tracks `theia/` too (`FILES` in `image-status.yml`).

**Web Push notifications.** A relay (`web/push-relay.mjs`) closes the async "fire a task,
pocket the phone" loop: it opens jean's **own** WebSocket as a client
(`ws://127.0.0.1:${JEAN_PORT}/ws?token=…`, the same socket jean's UI uses - **jean is not
forked**), reads its `{type:"event", event, payload:{session_id}}` stream, and on `chat:done`
/ `chat:error` / `chat:codex_*_request` sends a Web Push to subscribed browsers. The
RFC 8291/8292 crypto is delegated to `web-push@3.6.7`, installed into `/opt/push/node_modules`
(the only npm dep added beyond the global CLIs); the WS client uses Node 22's global
`WebSocket` (no `ws` dep). VAPID keys + subscriptions persist under `/workspace/.jean-push`.
The relay's loopback HTTP (`GET /key`, `POST /subscribe|/unsubscribe`) is reached by the
browser through the **preview proxy** at `jdpush.<wildcard>` - a reserved Caddy label matched
**before** the generic `@named` theia route, and **not** behind the basic-auth gate: the relay
does its own jean-token check on `/subscribe` (timing-safe), and `/key` only returns the public
VAPID key. The browser side is `web/push-init.js` (a `🔔` toolbar button, injected by
`inject-pwa.mjs` like `theia-launch.js`) plus `push` / `notificationclick` handlers added to
`web/sw.js`. Fail-closed and opt-in: `entrypoint.sh` only starts the relay when **`JEAN_TOKEN`**
(needed for the WS + subscriber auth) and **`THEIA_HOST_SUFFIX`** (the wildcard host the button
targets) are both set, and writes `push-config.js` (`window.__PUSH_ENABLED__`) so the button
stays hidden otherwise. Like the IDE, push therefore needs the preview wildcard domain. v1
approval pushes are Codex-only (Claude's permission events aren't separately enumerated in the
jean bundle); Claude is still covered by `chat:done` / `chat:error`.

**Docker-in-Docker.** The image installs the full Docker engine (`docker-ce` + compose/buildx
plugins, plus a `docker-compose` shim for the v1 name). `entrypoint.sh` starts `dockerd` in the
background; it needs the container to run **privileged** (`docker-compose.yml` sets
`privileged: true`, and `/var/lib/docker` is on its own `docker-data` volume). Agents' containers
run inside this container, so ports they publish are reachable through the preview proxy. If the
container isn't privileged, dockerd fails to start and entrypoint logs it but jean still runs.

`entrypoint.sh` flow: set `safe.directory '*'` → start Xvfb → start dockerd (bg) → start preview proxy (caddy, bg) → start Theia IDE (bg) → start push relay (bg, if `JEAN_TOKEN`+`THEIA_HOST_SUFFIX`) →
resolve auth args (`JEAN_TOKEN` set → `--token …`; else jean auto-generates and persists a
token in the workspace volume) → print the login banner (a ready link + `qrencode` QR when
`JEAN_PUBLIC_URL` is set) → `exec jean --headless`. Auth is always on: the wrapper
deliberately does **not** expose jean's `--no-token` flag. `docker-compose.yml` sets `init: true`
so **tini is PID 1** (jean is its child): tini reaps the zombies DinD orphans and forwards
SIGTERM, and it's what makes the health watchdog's `kill 1` actually stop jean for a restart.
Repos are cloned through jean's own UI into `/workspace` (persists). **Git commit identity
is managed entirely by jean's UI** (it reads/writes the global `.gitconfig`); the wrapper
does not touch it.

## Configuration & state

Env vars are documented in `README.md` (`JEAN_REF`, `JEAN_HOST/PORT`, `JEAN_TOKEN`).
`JEAN_REF` is a **build arg**; the rest are runtime env. The workspace path is hardcoded
`/workspace`. `HOME` is set to `/workspace` (in the Dockerfile) so jean's clone/new-project
picker defaults there instead of the **ephemeral** `/root`, and config/creds resolve under it.
State lives in a single named volume at `/workspace`, which therefore also covers `.config`
(jean settings), `.claude`/`.codex` (CLI creds), `.ssh`/`.gitconfig`, and
`.local/share/com.jean.desktop` (jean's data dir). Anything written under `/root` is **not**
persisted. AI CLI auth is established by `exec`ing into the container and running each CLI's
login once - it persists via the volume.

## Security model (important)

The container holds **live Claude/Codex credentials and git push rights** - treat it as
secret-bearing. Never expose port `3456` directly; terminate at an HTTPS reverse proxy
(Coolify). Run **one container per user**. Auth cannot be disabled (no `--no-token`).
Real `/api/*` and `/ws` require the token (401 without); only the static SPA shell is public.
Vulnerability reporting is split between upstream Jean and this wrapper - see `SECURITY.md`.
