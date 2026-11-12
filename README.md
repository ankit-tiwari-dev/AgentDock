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

The backend reads `<project>/.ctrlplane/audit.db`, the file the `agentdock-cli` daemon writes on every hook call. It opens it read-only and checks for new rows once a second. Inputs and outputs were redacted by the CLI before they were stored. The daemon must be running for hook calls to be recorded (`ISSUE.md` → I-13). Why this design: [`docs/DECISIONS.md`](docs/DECISIONS.md) → D-1.

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

## Security model

The backend binds to `127.0.0.1` only and has no login. It accepts a request only when:

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
