#!/usr/bin/env bash
set -euo pipefail

JEAN_HOST="${JEAN_HOST:-0.0.0.0}"
JEAN_PORT="${JEAN_PORT:-3456}"

# Put the per-user bin dir on PATH so tools jean installs at runtime are found
# when it spawns them. RTK and similar installers drop their binary in
# $HOME/.local/bin (HOME=/workspace); without this, `rtk init` fails with
# "No such file or directory (os error 2)". jean's child processes inherit this.
export PATH="${HOME:-/workspace}/.local/bin:${PATH}"

# Git commit identity is managed entirely by jean's own UI (persisted to the
# global .gitconfig in the workspace volume), so the wrapper does not touch it.
# Repos live in subdirs of the workspace; '*' covers them. --replace-all keeps it
# from accumulating duplicate entries across restarts.
git config --global --replace-all safe.directory '*' || true

# Write AI agent safety rules at startup so they apply to every repo cloned
# under /workspace/. Claude Code picks up ~/.claude/CLAUDE.md (HOME=/workspace)
# globally; Codex gets the rules appended to /workspace/AGENTS.md once.
# Source is /app/agent-safety.md (baked into the image); rewriting on each
# start keeps the rules in sync with the image version.
if [ -f /app/agent-safety.md ]; then
  mkdir -p /workspace/.claude
  cp /app/agent-safety.md /workspace/.claude/CLAUDE.md
  # Append to AGENTS.md (Codex) if safety rules not already present
  if ! grep -qF "AI Agent Safety Rules" /workspace/AGENTS.md 2>/dev/null; then
    { echo; echo "---"; cat /app/agent-safety.md; } >> /workspace/AGENTS.md
  fi
  echo "[entrypoint] wrote AI agent safety rules to /workspace/.claude/CLAUDE.md + appended to /workspace/AGENTS.md"
fi

# Tailscale: OPTIONAL "no domain" on-ramp. Set TS_AUTHKEY to join the container
# to your tailnet; then reach Jean at <tailscale-ip>:${JEAN_PORT} and any agent
# dev server at <tailscale-ip>:<its-port> directly - no domain, SSL, or proxy.
# The container is privileged, so use kernel networking (needs /dev/net/tun),
# which exposes 0.0.0.0-bound services (jean, dev servers) on the tailnet IP.
# State persists on the workspace volume so the node keeps its identity across
# restarts. The IDE/wildcard-preview features still need the domain+Caddy path.
if [ -n "${TS_AUTHKEY:-}" ] && command -v tailscaled >/dev/null 2>&1; then
  mkdir -p /dev/net /workspace/.tailscale /var/run/tailscale
  [ -c /dev/net/tun ] || mknod /dev/net/tun c 10 200 || \
    echo "[entrypoint] WARNING: could not create /dev/net/tun (not privileged?)" >&2
  echo "[entrypoint] starting tailscaled"
  tailscaled --state=/workspace/.tailscale/tailscaled.state \
    --socket=/var/run/tailscale/tailscaled.sock >/tmp/tailscaled.log 2>&1 &
  for _ in $(seq 1 40); do [ -S /var/run/tailscale/tailscaled.sock ] && break; sleep 0.25; done
  # --timeout so a blocked outbound (firewalled host, controlplane unreachable) can't
  # wedge startup: tailscale up returns after 30s and we fall through to launch jean.
  # Without it a network problem would hang the entrypoint and jean would never start.
  if tailscale up --authkey="${TS_AUTHKEY}" --hostname="${TS_HOSTNAME:-jean}" --timeout=30s >/tmp/tailscale-up.log 2>&1; then
    TS_IP="$(tailscale ip -4 2>/dev/null | head -n1)"
    echo "[entrypoint] tailscale up - reach Jean at http://${TS_IP:-<tailscale-ip>}:${JEAN_PORT}"
  else
    echo "[entrypoint] WARNING: tailscale up failed/timed out - continuing without it." >&2
    echo "[entrypoint]   Common causes: blocked outbound to controlplane.tailscale.com," >&2
    echo "[entrypoint]   an expired/used auth key, or the host kernel missing the 'tun'" >&2
    echo "[entrypoint]   module (load it on the HOST - this container won't modprobe it)." >&2
    echo "[entrypoint]   Jean is still reachable via the domain path / published ports." >&2
    cat /tmp/tailscale-up.log >&2
  fi
