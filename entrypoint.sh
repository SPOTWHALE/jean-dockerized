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
  else
    echo "[entrypoint] dockerd did not start (is the container privileged?) - continuing without docker"
  fi
fi

# Preview reverse proxy: maps <port>.<domain> -> 127.0.0.1:<port> so dev servers
# the agent starts are viewable through a wildcard domain. Runs in the background
# (jean stays PID 1 via the exec below). Optional - skipped if caddy is absent.
if command -v caddy >/dev/null 2>&1 && [ -f /etc/caddy/Caddyfile ]; then
  # The Caddyfile imports /etc/caddy/auth.import for every preview port. Fill it
  # with a basic_auth block when PREVIEW_PASSWORD is set, else leave it empty.
  : > /etc/caddy/auth.import
  if [ -n "${PREVIEW_PASSWORD:-}" ]; then
    HASH="$(caddy hash-password --plaintext "${PREVIEW_PASSWORD}")"
    printf 'basic_auth {\n  %s %s\n}\n' "${PREVIEW_USER:-dev}" "${HASH}" > /etc/caddy/auth.import
    echo "[entrypoint] preview proxy: basic auth ON (user ${PREVIEW_USER:-dev})"
  else
    echo "[entrypoint] preview proxy: basic auth OFF (set PREVIEW_PASSWORD to enable)"
  fi
  echo "[entrypoint] starting preview proxy on :${PREVIEW_PORT:-8088}"
  caddy run --config /etc/caddy/Caddyfile --adapter caddyfile >/tmp/caddy.log 2>&1 &
  CADDY_PID=$!
  sleep 2
  if ! kill -0 "$CADDY_PID" 2>/dev/null; then
    echo "[entrypoint] WARNING: caddy exited immediately (bad Caddyfile?) — preview proxy unavailable" >&2
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

# Auth: jean generates+persists a token by default (in the workspace volume).
# Override with a stable token via JEAN_TOKEN. Auth is always on by design --
# this wrapper deliberately does not expose jean's --no-token flag.
AUTH_ARGS=()
if [ -n "${JEAN_TOKEN:-}" ]; then
  AUTH_ARGS=(--token "${JEAN_TOKEN}")
fi

# Health watchdog: docker's HEALTHCHECK reports status but restart: unless-stopped
# only acts on container exit, not unhealthy. This watchdog kills PID 1 (jean)
# after 3 consecutive failed checks so Docker's restart policy can recover it.
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

echo "[entrypoint] starting jean headless on ${JEAN_HOST}:${JEAN_PORT}"
exec jean --headless --host "${JEAN_HOST}" --port "${JEAN_PORT}" "${AUTH_ARGS[@]}"
