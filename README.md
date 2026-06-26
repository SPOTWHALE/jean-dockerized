# jean-dockerized

[![Docker Pulls](https://img.shields.io/docker/pulls/spotwhale/jean-dockerized?logo=docker)](https://hub.docker.com/r/spotwhale/jean-dockerized)
[![Docker Image Size](https://img.shields.io/docker/image-size/spotwhale/jean-dockerized/latest?logo=docker)](https://hub.docker.com/r/spotwhale/jean-dockerized)
[![GitHub release](https://img.shields.io/github/v/release/SPOTWHALE/jean-dockerized?logo=github)](https://github.com/SPOTWHALE/jean-dockerized/releases)

Run [Jean](https://github.com/coollabsio/jean) in your browser, on your server. Code with Claude and Codex from any device — laptop, phone, tablet — with no local setup.

**PWA-ready.** Install it to your home screen and use it like a native app.

## Features

- **Browser UI** — Jean's full interface served over HTTPS, token-protected
- **Preview URLs** — dev servers the agent starts are instantly reachable at `<port>.apps.your-domain` (same pattern as Codespaces/Gitpod)
- **Docker-in-Docker** — agents can run `docker` and `docker compose`; requires `privileged: true`
- **amd64 + arm64** — one image runs on x86 servers and ARM (Apple Silicon, Ampere/Graviton, Raspberry Pi)
- **Persistent workspace** — repos, credentials, and settings survive redeploys
- **Auto-updates** — watches Jean releases daily and rebuilds automatically

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
4. Deploy, open your domain, and enter the token from the logs — or set a fixed one with `JEAN_TOKEN`

## Run locally

```bash
cp .env.example .env   # optional — set JEAN_TOKEN / preview auth
docker compose up
# open the ?token=... URL printed in the logs
```

**Lost or changed your token?** Open `https://your-domain/token.html?reset` to clear
the saved token and type a new one — works inside the installed PWA too.

## Preview URLs

When an agent starts a dev server, reach it at `https://<port>.apps.your-domain`.

Setup (Coolify):
1. Wildcard TLS needs a **DNS-01** challenge — add your DNS provider token in Coolify/Traefik
2. The agent must bind to `0.0.0.0`, e.g. `vite --host` or `php artisan serve --host 0.0.0.0 --port 8000`

> Preview subdomains have no token. Set `PREVIEW_USER` + `PREVIEW_PASSWORD` to gate them behind basic auth.

## Security

- Always access through HTTPS — never expose port `3456` directly
- One container per person — it holds live AI credentials and git push access
- **Runs `privileged`** (required for Docker-in-Docker) — the container has host-level access. Treat it as trusted, single-tenant. Do **not** pack multiple users' containers onto one shared host; a privileged container can escape to the host and reach every other container on it.
- Jean's web UI is token-protected; preview ports can be gated with `PREVIEW_PASSWORD`
- The build verifies Jean's release `.deb` against its signing key (minisign) before baking it into the image, so a tampered release asset can't reach your credentials

### Multi-tenant / untrusted use

`privileged` is unsafe when many people share one host. To run a container per tenant safely, drop `privileged` and use a host runtime that gives Docker-in-Docker with real isolation:

- **[Sysbox](https://github.com/nestybox/sysbox)** — install `sysbox-ce` on the host, then run with `runtime: sysbox-runc` and **no** `privileged`. The same image works unchanged:

  ```yaml
  services:
    jean:
      image: spotwhale/jean-dockerized
      runtime: sysbox-runc   # replaces privileged: true
  ```

- **VM per tenant** (Firecracker, or one cloud VM each) — strongest isolation; `privileged` stays safe because each tenant has its own kernel.

Sysbox is a **host-installed runtime**, not part of the image — it can't be bundled, since the runtime is what launches the container. Test your agent's Docker workflows under it; most `docker build`/`compose` works, a few deeply privileged ops don't.

## Settings

| Env | Default | Description |
|-----|---------|-------------|
| `JEAN_TOKEN` | auto-generated | Fixed access token (persisted in the workspace volume if unset) |
| `JEAN_PORT` | `3456` | Jean web UI port |
| `PREVIEW_PORT` | `8088` | Preview reverse-proxy port |
| `PREVIEW_USER` | `dev` | Username for preview basic auth |
| `PREVIEW_PASSWORD` | unset | Enables basic auth on all preview subdomains |