fi

# jean inits a GTK event loop even in --headless, so it needs a display.
# Start Xvfb explicitly (xvfb-run is unreliable as PID 1) and point DISPLAY at it.
echo "[entrypoint] starting Xvfb on :99"
Xvfb :99 -screen 0 1024x768x16 -nolisten tcp >/tmp/xvfb.log 2>&1 &
export DISPLAY=:99
# wait for the X socket to appear (max ~5s)
for _ in $(seq 1 50); do
  [ -e /tmp/.X11-unix/X99 ] && break
  sleep 0.1
done
if [ ! -e /tmp/.X11-unix/X99 ]; then
  echo "[entrypoint] ERROR: Xvfb failed to start" >&2
  cat /tmp/xvfb.log >&2
  exit 1
fi
echo "[entrypoint] Xvfb ready"

# Docker-in-Docker: start the daemon so agents can build/run containers and use
# `docker` / `docker compose`. Needs a privileged container; if the kernel won't
# allow it, we log and carry on (jean itself still works). Skipped if dockerd is
# absent or already running (e.g. a mounted host socket).
if command -v dockerd >/dev/null 2>&1 && ! docker info >/dev/null 2>&1; then
  echo "[entrypoint] starting dockerd"
  : > /var/log/dockerd.log  # truncate so log doesn't grow unboundedly across restarts
  dockerd --log-level warn >/var/log/dockerd.log 2>&1 &
  for _ in $(seq 1 40); do docker info >/dev/null 2>&1 && break; sleep 0.5; done
  if docker info >/dev/null 2>&1; then
    echo "[entrypoint] docker ready"
    # Watchdog: restart dockerd if it dies at runtime (parity with the caddy
    # watchdog below), so agents' `docker` commands keep working after a crash.
    ( while sleep 15; do
        docker info >/dev/null 2>&1 && continue
        echo "[entrypoint] dockerd died, restarting" >&2
        dockerd --log-level warn >>/var/log/dockerd.log 2>&1 &
        for _ in $(seq 1 40); do docker info >/dev/null 2>&1 && break; sleep 0.5; done
      done ) &
  else
    echo "[entrypoint] dockerd did not start (is the container privileged?) - continuing without docker"
  fi
fi

# Preview reverse proxy: maps <port>.<domain> -> 127.0.0.1:<port> so dev servers
# the agent starts are viewable through a wildcard domain. Runs in the background
# (jean stays PID 1 via the exec below). Optional - skipped if caddy is absent.
if command -v caddy >/dev/null 2>&1 && [ -f /etc/caddy/Caddyfile ]; then
  # The Caddyfile imports /etc/caddy/auth.import inside every preview port's route.
  # Fail CLOSED: a basic_auth gate when PREVIEW_PASSWORD is set, otherwise a flat
  # 403 so previews are never open to the internet by accident. Guard the
  # hash-password call so a transient failure can't abort the whole entrypoint
  # (set -e) before jean even starts.
  : > /etc/caddy/auth.import
  if [ -n "${PREVIEW_PASSWORD:-}" ]; then
    if HASH="$(caddy hash-password --plaintext "${PREVIEW_PASSWORD}" 2>/dev/null)"; then
      printf 'basic_auth {\n  %s %s\n}\n' "${PREVIEW_USER:-dev}" "${HASH}" > /etc/caddy/auth.import
      echo "[entrypoint] preview proxy: basic auth ON (user ${PREVIEW_USER:-dev})"
    else
      printf 'respond "Preview disabled (password hashing failed)." 403\n' > /etc/caddy/auth.import
      echo "[entrypoint] WARNING: caddy hash-password failed; previews disabled (403)" >&2
    fi
  else
    printf 'respond "Preview disabled. Set PREVIEW_PASSWORD to enable preview URLs." 403\n' > /etc/caddy/auth.import
    echo "[entrypoint] preview proxy: DISABLED (set PREVIEW_PASSWORD to enable)"
  fi
  echo "[entrypoint] starting preview proxy on :${PREVIEW_PORT:-8088}"
  caddy run --config /etc/caddy/Caddyfile --adapter caddyfile >/tmp/caddy.log 2>&1 &
  CADDY_PID=$!
  sleep 2
  if ! kill -0 "$CADDY_PID" 2>/dev/null; then
    echo "[entrypoint] WARNING: caddy exited immediately (bad Caddyfile?), preview proxy unavailable" >&2
    cat /tmp/caddy.log >&2
  else
    echo "[entrypoint] preview proxy ready"
    # Watchdog: restart caddy if it crashes at runtime.
    ( while sleep 15; do
        kill -0 "$CADDY_PID" 2>/dev/null && continue
        echo "[entrypoint] caddy died, restarting" >&2
        caddy run --config /etc/caddy/Caddyfile --adapter caddyfile >>/tmp/caddy.log 2>&1 &
        CADDY_PID=$!
      done ) &
  fi
