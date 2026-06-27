# jean-dockerized

[![Docker Pulls](https://img.shields.io/docker/pulls/spotwhale/jean-dockerized?logo=docker)](https://hub.docker.com/r/spotwhale/jean-dockerized)
[![Docker Image Size](https://img.shields.io/docker/image-size/spotwhale/jean-dockerized/latest?logo=docker)](https://hub.docker.com/r/spotwhale/jean-dockerized)
[![GitHub release](https://img.shields.io/github/v/release/SPOTWHALE/jean-dockerized?logo=github)](https://github.com/SPOTWHALE/jean-dockerized/releases)
[![Image status](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2FSPOTWHALE%2Fjean-dockerized%2Fbadges%2Fimage-status.json&logo=docker)](https://github.com/SPOTWHALE/jean-dockerized/actions/workflows/release.yml)

Run [Jean](https://github.com/coollabsio/jean) in your browser, on your server. Code with Claude and Codex from any device - laptop, phone, tablet - with no local setup.

**PWA-ready.** Install it to your home screen and use it like a native app.

## Features

- **Browser UI** - Jean's full interface served over HTTPS, token-protected
- **Built-in IDE** - a bundled [Eclipse Theia](https://theia-ide.org/) editor (files, terminal, git, extensions) one tap away, no extra port
- **Preview URLs** - dev servers the agent starts are instantly reachable at `<port>.apps.your-domain` (same pattern as Codespaces/Gitpod)
- **Docker-in-Docker** - agents can run `docker` and `docker compose`; requires `privileged: true`
- **amd64 + arm64** - one image runs on x86 servers and ARM (Apple Silicon, Ampere/Graviton, Raspberry Pi)
- **Persistent workspace** - repos, credentials, and settings survive redeploys
- **Auto-updates** - watches Jean releases daily and rebuilds automatically

## Screenshots

<table>
<tr>
<td><img src="https://github.com/user-attachments/assets/b9e0c516-cd6d-4b12-af3e-4e78e7bfb3fb" height="500" alt="Screenshot 1" /></td>
<td><img src="https://github.com/user-attachments/assets/ca60e4a5-0b7b-49a2-b33c-da25cd91df6a" height="500" alt="Screenshot 2" /></td>
<td><img src="https://github.com/user-attachments/assets/3b84866b-ba31-44eb-898a-3ade7786bd07" height="500" alt="Screenshot 3" /></td>
<td><img src="https://github.com/user-attachments/assets/74bfc430-8318-4887-b2b0-d78a66a24a15" height="500" alt="Screenshot 4" /></td>
<td><img src="https://github.com/user-attachments/assets/1ddc533d-cbcc-4258-a9e0-932e424b201b" height="500" alt="Screenshot 5" /></td>
</tr>
</table>

## Deploy on Coolify

1. **New Resource → Docker Compose**, paste [`docker-compose.yml`](./docker-compose.yml)
2. Set the domains to `https://jean.example.com:3456,https://*.jean.example.com:8088`
3. Add two A records in your DNS pointing to your server's IP (e.g. `jean` and `*.jean`)
4. Deploy, open your domain, and enter the token from the logs - or set a fixed one with `JEAN_TOKEN`

<details>
<summary><strong>Previews/IDE return <code>503 no available server</code>?</strong></summary>

Coolify's auto-generated Traefik labels drop the load-balancer port on the **HTTPS
wildcard** service when one container serves two ports (3456 + 8088) plus a wildcard
domain, so the app on `jean.example.com` works but every `*.jean.example.com` 503s.

Fix: **clear the Domains field** in Coolify (so it stops generating the broken labels)
and route by hand with the commented `labels:` block in
[`docker-compose.yml`](./docker-compose.yml) - stable, redeploy-proof names. These are
Traefik-only; other proxies ignore them.

If a proxied host is served by **Cloudflare** (orange cloud), note Universal SSL covers
only `example.com` + `*.example.com` (one level) - a 3-level host like
`*.jean.example.com` needs Total TLS / Advanced Certificate Manager, or grey-cloud the
record so Traefik terminates TLS itself.

</details>

## Run locally

```bash
cp .env.example .env   # optional - set JEAN_TOKEN / preview auth
docker compose up
# open the ?token=... URL printed in the logs
```

**Lost or changed your token?** Open `https://your-domain/token.html?reset` to clear
the saved token, then paste your access token again (from the logs or `JEAN_TOKEN`).
Works inside the installed PWA too. The page only stores the token in your browser; it
grants nothing on its own, since Jean's backend still validates it on every request.

## Preview URLs

When an agent starts a dev server, reach it at `https://<port>.apps.your-domain`.

Setup (Coolify):
1. Wildcard TLS needs a **DNS-01** challenge - add your DNS provider token in Coolify/Traefik
2. The agent must bind to `0.0.0.0`, e.g. `vite --host` or `php artisan serve --host 0.0.0.0 --port 8000`

> Preview subdomains are **disabled (403) until you set `PREVIEW_PASSWORD`**, which gates every preview port behind one basic-auth login (`PREVIEW_USER` defaults to `dev`). This fails closed so a misconfigured deploy never exposes loopback ports to the internet.

## Built-in IDE

<details>
<summary><strong>Per-worktree Theia editor</strong></summary>

A full [Eclipse Theia](https://theia-ide.org/) editor (file tree, integrated
terminal, git, search, and Open VSX extensions) ships inside the image. A floating
**`</> IDE`** button in Jean's web UI opens it in a new tab.

The IDE is **scoped per git worktree**: a dispatcher lazily runs one Theia per
repo/branch worktree (rooted at that directory, idle-reaped) and routes by hostname
through the **same preview proxy** as dev servers - never on its own host port:

- `https://ide.<your-wildcard-domain>` - a picker listing every repo › branch worktree under `/workspace`
- `https://<repo>-<branch>.<your-wildcard-domain>` - that worktree's scoped editor

The `</> IDE` button reads Jean's active repo/branch and opens that worktree directly,
falling back to the picker when nothing is open.

Setup:
1. It is gated by the preview proxy, so it is **only reachable once `PREVIEW_PASSWORD`
   is set** (same basic-auth login as previews; fails closed otherwise).
2. Set `THEIA_HOST_SUFFIX` to your preview-wildcard host (everything after the leading
   label, e.g. `.apps.you.dev`) so the button builds correct links. Empty falls back to
   `.<current-host>`.

> **Cosmetic scoping, not a security boundary.** Each Theia only roots the sidebar at
> one worktree; its integrated terminal still runs as root and can reach all of
> `/workspace`. Real isolation needs a container per repo. Theia shares `/workspace`
> with Jean and the agents, and its settings persist on the volume (`HOME=/workspace`).

</details>

## Security

<details>
<summary><strong>Hardening checklist</strong></summary>

- Always access through HTTPS. Never expose port `3456` directly.
- One container per person: it holds live AI credentials and git push access.
- **Runs `privileged`** (required for Docker-in-Docker): the container has host-level access. Treat it as trusted, single-tenant. Do **not** pack multiple users' containers onto one shared host; a privileged container can escape to the host and reach every other container on it.
- Jean's web UI is token-protected; preview ports can be gated with `PREVIEW_PASSWORD`.
- The build verifies Jean's release `.deb` against its signing key (minisign) before baking it into the image, so a tampered release asset can't reach your credentials.

</details>

<details>
<summary><strong>Multi-tenant / untrusted use</strong></summary>

`privileged` is unsafe when many people share one host. To run a container per tenant safely, drop `privileged` and use a host runtime that gives Docker-in-Docker with real isolation:

- **[Sysbox](https://github.com/nestybox/sysbox)**: install `sysbox-ce` on the host, then run with `runtime: sysbox-runc` and **no** `privileged`. The same image works unchanged:

  ```yaml
  services:
    jean:
      image: spotwhale/jean-dockerized
      runtime: sysbox-runc   # replaces privileged: true
  ```

- **VM per tenant** (Firecracker, or one cloud VM each): strongest isolation; `privileged` stays safe because each tenant has its own kernel.

Sysbox is a **host-installed runtime**, not part of the image: it can't be bundled, since the runtime is what launches the container. Test your agent's Docker workflows under it; most `docker build`/`compose` works, a few deeply privileged ops don't.

</details>

## Settings

| Env | Default | Description |
|-----|---------|-------------|
| `JEAN_TOKEN` | auto-generated | Fixed access token (persisted in the workspace volume if unset) |
| `JEAN_PUBLIC_URL` | unset | Public URL of this instance; when set, the startup banner prints a ready login link + QR |
| `JEAN_PORT` | `3456` | Jean web UI port |
| `PREVIEW_PORT` | `8088` | Preview reverse-proxy port |
| `PREVIEW_USER` | `dev` | Username for preview basic auth |
| `PREVIEW_PASSWORD` | unset | Required to enable previews **and the IDE**; gates all preview subdomains behind basic auth (unset = 403) |
| `THEIA_HOST_SUFFIX` | unset | Preview-wildcard host the `</> IDE` button targets (e.g. `.apps.you.dev`); empty falls back to `.<current-host>` |
| `THEIA_DISPATCH_PORT` | `8444` | Internal loopback port for the per-worktree Theia dispatcher; reached via the preview proxy, never exposed directly |
