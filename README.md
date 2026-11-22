# AgentDock Platform

> The local web dashboard, backend and editor-extension prototype for [AgentDock](https://github.com/ankit-tiwari-dev/agentdock-cli).

[![CI](https://github.com/ankit-tiwari-dev/AgentDock/actions/workflows/ci.yml/badge.svg)](https://github.com/ankit-tiwari-dev/AgentDock/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D22.18-blue)](https://nodejs.org)

The supervisor itself (hooks, policy engine, audit trail, context packs) lives in `agentdock-cli`. This repo holds the surfaces a developer looks at.

## What is here

| Workspace    | What it is                                                                                                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend/`   | A plain `node:http` server on `127.0.0.1:45820`. It reads a project's audit log, serves it as JSON and as a live WebSocket stream (`/ws/events`), runs the Plan & review endpoints, and serves the built dashboard. |
| `frontend/`  | The dashboard, a Next.js app exported to static files in `frontend/out`: Overview, Waiting on you, Sessions, Rules, Plan & review, Project and Settings (`docs/DECISIONS.md` → D-7, D-9).                           |
| `extension/` | Sidebar webview, message handling and key storage for an editor extension. It is not yet a loadable extension: there is no `activate` entry point and no build step (`ISSUE.md` → I-6).                             |

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

| Variable                                 | Default         | Effect                                                                                                                                                    |
| ---------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--project <path>` / `AGENTDOCK_PROJECT` | current folder  | The project whose `.ctrlplane/audit.db` is shown. Repeat `--project` to watch several; the sidebar then has a project picker (`docs/DECISIONS.md` → D-8). |
| `AGENTDOCK_CODEX=1`                      | off             | Plan & review uses Codex when no `supervisor.json` exists (see [Supervisor providers](#supervisor-providers)). Off, planning uses built-in questions.     |
| `AGENTDOCK_CODEX_PATH`                   | found on `PATH` | The Codex CLI executable to run.                                                                                                                          |
| `AGENTDOCK_DEV_ORIGIN`                   | off             | Lets the Next.js dev server call the API, for example `http://localhost:3000`. Only a localhost or 127.0.0.1 address is accepted.                         |
| `AGENTDOCK_HOST`                         | `127.0.0.1`     | The address to listen on: `127.0.0.1`, `::1`, or `0.0.0.0` / `::` inside a container (see below). Anything else stops the backend.                        |
| `AGENTDOCK_PORT`                         | `45820`         | The port to listen on.                                                                                                                                    |

## Supervisor providers

Plan & review can ask an AI supervisor to plan a feature and to explain the changes an agent made. Pick one in your own terminal with [`ctrlplane supervisor`](https://github.com/ankit-tiwari-dev/agentdock-cli#supervisor-providers); the backend reads the choice on every request, so it applies without a restart.

| Provider            | Setup                                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `codex`             | `ctrlplane supervisor use codex [model]`. Runs the Codex CLI on this machine with a read-only sandbox. No key.             |
| `claude`            | `ctrlplane supervisor set-key claude`, then `ctrlplane supervisor use claude claude-opus-5-5`.                             |
| `openai-compatible` | `ctrlplane supervisor use openai-compatible llama3.2 --base-url http://127.0.0.1:11434/v1`. A key is optional (`set-key`). |

With no `supervisor.json`, `AGENTDOCK_CODEX=1` still turns on Codex; with neither, planning uses built-in questions and explaining says how to turn a supervisor on.

The Settings page shows the provider, the model and whether each key is saved, and can switch provider and model. It cannot set a key or the base URL, and it cannot turn the supervisor on: those happen only in the terminal.

**What is sent where.** Codex reads the repository itself. For `claude` (to `api.anthropic.com`) and `openai-compatible` (to the base URL), the backend sends:

- planning: your request, your answers and up to 2,000 tracked file names;
- explaining: `git status`, `git diff HEAD` and the names, not the contents, of untracked files.

Secrets are redacted first. Anything over 200 KB is not sent: commit or stash part of the change, or shorten the request. Each run is one model call, never retried after an error (an OpenAI-compatible server that rejects structured output gets one second call without it); one run at a time; a run stops after 3 minutes. The Claude API bills per token, so an explain on a large diff costs more than a plan.

**Keys** stay in the OS keychain. The backend reads one only to make a call and never returns, logs or stores it. Errors reach the page as fixed messages; details go to the backend log with the key removed.

**Docker.** The container cannot read the host keychain, so `claude` and `openai-compatible` refuse to run there, and the Settings page is read-only. Use the CLI on the host.

| Message code                     | What to do                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------- |
| `KEY_MISSING`, `KEY_REJECTED`    | Save a key: `ctrlplane supervisor set-key <provider>`.                        |
| `MODEL_NOT_FOUND`                | Pick another model on the Settings page or with `ctrlplane supervisor use`.   |
| `CONFIG_INVALID`                 | Rewrite the file: `ctrlplane supervisor use <provider> <model>`.              |
| `KEYCHAIN_UNAVAILABLE`           | Install the OS keychain tool the message names, or run outside Docker.        |
| `UNREACHABLE`, `TIMEOUT`         | Check the network, or that the local model server is running at the base URL. |
| `CONTEXT_TOO_LARGE`              | Commit or stash part of the change, or shorten the request.                   |
| `RATE_LIMITED`, `PROVIDER_ERROR` | Try again later.                                                              |
| `REFUSED`, `INVALID_ANSWER`      | Rephrase the request, or pick a stronger model.                               |
| `GIT_FAILED`                     | Make sure the project folder is a git repository.                             |
| `BUSY`                           | Wait for the current run to finish.                                           |

Why it works this way: [`docs/DECISIONS.md`](docs/DECISIONS.md) → D-3, D-9, D-10.

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

The image holds Node, the backend and the built dashboard, and runs as a non-root user. Compose also makes its filesystem read-only and drops all Linux capabilities. Codex CLI is not in the image, and the API providers need the host keychain, so Plan & review uses its built-in questions. Why it works this way: [`docs/DECISIONS.md`](docs/DECISIONS.md) → D-4.

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

MIT. See [`LICENSE`](LICENSE).