fi

# Theia IDE: per-worktree scoped editors via the dispatcher (web/theia-dispatcher.mjs).
# One Theia can only have one workspace root, so to scope the sidebar per repo/branch we
# run a Theia per git worktree, lazily. The dispatcher (127.0.0.1:${THEIA_DISPATCH_PORT})
# routes by hostname: <slug>.<preview-wildcard> -> that worktree's Theia, ide.<wildcard>
# -> a picker. It is reachable ONLY through the preview proxy (Caddy forwards every
# non-numeric leading label here, behind the same basic-auth gate). COSMETIC scoping
# only - NOT a security boundary (a Theia's terminal still reaches all of /workspace).
# HOME=/workspace, so Theia settings persist on the volume. Skipped if app/node absent.
#
# Preview-wildcard host suffix (everything after the leading label) used by the IDE
# button, previews, and push to build <label>.<suffix>. This image assumes a
# single-wildcard deploy - the app and its preview subdomains live under one host
# (app jean.example.com, previews/IDE/push *.jean.example.com) - so the suffix is
# just JEAN_PUBLIC_URL's host. No separate env: set JEAN_PUBLIC_URL and the IDE,
# previews, and push all derive it. Unset -> empty, and the injected client falls
# back to ".<current-host>" (correct in a single-wildcard deploy anyway).
HOST_SUFFIX=""
if [ -n "${JEAN_PUBLIC_URL:-}" ]; then
  _h="${JEAN_PUBLIC_URL#*://}"   # strip scheme
  _h="${_h%%/*}"                 # strip path
  HOST_SUFFIX=".${_h}"
