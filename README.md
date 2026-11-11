# AgentDock Platform

> The local web dashboard, backend and editor-extension prototype for [AgentDock](https://github.com/ankit-tiwari-dev/agentdock-cli).

[![CI](https://github.com/ankit-tiwari-dev/AgentDock/actions/workflows/ci.yml/badge.svg)](https://github.com/ankit-tiwari-dev/AgentDock/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D22.18-blue)](https://nodejs.org)

The supervisor itself (hooks, policy engine, audit trail, context packs) lives in `agentdock-cli`. This repo holds the surfaces a developer looks at.

## What is here

| Workspace    | What it is                                                                                                                                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend/`   | A plain `node:http` server on `127.0.0.1:45820`: a JSON API (supervisor interview, loop check, event broadcast, prompt coach, token cost) and a WebSocket event stream at `/ws/events`. It also serves the dashboard. |
| `frontend/`  | One HTML page: the dashboard. The interview wizard, prompt coach and live event timeline call the backend.                                                                                                            |
| `extension/` | Sidebar webview, message handling and key storage for an editor extension. It is not yet a loadable extension: there is no `activate` entry point and no build step (`ISSUE.md` → I-6).                               |

### Status

- **Real:** the API endpoints, the WebSocket stream, and the dashboard's interview wizard, prompt coach and event timeline.
- **Demo content:** the overview numbers, the seeded timeline entries, the verification board and the diff view are fixed sample data. Nothing in `agentdock-cli` posts events to this backend yet (`ISSUE.md` → I-7).

## Security model

The backend binds to `127.0.0.1` only and has no login. It accepts a request only when:

- the `Host` header is this machine (`127.0.0.1`, `localhost` or `[::1]` on the server's port), which stops DNS rebinding;
- a browser request comes from the dashboard's own origin, and a POST is `application/json`, so other websites cannot drive the API;
- the body is at most 1 MB.

It sends no CORS headers. Requests with no `Origin` (the extension, `curl`) are allowed, because any local process can already reach a local port.

## Quickstart

Requires Node 22.18 or newer (Node 24 recommended). Node runs the TypeScript sources directly.

```bash
npm ci
node backend/src/server.ts
```

Then open <http://127.0.0.1:45820>.

## Development

```bash
make ci          # every gate CI runs
make lint        # ESLint + Prettier check
make hygiene     # repo rules
make typecheck
make test
```

Known bugs and open items: [`ISSUE.md`](ISSUE.md).

## License

No license has been chosen yet (`ISSUE.md` → I-8).
