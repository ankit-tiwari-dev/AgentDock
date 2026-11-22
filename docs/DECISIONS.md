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

## D-3 · An AI supervisor runs only when turned on

**Decision:** Plan & review calls an AI supervisor (Codex, Claude or an OpenAI-compatible server), to plan and to explain changes, only when one is turned on: with `ctrlplane supervisor use`, or, when no `supervisor.json` exists, by starting the backend with `AGENTDOCK_CODEX=1`. One run at a time across every provider and project. Otherwise planning uses the built-in interview and explaining says how to turn a supervisor on.

**Why:** each run is a paid model session that reads the repository and can take minutes. A dashboard click, or a stray request, should not start one by default.

**Rules out:** explaining changes working out of the box, and turning a supervisor on from the dashboard (D-9).

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

A seventh page, Settings, was added later (D-9).

## D-8 · Several projects come from repeated `--project` flags, and requests name them by id

**Decision:** the backend watches every folder passed with `--project`, in order, one audit reader each. `GET /api/projects` lists them with an id made from the folder name. `GET /api/dashboard/state`, `POST /api/supervisor/interview` and `POST /api/reviewer/explain` take `?project=<id>`; without it they use the first project, and an unknown id is a 404. Every streamed audit event carries `project`. The dashboard shows a picker when there are two or more projects and keeps the pick in `?project=`.

**Why:**

- Flags need no config file and no write endpoint, so there is nothing new to store or secure.
- A request names a project only by an id the backend gave out, so a web page can never make the backend read a folder it was not started with.
- Defaulting to the first project keeps one-project setups, the Docker image and older pages working unchanged.

**Rules out:** adding projects from the dashboard, remembering them across restarts, scanning folders, and an all-projects view.

## D-9 · The dashboard may change the supervisor's provider and model, nothing else

**Decision:** `POST /api/supervisor/settings` rewrites `$CTRLPLANE_HOME/supervisor.json` with a new provider and model. The body must be exactly `{provider, model}`; the route answers 409 when the file does not exist, 503 in Docker or when the file cannot be written, and 400 for `openai-compatible` without a saved base URL. It keeps the saved base URL and writes through a temp file and a rename. It passes the same Host, Origin and `application/json` checks as every POST (D-2) and never touches the keychain. A seventh dashboard page, Settings, uses it.

**Why:**

- Switching model is the setting people change most, and doing it in the terminal while looking at the dashboard is a detour.
- A key or a base URL decides where code and keys are sent. Keeping both in the CLI means a page in the browser, or a request that slips past the Origin check, can never point a saved key at another server.
- Writing only into a file that already exists keeps "turned on only from the terminal" (D-3).

**Rules out:** setting or removing a key, setting the base URL, and creating `supervisor.json` from the dashboard. This amends D-8's "no write endpoint" for this one file.

## D-10 · Claude through the official SDK, pinned and loaded only when used

**Decision:** the Claude supervisor uses `@anthropic-ai/sdk` at an exact version, imported the first time a Claude run or model list happens. The Docker image ships without `node_modules`, and API providers refuse to run there. The Anthropic address is fixed, so `ANTHROPIC_BASE_URL` in the backend's environment cannot send the saved key elsewhere, and `ANTHROPIC_AUTH_TOKEN` is never sent.

**Why:**

- The SDK tracks the API's request shapes, streaming and error types; hand-written HTTP would drift from them.
- An exact pin means an update is a reviewed change, not something that arrives with `npm install`.
- A lazy import keeps every other path, and the image, free of a dependency only one provider needs.

**Rules out:** other runtime dependencies for the backend without a new decision, and the Claude supervisor inside the container.

## D-11 · Cost comes only from `audit.db`, and search reads the log on the server

**Decision:** the dashboard shows token use and cost only from the `session_usage` table that the CLI daemon fills; the daemon is the only reader of agent transcripts, and the dashboard never opens a file outside the project's `.ctrlplane` folder. Search (`GET /api/events/search`) and the session timeline (`GET /api/sessions/<id>/timeline`) are read-only routes on the same database; like the others they take `?project=<id>` (D-8), and a session from another project is a 404. Search matches text with `LIKE` over the stored input, output, tool name, reason and rule, newest first, paged by rowid; outputs stored as separate files are not searched. The timeline pages by sequence number and rowid together, because a sequence number can repeat within a session.

**Why:**

- A transcript holds the whole conversation, and in Docker it is not even mounted. Reading only the database keeps the dashboard's access the same as D-1 and D-4: one file, read-only.
- The browser holds only the newest 500 events, so finding older ones has to happen on the server.
- `LIKE` needs no new index, no copy of the data and no change in the CLI's schema, and it stays fast enough on 100,000 events (`scripts/bench-live-view.ts` measures it). Full-text search can be added later without changing the routes.
- The search text is never logged and no error repeats it, because a user may paste a secret into the box.

**Rules out:** cost for agents whose CLI records none (shown as not available, never as $0), reading transcripts or blob files from the dashboard, and write routes for search or the timeline. D-1 is unchanged.

## D-12 · CONSTRAINTS.md holds the merge bar, and new gates warn for two weeks first

**Decision:** `CONSTRAINTS.md` lists every check that decides whether a change can merge, with its number, the command that produces the verdict and where it runs. The coverage gate and the page check read their numbers from it. A floor of moves that lower the bar (new suppression comments, stubs, skipped or deleted tests, removed assertions, a loosened threshold or a new exception) is checked on the diff after every agent edit and in CI, and blocks from the start. Changed-line coverage, architecture (dependency-cruiser) and the page check (Lighthouse on all seven pages, served by the real backend on a seeded throwaway project) warn until 2026-12-05 and block after it. `.claude/settings.json` runs the floor after each edit and the task-end checks when an agent stops with uncommitted code changes.

**Why:**

- Agents write more code than anyone reads line by line, so the bar has to live in checks that run inside their loop, with numbers chosen once instead of argued per PR.
- A threshold read from the file that documents it cannot drift from its documentation.
- The page check is the one outside opinion on what a user sees: Lighthouse measures a real browser and runs axe-core, so it cannot be satisfied by code that only passes this repo's own tests.
- Two weeks of warnings let numbers measured on one Windows machine be checked against CI before they cost a red build.

**Rules out:** loosening a number, or adding an exception, in the same change that needed it, without saying so in the PR. dependency-cruiser and Lighthouse are root dev dependencies only; `backend/` still has no new dependency (D-10), and the architecture check now enforces that.
