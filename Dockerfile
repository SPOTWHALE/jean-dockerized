# syntax=docker/dockerfile:1

# =========================================================================
# jean-dockerized: run coollabsio/jean headless in a container.
#
# Uses jean's OFFICIAL prebuilt Linux binary from the GitHub release (.deb),
# so there is no Rust/Tauri compile (build takes ~2 min instead of ~15). The
# .deb ships both the `jean` binary and the on-disk frontend `dist`, which is
# exactly what headless mode serves.
#
# JEAN_REF must be a published release tag (e.g. v0.1.57), not a branch.
# =========================================================================

# =========================================================================
# Theia IDE comes from a PREBUILT base image, not an inline build stage.
# Compiling Theia (webpack) on every jean release was the bottleneck - under
# QEMU emulation the arm64 build blew past the 30m Release timeout. It now lives
# in Dockerfile.theia, built once per arch on native runners and published as a
# multi-arch image (see .github/workflows/theia-base.yml). The built app is
# pulled in via `COPY --from=theia` near the end of this file.
#
# THEIA_BASE is the image ref to copy /opt/theia from. It lives in the SAME
# Docker Hub repo as the released image, under a dedicated `theia-base` tag (not
# a separate repo). release.yml pins it to a digest (supply-chain: this image
# carries live Claude/Codex creds + git push, so no mutable tag in CI). Local
# builds default to the tag; rebuild it locally after touching theia/ with:
#   docker build -f Dockerfile.theia -t spotwhale/jean-dockerized:theia-base .
# `--from` can't expand a variable directly, so alias the base image as a stage
# (FROM with a global ARG is allowed) and COPY from that stage name instead.
ARG THEIA_BASE=spotwhale/jean-dockerized:theia-base
FROM ${THEIA_BASE} AS theia

# Base pinned by digest for reproducible/supply-chain-safe builds. This is the
# multi-arch index digest, so buildx still selects the right per-arch image.
# Bump with: docker buildx imagetools inspect debian:bookworm-slim
FROM debian:bookworm-slim@sha256:60eac759739651111db372c07be67863818726f754804b8707c90979bda511df

# Target architecture, populated automatically by buildx (amd64 / arm64). Used
# below to fetch the matching jean .deb and Docker apt repo. Declared early so
# every later stage can read it.
ARG TARGETARCH

