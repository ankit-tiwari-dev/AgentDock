---
name: agentdock-docker
description: Use when changing the AgentDock Dockerfile, compose.yaml, or anything the container depends on (the backend's listen address, port or Host check, or how it reads the audit log), or when the "docker image" CI check fails. How to run the container, test it, and which settings must not change.
---

# AgentDock in Docker

The container serves the dashboard and backend for one project, reading that project's `.ctrlplane/audit.db`. The supervisor itself (`ctrlplane`) keeps running on the machine, not in the container.

## Run it

```bash
AGENTDOCK_PROJECT_DIR=/path/to/project docker compose up --build
```

Then open <http://127.0.0.1:45820>. On Windows give the project as a Windows path. Always keep `--build` after a source change: without it Docker reuses the old image and you test old code.

## Test it

```bash
node scripts/docker-smoke.ts; echo "smoke rc=$?"
```

This is the command the "docker image (build and smoke test)" CI check runs. It builds the image with `compose.yaml`, starts it against a throwaway project, and checks that the container shows the audit log, picks up new rows, accepts only this machine's Host names, publishes its port on 127.0.0.1 only, and can write neither the project nor its own files. It needs Docker with Compose v2 and uses port 45899 (`AGENTDOCK_SMOKE_PORT` changes it).

## Settings that must not change

Each one is explained in `docs/DECISIONS.md` (D-4) and the README section "Run with Docker". Read those before touching any of them.

- **`127.0.0.1:` in front of the published port.** Inside the container the backend listens on every address so Docker can forward the port. Without the prefix, Docker publishes it on every network the machine is on.
- **The same port number on both sides.** The backend's Host check expects its own port, so `45900:45820` is refused.
- **The project mounted read-only (`:ro`).** On Docker Desktop a writable mount of a live `audit.db` fails with "disk I/O error", and the container must never change the project.
- **Runtime stage without `node_modules`.** The backend uses only Node's built-in modules. A new npm dependency in `backend/` breaks the image, so the smoke test fails.
- **Files owned by root, server running as `node`**, plus `read_only: true`, `tmpfs: /tmp`, `cap_drop: ALL` and `no-new-privileges` in compose. The server cannot change its own code.
- **Base image pinned by `@sha256:` digest** in both stages. Update the digest on purpose, in its own commit.