fi
THEIA_DISPATCH_PORT="${THEIA_DISPATCH_PORT:-8444}"
if [ -f /opt/theia/src-gen/backend/main.js ] && [ -f /opt/theia/theia-dispatcher.mjs ] && command -v node >/dev/null 2>&1; then
  # Tell the injected launcher (web/theia-launch.js) the preview-wildcard host suffix
  # it uses to build <slug>.<suffix> (e.g. .jean.example.com). Derived from
  # JEAN_PUBLIC_URL above; empty -> the button falls back to ".<current-host>".
  # JSON-encoded via node to avoid shell-quoting pitfalls.
  # Tailscale path: bind the dispatcher + its Theia instances to 0.0.0.0 so the IDE
  # is reachable at <tailscale-ip>:<port> (the button targets /__open, which redirects
  # to the worktree's own instance port). Loopback-only otherwise (reached via Caddy).
  if [ -n "${TS_AUTHKEY:-}" ]; then
    THEIA_DISPATCH_HOST=0.0.0.0
    THEIA_INSTANCE_HOST=0.0.0.0
  else
    THEIA_DISPATCH_HOST=127.0.0.1
    THEIA_INSTANCE_HOST=127.0.0.1
  fi
  DIST=/usr/local/bin/dist
  if [ -d "$DIST" ]; then
    printf "window.__THEIA_HOST_SUFFIX__=%s\n" \
      "$(JD_SUFFIX="$HOST_SUFFIX" node -e 'process.stdout.write(JSON.stringify(process.env.JD_SUFFIX||""))')" \
      > "$DIST/theia-config.js"
    # Publish the dispatcher port to the IDE button only on the Tailscale path, so it
    # switches to direct-port routing when opened over a tailnet IP.
    if [ -n "${TS_AUTHKEY:-}" ]; then
      printf "window.__THEIA_DISPATCH_PORT__=%s\n" "${THEIA_DISPATCH_PORT}" >> "$DIST/theia-config.js"
    fi
  fi

  echo "[entrypoint] starting Theia dispatcher on ${THEIA_DISPATCH_HOST}:${THEIA_DISPATCH_PORT}"
  start_theia_dispatch() {
    THEIA_DISPATCH_PORT="${THEIA_DISPATCH_PORT}" \
    THEIA_DISPATCH_HOST="${THEIA_DISPATCH_HOST}" \
    THEIA_INSTANCE_HOST="${THEIA_INSTANCE_HOST}" \
    THEIA_MAIN=/opt/theia/src-gen/backend/main.js \
    THEIA_WORKSPACE=/workspace \
      node /opt/theia/theia-dispatcher.mjs >/tmp/theia-dispatcher.log 2>&1 &
    THEIA_DISPATCH_PID=$!
  }
  start_theia_dispatch
  sleep 1
  if ! kill -0 "$THEIA_DISPATCH_PID" 2>/dev/null; then
    echo "[entrypoint] WARNING: Theia dispatcher exited immediately, IDE unavailable" >&2
    cat /tmp/theia-dispatcher.log >&2
  else
    echo "[entrypoint] Theia dispatcher ready"
    # Watchdog: restart the dispatcher if it crashes (parity with caddy/dockerd).
    ( while sleep 15; do
        kill -0 "$THEIA_DISPATCH_PID" 2>/dev/null && continue
        echo "[entrypoint] Theia dispatcher died, restarting" >&2
        start_theia_dispatch
      done ) &
  fi
fi

# Web Push notifications: a relay (web/push-relay.mjs) observes jean's own
# WebSocket and pushes a phone notification when an agent finishes, errors, or
# needs approval - closing the async "fire a task, pocket the phone" loop.
# Reached by the browser through the preview proxy at jdpush.<preview-wildcard>
# (see proxy/Caddyfile @push), so it needs the wildcard host the IDE/previews use -
# which is derived from JEAN_PUBLIC_URL (HOST_SUFFIX above). So setting JEAN_PUBLIC_URL
# is what enables push. The relay resolves jean's token itself: JEAN_TOKEN if you set
# one, otherwise jean's auto-generated, persisted http_server_token (it polls the
# prefs file for it). So push works out of the box with the generated token. The
# injected button (push-init.js) stays hidden unless push-config.js below enables it.
PUSH_PORT="${PUSH_PORT:-8455}"
DIST=/usr/local/bin/dist
if [ -d "$DIST" ]; then
  if [ -n "$HOST_SUFFIX" ]; then
    printf "window.__PUSH_ENABLED__=true\n" > "$DIST/push-config.js"
  else
    printf "window.__PUSH_ENABLED__=false\n" > "$DIST/push-config.js"
  fi