# Runtime deps. The Tauri binary initializes a GTK event loop even in
# --headless mode and panics "Failed to initialize GTK" without a display, so
# it needs the GTK/webkit libs + xvfb. Plus git/ssh for repos, curl for the
# health check, and qrencode to render the startup login QR (entrypoint.sh).
# librsvg2-bin (rsvg-convert) is installed only during the PWA step below and
# purged in the same layer so it doesn't land in the final image.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git openssh-client qrencode \
    libssl3 xvfb xauth \
    libwebkit2gtk-4.1-0 librsvg2-2 libayatana-appindicator3-1 libgtk-3-0 \
 && rm -rf /var/lib/apt/lists/*

# Node + the AI CLIs (the agents jean drives); node also runs the PWA injector.
# Node 22 is the current LTS (Node 20 EOL April 2026). CLI versions default to
# latest but can be pinned at build time: --build-arg CLAUDE_CODE_VERSION=0.2.x
ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && npm i -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} @openai/codex@${CODEX_VERSION} \
 && npm cache clean --force \
 && rm -rf /var/lib/apt/lists/*

# Docker engine (Docker-in-Docker) so agents can build/run containers and use
# `docker` / `docker compose` for apps that need it. The daemon is started by
# entrypoint.sh and requires the container to run privileged (see compose).
# Apps the agent runs land inside this container, so their published ports are
# reachable through the preview proxy.
RUN install -m0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=${TARGETARCH} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update && apt-get install -y --no-install-recommends \
      docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
 && rm -rf /var/lib/apt/lists/*
# `docker-compose` (hyphen) shim for tools/scripts that still call the v1 name.
RUN printf '#!/bin/sh\nexec docker compose "$@"\n' > /usr/local/bin/docker-compose \
 && chmod +x /usr/local/bin/docker-compose

# Preview reverse proxy: a static Caddy binary that maps <port>.<domain> to
# 127.0.0.1:<port> so dev servers the agent starts are viewable via a wildcard
# domain. Pulled from the official image (single self-contained binary).
COPY --from=caddy:2.11.4 /usr/bin/caddy /usr/local/bin/caddy
COPY proxy/Caddyfile /etc/caddy/Caddyfile

# Download jean's prebuilt binary for the pinned release and unpack the binary +
# its on-disk frontend. The .deb is named with the version sans leading 'v' and
# the target arch (v0.1.58 -> Jean_0.1.58_amd64.deb / Jean_0.1.58_arm64.deb).
# Debian's arch names (amd64/arm64) match buildx's TARGETARCH exactly. The remote
# ADD re-downloads only when the URL changes (release assets are immutable per
# tag), so it caches well.
ARG JEAN_REF=v0.1.58
ADD https://github.com/coollabsio/jean/releases/download/${JEAN_REF}/Jean_${JEAN_REF#v}_${TARGETARCH}.deb /tmp/jean.deb
ADD https://github.com/coollabsio/jean/releases/download/${JEAN_REF}/Jean_${JEAN_REF#v}_${TARGETARCH}.deb.sig /tmp/jean.deb.sig
# Supply-chain check: this image carries live Claude/Codex creds + git push, so
# the downloaded binary must be authentic. jean signs every release asset with a
# Tauri minisign key; verify the .deb against the pinned public key (jean-release.pub)
# BEFORE unpacking it. The .sig asset is base64-wrapped, so decode it to the raw
# minisign format first. minisign is build-time only and purged in the same layer.
COPY jean-release.pub /tmp/jean-release.pub
RUN apt-get update && apt-get install -y --no-install-recommends minisign \
 && base64 -d /tmp/jean.deb.sig > /tmp/jean.deb.minisig \
 && minisign -Vp /tmp/jean-release.pub -m /tmp/jean.deb -x /tmp/jean.deb.minisig \
 && apt-get purge -y minisign && apt-get autoremove -y && rm -rf /var/lib/apt/lists/* \
 && dpkg-deb -x /tmp/jean.deb /tmp/jean \
 && cp /tmp/jean/usr/bin/jean /usr/local/bin/jean \
 && cp -r /tmp/jean/usr/lib/Jean/dist /usr/local/bin/dist \
 && rm -rf /tmp/jean /tmp/jean.deb /tmp/jean.deb.sig /tmp/jean.deb.minisig /tmp/jean-release.pub \
 && /usr/local/bin/jean --version

# PWA + token-entry injection into the on-disk dist. Makes the headless web UI
# installable (manifest + service worker + icons) and adds a token-entry page,
# since jean's web client only accepts the token via a ?token= URL (no manual
# field). Static assets only; jean's binary/frontend are otherwise untouched.
COPY web/ /tmp/web/
# This image's own release tag (e.g. v0.1.58b), passed by release.yml. When set,
# inject-pwa.mjs bakes it in and ships version-badge.js, which re-points jean's
# version badge to our repo and shows an update pill. Blank on local builds ->
# the badge is left as jean's (the script no-ops without a version).
ARG IMAGE_VERSION=
# Install rsvg-convert (build-time only), render icons, inject PWA tags, then
# purge the package in the same layer so it doesn't land in the final image.
RUN apt-get update && apt-get install -y --no-install-recommends librsvg2-bin \
 && cp /tmp/web/manifest.webmanifest /tmp/web/sw.js /tmp/web/token.html \
      /tmp/web/version-badge.js /tmp/web/theia-launch.js /tmp/web/push-init.js \
      /tmp/web/term-keybar.js /usr/local/bin/dist/ \
 && printf "window.__THEIA_HOST_SUFFIX__=''\n" > /usr/local/bin/dist/theia-config.js \
 && printf "window.__PUSH_ENABLED__=false\n" > /usr/local/bin/dist/push-config.js \
 && rsvg-convert -w 192 -h 192 /tmp/web/icon.svg -o /usr/local/bin/dist/icon-192.png \
 && rsvg-convert -w 512 -h 512 /tmp/web/icon.svg -o /usr/local/bin/dist/icon-512.png \
 && rsvg-convert -w 180 -h 180 /tmp/web/icon.svg -o /usr/local/bin/dist/apple-touch-icon.png \
 && IMAGE_VERSION="$IMAGE_VERSION" node /tmp/web/inject-pwa.mjs /usr/local/bin/dist/index.html \
 && apt-get purge -y librsvg2-bin \
 && rm -rf /var/lib/apt/lists/* /tmp/web

# Bundled Theia IDE, pulled from the prebuilt multi-arch base (Dockerfile.theia,
# published by theia-base.yml). buildx resolves ${THEIA_BASE} to the matching arch.
# Re-declare the ARG here to bring the global default into this stage's scope.
# entrypoint.sh runs the dispatcher (theia-dispatcher.mjs) which lazily spawns one
# Theia per git worktree on 127.0.0.1 and routes <slug>.<preview-wildcard> -> that
# worktree - reached only through the preview proxy, never its own host port.
# THEIA_DEFAULT_PLUGINS points at the (currently empty) bundled plugin dir;
# extensions install at runtime from Open VSX.
COPY --from=theia /opt/theia /opt/theia
# The per-worktree dispatcher (zero-dep node) lives next to the Theia build.
COPY web/theia-dispatcher.mjs /opt/theia/theia-dispatcher.mjs

# Web Push relay (web/push-relay.mjs): observes jean's own WebSocket and sends a
# phone notification when an agent finishes, errors, or needs approval. The
# RFC 8291/8292 crypto is delegated to `web-push` (pinned), installed into a
# dedicated dir the relay resolves `node_modules` from. entrypoint.sh runs it on
# loopback; the browser reaches it through the preview proxy at jdpush.<wildcard>.
COPY web/push-relay.mjs /opt/push/push-relay.mjs
RUN cd /opt/push \
 && npm init -y >/dev/null 2>&1 \
 && npm i web-push@3.6.7 \
 && npm cache clean --force
# THEIA_WEBVIEW_EXTERNAL_ENDPOINT={{hostname}} serves webviews (markdown preview,
# many extensions) from the same origin. The default `{{uuid}}.webview.{{hostname}}`
# needs a per-webview wildcard subdomain, which the numeric-only preview proxy
# can't route - so without this, webviews 404 behind the proxy.
ENV THEIA_PORT=8443 \
    THEIA_DEFAULT_PLUGINS=local-dir:/opt/theia/plugins \
    THEIA_WEBVIEW_EXTERNAL_ENDPOINT={{hostname}}

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# HOME drives where jean's clone/new-project picker defaults and where the AI
# CLIs + jean store config/creds. Point it at /workspace so new repos land on
# the persistent volume by default instead of the ephemeral layer under /root.
ENV HOME=/workspace \
    JEAN_HOST=0.0.0.0 \
    JEAN_PORT=3456 \
    PREVIEW_PORT=8088

WORKDIR /workspace
VOLUME ["/workspace"]
EXPOSE 3456 8088

# Shell form so ${JEAN_PORT} is evaluated at runtime (picks up -e overrides).
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -sf "http://localhost:${JEAN_PORT:-3456}/" > /dev/null

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
