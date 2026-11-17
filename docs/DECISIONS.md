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

**Decision:** Plan & review calls Codex CLI, to plan and to explain changes, only when the backend starts with `AGENTDOCK_CODEX=1`, and one run at a time. Otherwise planning uses the built-in interview and explaining says how to turn Codex on.

**Why:** each run is a paid model session that reads the repository and can take minutes. A dashboard click, or a stray request, should not start one by default.

**Rules out:** explaining changes working out of the box.

## D-4 · In Docker, the port is published to 127.0.0.1 and the project is mounted read-only

**Decision:** the image listens on `0.0.0.0` inside the container. `compose.yaml` and the README publish its port as `127.0.0.1:<port>:<port>` and mount the project as `/project:ro`. The backend accepts `AGENTDOCK_HOST` values `127.0.0.1`, `::1`, `0.0.0.0` and `::` only.

**Why:**

- Docker forwards a published port only to a server listening on the container's network address, so `127.0.0.1` inside the container cannot be reached at all. Publishing to `127.0.0.1` on the host keeps the result the same as running without Docker: only this machine can connect. The `Host` check (D-2) stops web pages, not a client on the network, which can send any `Host` header, so it cannot stand in for the binding.
- A read-only mount is the only one that works. The CLI writes `audit.db` in SQLite's WAL mode, where readers and the writer share a memory-mapped `-shm` file. On Docker Desktop (Windows, Docker 29.8.2) a writable bind mount made every read fail with `disk I/O error`. Read-only, SQLite reads the WAL without that shared memory, and one long-lived connection saw every new row, through a checkpoint and a 2,000-row burst. `npm run docker:smoke` checks this on every pull request.
- Refusing other `AGENTDOCK_HOST` values keeps a typo or a network card's address from putting the dashboard on the network outside Docker.

**Rules out:** opening the dashboard from another machine; a published port that differs from the container's port (the `Host` check expects the server's own port, so `AGENTDOCK_PORT` sets both); Codex CLI inside the image. Linux and macOS hosts were not tested by hand; CI runs the smoke test on Linux.

## D-5 · The code is MIT licensed

**Decision:** the code is released under the MIT License (`LICENSE` at the repo root).

**Why:** it makes the project open source with the fewest conditions for users and contributors: they only have to keep the copyright and license notice.

**Rules out:** limits on reuse. Anyone may reuse the code, including commercially, with no obligation to share their changes.

## D-6 · "Needs you" shows approval requests from the last 15 minutes

**Decision:** the Overview's "Needs you" card lists tool calls whose verdict was `REQUIRE_MANUAL_APPROVAL` that happened in the last 15 minutes and have no record they ran (D-7), newest first, and tells the developer to answer in that agent. The "Asked for approval" card shows the all-time count next to how many fall in that window.

**Why:**

- The audit log records that an agent asked, not whether the developer answered. Listing every request ever made would show long-answered ones as waiting.
- An agent waits at its permission prompt while the developer is at the keyboard, so a request older than 15 minutes has almost always been answered or abandoned. The window is `APPROVAL_WINDOW_MS` in `frontend/src/lib/events.ts`.
- The agent's own prompt is where the answer goes today, so the card points there instead of offering a button that cannot act.

**Rules out:** approving or denying from the dashboard; showing a request as answered. Both need the CLI to record the answer first.

## D-7 · Six pages, and "Ran afterwards" instead of "approved"

**Decision:** the dashboard has six pages: Overview, Waiting on you, Sessions, Rules, Plan & review and Project. The page is kept in the address hash. Waiting on you marks an approval request "Ran afterwards" when the same session later completed the same tool with the same target before asking for it again, and "No record it ran" otherwise; the sidebar count, and the Overview's "Needs you" card, are the requests from the last 15 minutes (D-6) with no such record.

**Why:**

- The old Live stream page showed the same events as the Overview, and the prompt coach scored prompts without looking at the project or its agents, so both went, the coach's endpoint with it. The product guide and the code explainer were the two halves of one job, so they share a page.
- A completed call is the only trace an approved request leaves in the audit log. "Ran afterwards" claims only what the log shows; it does not say the developer approved it, and "No record it ran" does not say it was denied.
- The Rules page lists the rules that acted, from the events the backend sends; the full rule list lives in agentdock-cli, which the dashboard cannot read.

**Rules out:** "Approved" or "Denied" labels, and a page of every rule with on/off switches, until the CLI records the answer and can export its rules.
