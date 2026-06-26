# Security Policy

`jean-dockerized` is a thin packaging wrapper around
[Jean](https://github.com/coollabsio/jean). Jean itself is **not modified or
forked** - it is cloned and built from source by tag. Where you report a
vulnerability depends on which part is affected.

## Reporting a vulnerability in Jean itself

If the issue is in Jean's own code (the Rust HTTP/WS server, token auth, the
web UI, agent orchestration, etc.), report it upstream:

➡️ **https://github.com/coollabsio/jean/security** (or email **security@coollabs.io**)

Do not open a public issue for an undisclosed Jean vulnerability. Use the
upstream private reporting channel above.

## Reporting a vulnerability in this wrapper

If the issue is specific to **this** repository - the `Dockerfile`,
`docker-compose.yml`, `entrypoint.sh`, default configuration, exposed ports,
volume layout, or credential handling - report it privately here:

➡️ **Email hello@spotwhale.com**

Please include:

- affected file(s) and version / git ref (`JEAN_REF`, image tag, commit)
- a description of the impact and a proof-of-concept or reproduction steps
- any suggested remediation

We aim to acknowledge reports within a few days. Please give us a reasonable
window to fix and release before any public disclosure.

> If you are unsure whether a problem lives in Jean or in this wrapper, report
> it here and we will route it upstream if needed.

## Scope reminder

This container holds **live Claude/Codex credentials and git push rights** and
is intended to run behind an HTTPS reverse proxy (e.g. Coolify) with Jean's
token auth enabled. Treat it as secret-bearing:

- never expose port `3456` directly to the internet
- run **one container per user**; do not share an instance
- auth is always on (the wrapper does not expose jean's `--no-token` flag)

See [`README.md`](./README.md) for the full security notes.
