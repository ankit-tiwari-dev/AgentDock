# Decisions

Each entry: the decision, why, and what it rules out.

## D-1 · The dashboard reads the project's audit log; hooks do not send events

**Decision:** the backend reads `<project>/.ctrlplane/audit.db` through a read-only SQLite connection and polls it for new rows once a second. The `agentdock-cli` hook does not post events to the backend.

**Why:**

- Nothing is added to the hook's path. A hook runs before every tool call, so any network call there adds latency, and a hook that waits on a stalled connection can fail to print its verdict.
- The audit log is already redacted and hash-chained. The dashboard shows exactly what `ctrlplane audit` shows, with no second copy to drift or leak.
- History survives a backend restart: the dashboard reads what was recorded while it was closed.

**Rules out:** events from a hook whose daemon is stopped (`ISSUE.md` → I-13), and anything the audit log does not store, such as the matched rule ID (I-12).

## D-2 · Host and Origin checks instead of a per-install token

**Decision:** the backend accepts a request only when its `Host` is this machine on the server's port, and a POST only when it has no `Origin` or the dashboard's own origin and is `application/json`. There is no API token.

**Why:** the backend binds to `127.0.0.1`, so the callers to keep out are web pages open in the developer's browser. The `Host` check stops DNS rebinding; the `Origin` and `Content-Type` checks stop cross-site requests, and with no CORS headers no other site can read a response. A token file would not stop a local process, which can read the file as easily as the backend can.

**Rules out:** using the API from another machine, and from any browser page other than the dashboard, except the one dev origin below.

**Exception:** `AGENTDOCK_DEV_ORIGIN` names the Next.js dev server (only a `http://localhost:<port>` or `http://127.0.0.1:<port>` address). That origin passes the check and gets CORS headers for itself. It is off by default, because many local tools listen on port 3000.

## D-3 · Codex runs only when turned on

**Decision:** the product guide and the code explainer call Codex CLI only when the backend starts with `AGENTDOCK_CODEX=1`, and one run at a time. Otherwise the guide uses the built-in interview and the explainer says how to turn Codex on.

**Why:** each run is a paid model session that reads the repository and can take minutes. A dashboard click, or a stray request, should not start one by default.

**Rules out:** the code explainer working out of the box.
