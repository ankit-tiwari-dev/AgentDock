# AgentDock Platform

> The local web dashboard, backend and editor-extension prototype for [AgentDock](https://github.com/ankit-tiwari-dev/agentdock-cli).

[![CI](https://github.com/ankit-tiwari-dev/AgentDock/actions/workflows/ci.yml/badge.svg)](https://github.com/ankit-tiwari-dev/AgentDock/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D22.18-blue)](https://nodejs.org)

The supervisor itself (hooks, policy engine, audit trail, context packs) lives in `agentdock-cli`. This repo holds the surfaces a developer looks at.

## What is here

| Workspace    | What it is                                                                                                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `backend/`   | A plain `node:http` server on `127.0.0.1:45820`. It reads a project's audit log, serves it as JSON and as a live WebSocket stream (`/ws/events`), runs the product guide, prompt coach and token cost endpoints, and serves the built dashboard. |
| `frontend/`  | The dashboard, a Next.js app exported to static files in `frontend/out`: agent activity, sessions, policy decisions, the product guide, the code explainer and the prompt coach.                                                                 |
| `extension/` | Sidebar webview, message handling and key storage for an editor extension. It is not yet a loadable extension: there is no `activate` entry point and no build step (`ISSUE.md` → I-6).                                                          |

### Where the data comes from

The backend reads `<project>/.ctrlplane/audit.db`, the file `agentdock-cli` writes on every hook call (the daemon, or the hook itself while the daemon is stopped). It opens it read-only and checks for new rows once a second. Inputs and outputs were redacted by the CLI before they were stored. The rule that decided each call is shown when the CLI stores it; audit logs from older CLI versions show "Not recorded". Why this design: [`docs/DECISIONS.md`](docs/DECISIONS.md) → D-1.

## Quickstart

Requires Node 22.18 or newer (Node 24 recommended). Node runs the TypeScript sources directly.

```bash
npm ci
npm run build                                   # builds the dashboard into frontend/out
node backend/src/server.ts --project /path/to/your/project
```

Then open <http://127.0.0.1:45820>. In the project you point at, install and start the supervisor first:

```bash
ctrlplane init --agent claude    # or codex, opencode, all
ctrlplane start
```

If the project has no audit log yet, the dashboard says so and shows the path it reads.

### Settings

| Variable                                 | Default         | Effect                                                                                                                                 |
| ---------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `--project <path>` / `AGENTDOCK_PROJECT` | current folder  | The project whose `.ctrlplane/audit.db` is shown.                                                                                      |
| `AGENTDOCK_CODEX=1`                      | off             | The product guide and the code explainer run Codex CLI (read-only sandbox, one run at a time). Off, the guide uses built-in questions. |
| `AGENTDOCK_CODEX_PATH`                   | found on `PATH` | The Codex CLI executable to run.                                                                                                       |
| `AGENTDOCK_DEV_ORIGIN`                   | off             | Lets the Next.js dev server call the API, for example `http://localhost:3000`. Only a localhost or 127.0.0.1 address is accepted.      |
| `AGENTDOCK_HOST`                         | `127.0.0.1`     | The address to listen on: `127.0.0.1`, `::1`, or `0.0.0.0` / `::` inside a container (see below). Anything else stops the backend.     |
| `AGENTDOCK_PORT`                         | `45820`         | The port to listen on.                                                                                                                 |

## Run with Docker

Needs only Docker. From a clone of this repo:

```bash
AGENTDOCK_PROJECT_DIR=/path/to/your/project docker compose up --build
```

Then open <http://127.0.0.1:45820>. Without Compose:

```bash
docker build -t agentdock .
docker run --rm -p 127.0.0.1:45820:45820 -v /path/to/your/project:/project:ro agentdock
```

On Windows, give the project as a Windows path, for example `-v "C:\code\my-app:/project:ro"`. Run the supervisor (`ctrlplane`) on the machine as usual; the container only reads the audit log it writes.

On Linux the server runs as user ID 1000, so it needs read access to the project folder and its `.ctrlplane` files. Files the CLI creates are readable by everyone by default. If your folder is private, run the container as yourself: `docker run --user "$(id -u):$(id -g)" ...`, or add `user: "1001:1001"` (your IDs) to the service in `compose.yaml`.

Keep these two parts of the command as they are:

- **`127.0.0.1:` in front of the port.** Inside the container the backend has to listen on every address so Docker can forward the port. Without `127.0.0.1:`, Docker publishes the port on every network your machine is on, and the `Host` check below does not stop a client on the network, which can send any `Host` header.
- **`:ro` on the project folder.** The container cannot change your project, and the audit log can only be read this way: on Docker Desktop a writable mount of a live `audit.db` fails with `disk I/O error`.

To use another port, set it once, so both sides match: `AGENTDOCK_PORT=45900 docker compose up`. With `docker run`, use `-e AGENTDOCK_PORT=45900 -p 127.0.0.1:45900:45900`. A published port that differs from the container's own is refused by the `Host` check.

The image holds Node, the backend and the built dashboard, and runs as a non-root user. Compose also makes its filesystem read-only and drops all Linux capabilities. Codex CLI is not in the image, so the product guide uses its built-in questions. Why it works this way: [`docs/DECISIONS.md`](docs/DECISIONS.md) → D-4.

## Security model

The backend binds to `127.0.0.1` by default and has no login. It accepts a request only when:

- the `Host` header is this machine (`127.0.0.1`, `localhost` or `[::1]` on the server's port), which stops DNS rebinding;
- a browser request comes from the dashboard's own origin, and a POST is `application/json`, so other websites cannot drive the API;
- the body is at most 1 MB.

It sends no CORS headers, except to the one dev origin you name with `AGENTDOCK_DEV_ORIGIN`. Requests with no `Origin` (the extension, `curl`) are allowed, because any local process can already reach a local port. The dashboard page is served with a Content Security Policy that runs only its own scripts. Why no token: [`docs/DECISIONS.md`](docs/DECISIONS.md) → D-2.

## Development

```bash
make ci          # every gate CI runs
make lint        # ESLint + Prettier check
make typecheck   # the .ts files; the build checks the .tsx files
make build       # the dashboard
make hygiene     # repo rules
make test
```

To work on the dashboard with hot reload, run two terminals:

```bash
AGENTDOCK_DEV_ORIGIN=http://localhost:3000 node backend/src/server.ts --project /path/to/project
npm run dev --workspace frontend    # http://localhost:3000
```

Set `NEXT_TELEMETRY_DISABLED=1` to stop Next.js from sending anonymous usage data while building.

Known bugs and open items: [`ISSUE.md`](ISSUE.md).

## License

No license has been chosen yet (`ISSUE.md` → I-8).
