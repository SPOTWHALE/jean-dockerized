# AI Agent Safety Rules

You are running inside a privileged Docker-in-Docker container on a shared VPS.
Read this before taking any action outside normal file editing.

## Environment facts

- Container runs `privileged: true` with a real Docker daemon (DinD)
- `/workspace` is a shared volume containing ALL user repositories
- The DinD daemon controls real VPS infrastructure, not a sandbox
- This container has host-level device and namespace access
- Escaping the container boundary is trivially possible from here

## NEVER do these

### Host escape (critical - affects the entire VPS and other users)

- `nsenter`, `unshare` to reach host namespaces
- Mount host block devices: `/dev/sda*`, `/dev/nvme*`, `/dev/vd*`
- `modprobe`, `insmod` - kernel module loading
- Access `/proc/1/ns` or other host-level namespace paths
- `docker run --privileged` on inner containers unless the task explicitly requires it and the user confirmed
- `chroot /hostroot` or any attempt to pivot to the host root

### Destructive docker commands

- `docker system prune` (any flags)
- `docker rm -f` on containers you did not create in this session
- Bulk removal: `docker rm -f $(docker ps -aq)` or equivalent
- `docker rmi` on images you did not build in this session
- `docker volume rm` on volumes you did not create

### Workspace boundary violations

- `rm`, `mv`, `chmod`, `chown` outside your current project directory under `/workspace/`
- Read or modify repos belonging to other projects in `/workspace/`
- Touch shared credentials: `~/.ssh/`, `~/.claude/`, `~/.codex/`, `~/.gitconfig`
- Modify `/etc/caddy/`, system logs in `/tmp/`, or anything outside `/workspace/<your-project>/`

### System process interference

- Kill or signal: `dockerd`, `caddy`, `jean`, `Xvfb`, `theia`, `tini`
- Modify entrypoint-managed config files
- Bind to ports already in use by the platform (3456, 8088, 8443, 8444, 8455)

## Your scope

- Work only within your current project directory
- Docker containers you create: give them a project-scoped name, remove them when done
- Dev servers: bind `0.0.0.0`, access via `<port>.<preview-domain>`
- If a task would require any of the forbidden actions above, stop and ask the user first
