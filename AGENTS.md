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

**Multi-arch.** The image builds for `linux/amd64` **and** `linux/arm64` (release.yml
`platforms:`). The Dockerfile reads buildx's `TARGETARCH` (`amd64`/`arm64`, which match
Debian's arch names and jean's `.deb` asset suffix) to fetch the right jean `.deb` and the
right Docker apt repo. Don't hard-code `amd64` again.

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

**Preview proxy.** A static Caddy binary (`COPY --from=caddy:2`) runs in the background from
`entrypoint.sh`, configured by `proxy/Caddyfile`. It listens on `PREVIEW_PORT` (8088) and maps
the leading numeric label of the Host (`<port>.<anything>`) to `127.0.0.1:<port>` - so dev
servers the agent starts in the container are reachable via a wildcard domain. Traefik/Coolify
terminates TLS and forwards `*.apps.<domain>` → 8088; Caddy speaks plain HTTP (`auto_https off`).
This split exists because Traefik routes host→fixed-port and can't derive the port from the
subdomain. Dev servers must bind `0.0.0.0`. The Caddyfile `import`s `/etc/caddy/auth.import`
for every preview port; `entrypoint.sh` writes that file at startup with a `basic_auth` block
(bcrypt via `caddy hash-password`) when `PREVIEW_PASSWORD` is set, or leaves it empty otherwise.
So setting `PREVIEW_USER`/`PREVIEW_PASSWORD` gates all preview ports behind one login.

**Docker-in-Docker.** The image installs the full Docker engine (`docker-ce` + compose/buildx
plugins, plus a `docker-compose` shim for the v1 name). `entrypoint.sh` starts `dockerd` in the
background; it needs the container to run **privileged** (`docker-compose.yml` sets
`privileged: true`, and `/var/lib/docker` is on its own `docker-data` volume). Agents' containers
run inside this container, so ports they publish are reachable through the preview proxy. If the
container isn't privileged, dockerd fails to start and entrypoint logs it but jean still runs.

`entrypoint.sh` flow: set `safe.directory '*'` → start Xvfb → start dockerd (bg) → start preview proxy (caddy, bg) →
resolve auth args (`JEAN_TOKEN` set → `--token …`; else jean auto-generates and persists a
token in the workspace volume) → `exec jean --headless`. Auth is always on: the wrapper
deliberately does **not** expose jean's `--no-token` flag.
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