fi
if [ -f /opt/push/push-relay.mjs ] && command -v node >/dev/null 2>&1; then
  if [ -z "$HOST_SUFFIX" ]; then
    echo "[entrypoint] push notifications: DISABLED (set JEAN_PUBLIC_URL to enable)"
  else
    echo "[entrypoint] starting push relay on 127.0.0.1:${PUSH_PORT}"
    start_push_relay() {
      JEAN_TOKEN="${JEAN_TOKEN:-}" JEAN_PORT="${JEAN_PORT}" PUSH_PORT="${PUSH_PORT}" \
        node /opt/push/push-relay.mjs >/tmp/push-relay.log 2>&1 &
      PUSH_PID=$!
    }
    start_push_relay
    sleep 1
    if ! kill -0 "$PUSH_PID" 2>/dev/null; then
      echo "[entrypoint] WARNING: push relay exited immediately, notifications unavailable" >&2
      cat /tmp/push-relay.log >&2
    else
      echo "[entrypoint] push relay ready"
      # Watchdog: restart the relay if it crashes (parity with caddy/dockerd/theia).
      ( while sleep 15; do
          kill -0 "$PUSH_PID" 2>/dev/null && continue
          echo "[entrypoint] push relay died, restarting" >&2
          start_push_relay
        done ) &
    fi
  fi
fi

# Auth: jean generates+persists a token by default (in the workspace volume).
# Override with a stable token via JEAN_TOKEN. Auth is always on by design --
# this wrapper deliberately does not expose jean's --no-token flag.
AUTH_ARGS=()
if [ -n "${JEAN_TOKEN:-}" ]; then
  AUTH_ARGS=(--token "${JEAN_TOKEN}")
fi

# Health watchdog: docker's HEALTHCHECK reports status but restart: unless-stopped
# only acts on container exit, not unhealthy. This watchdog signals PID 1 (tini,
# via `init: true`) after 3 consecutive failed checks; tini forwards SIGTERM to
# jean so it exits and Docker's restart policy can recover it.
( failed=0
  while sleep 30; do
    if curl -sf "http://localhost:${JEAN_PORT}/" >/dev/null 2>&1; then
      failed=0
    else
      failed=$((failed + 1))
      echo "[entrypoint] health check failed (${failed}/3)" >&2
      if [ "$failed" -ge 3 ]; then
        echo "[entrypoint] jean unhealthy, killing PID 1 to trigger restart" >&2
        kill 1
        break
      fi
    fi
  done ) &

# Onboarding banner: the hardest first-run step is getting the token into the
# browser (worse on a phone). Print a clear box, and when JEAN_PUBLIC_URL is set
# build a ready login link (token prefilled if JEAN_TOKEN is set) plus a scannable
# QR so phone onboarding is "point camera, you're in". Without JEAN_TOKEN the
# token is jean's auto-generated one, which jean prints to stdout on startup.
print_login_banner() {
  local base url
  echo "============================================================"
  echo "  Jean is starting (headless web)."
  if [ -n "${JEAN_PUBLIC_URL:-}" ]; then
    base="${JEAN_PUBLIC_URL%/}"
    if [ -n "${JEAN_TOKEN:-}" ]; then
      url="${base}/token.html?token=${JEAN_TOKEN}"
      echo "  Open this link to log in (token prefilled):"
    else
      url="${base}/token.html"
      echo "  Open the access page, then paste the token jean prints below:"
    fi
    echo "    ${url}"
    if command -v qrencode >/dev/null 2>&1; then
      echo
      qrencode -t UTF8 -m 1 "${url}" 2>/dev/null || true
    fi
  elif [ -z "${TS_IP:-}" ]; then
    echo "  Set JEAN_PUBLIC_URL (e.g. https://jean.example.com) to print a ready"
    echo "  login link + QR here. Otherwise open your domain and paste the token."
  fi
  if [ -n "${TS_IP:-}" ]; then
    if [ -n "${JEAN_TOKEN:-}" ]; then
      echo "  Tailscale: http://${TS_IP}:${JEAN_PORT}/token.html?token=${JEAN_TOKEN}"
    else
      echo "  Tailscale: http://${TS_IP}:${JEAN_PORT}/token.html (paste token below)"
    fi
  fi
  if [ -n "${JEAN_TOKEN:-}" ]; then
    echo "  Access token: ${JEAN_TOKEN}"
  fi
  echo "============================================================"
}
print_login_banner

echo "[entrypoint] starting jean headless on ${JEAN_HOST}:${JEAN_PORT}"
exec jean --headless --host "${JEAN_HOST}" --port "${JEAN_PORT}" "${AUTH_ARGS[@]}"
