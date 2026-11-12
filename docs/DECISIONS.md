# Decisions

Each entry: the decision, why, and what it rules out.

## D-1 · The dashboard reads the project's audit log; hooks do not send events

**Decision:** the backend reads `<project>/.ctrlplane/audit.db` through a read-only SQLite connection and polls it for new rows once a second. The `agentdock-cli` hook does not post events to the backend.

**Why:**

- No network call is added to the hook's path. A hook runs before every tool call, so a network call there adds latency, and a hook that waits on a stalled connection can fail to print its verdict. (While the daemon is stopped the hook writes the audit row itself, to a local file.)
- The audit log is already redacted. The dashboard shows exactly what `ctrlplane audit` shows, with no second copy to drift or leak.
- History survives a backend restart: the dashboard reads what was recorded while it was closed.

**Rules out:** anything the audit log does not store. It records calls made while the daemon is stopped and the rule behind each decision, but only from agentdock-cli versions that do (`ISSUE.md` → I-12, I-13); older logs have neither.

## D-2 · Host and Origin checks instead of a per-install token

**Decision:** the backend accepts a request only when its `Host` is this machine on the server's port, and a POST only when it has no `Origin` or the dashboard's own origin and is `application/json`. There is no API token.

**Why:** the backend binds to `127.0.0.1`, so the callers to keep out are web pages open in the developer's browser. The `Host` check stops DNS rebinding; the `Origin` and `Content-Type` checks stop cross-site requests, and with no CORS headers no other site can read a response. A token file would not stop a local process, which can read the file as easily as the backend can.

**Rules out:** using the API from another machine, and from any browser page other than the dashboard, except the one dev origin below.

**Exception:** `AGENTDOCK_DEV_ORIGIN` names the Next.js dev server (only a `http://localhost:<port>` or `http://127.0.0.1:<port>` address). That origin passes the check and gets CORS headers for itself. It is off by default, because many local tools listen on port 3000.

## D-3 · Codex runs only when turned on

**Decision:** the product guide and the code explainer call Codex CLI only when the backend starts with `AGENTDOCK_CODEX=1`, and one run at a time. Otherwise the guide uses the built-in interview and the explainer says how to turn Codex on.

**Why:** each run is a paid model session that reads the repository and can take minutes. A dashboard click, or a stray request, should not start one by default.

**Rules out:** the code explainer working out of the box.

## D-4 · In Docker, the port is published to 127.0.0.1 and the project is mounted read-only

**Decision:** the image listens on `0.0.0.0` inside the container. `compose.yaml` and the README publish its port as `127.0.0.1:<port>:<port>` and mount the project as `/project:ro`. The backend accepts `AGENTDOCK_HOST` values `127.0.0.1`, `::1`, `0.0.0.0` and `::` only.

**Why:**

- Docker forwards a published port only to a server listening on the container's network address, so `127.0.0.1` inside the container cannot be reached at all. Publishing to `127.0.0.1` on the host keeps the result the same as running without Docker: only this machine can connect. The `Host` check (D-2) stops web pages, not a client on the network, which can send any `Host` header, so it cannot stand in for the binding.
- A read-only mount is the only one that works. The CLI writes `audit.db` in SQLite's WAL mode, where readers and the writer share a memory-mapped `-shm` file. On Docker Desktop (Windows, Docker 29.8.2) a writable bind mount made every read fail with `disk I/O error`. Read-only, SQLite reads the WAL without that shared memory, and one long-lived connection saw every new row, through a checkpoint and a 2,000-row burst. `npm run docker:smoke` checks this on every pull request.
- Refusing other `AGENTDOCK_HOST` values keeps a typo or a network card's address from putting the dashboard on the network outside Docker.

**Rules out:** opening the dashboard from another machine; a published port that differs from the container's port (the `Host` check expects the server's own port, so `AGENTDOCK_PORT` sets both); Codex CLI inside the image. Linux and macOS hosts were not tested by hand; CI runs the smoke test on Linux.
