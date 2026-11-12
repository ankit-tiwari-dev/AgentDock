# Issues

Status flow: FOUND → IN PROGRESS → FIXED. Each entry: symptoms, root cause, fix, verification.

## I-1 · FIXED · Any website could drive the backend API

- **Symptoms:** a page on any site, open in the developer's browser, could post events, run the interview and lock a specification on `127.0.0.1:45820`. The forged event then reached the dashboard.
- **Root cause:** `backend/src/server.ts` sent `Access-Control-Allow-Origin: *`, never checked `Origin` or `Host`, and parsed any body as JSON whatever its `Content-Type`. A `text/plain` POST needs no browser preflight, so even without CORS a plain form could reach the API.
- **Fix:** no CORS headers. Every request needs a `Host` of this machine on the server's port (stops DNS rebinding). A POST needs either no `Origin` (a non-browser client) or the dashboard's own origin, and `Content-Type: application/json`.
- **Verification:** `backend/tests/security.test.ts`, the `regression:` tests for the CORS header, the cross-site POST (403), the `text/plain` POST (415) and the foreign `Host` (403). On the old code they got `*`, 200, 200 and 200.

## I-2 · FIXED · The WebSocket accepted any site, refused a query string, and blocked shutdown

- **Symptoms:** an upgrade with `Origin: https://evil.example` got `101`. `/ws/events?x=1` was refused. `stop()` never returned while a client was connected.
- **Root cause:** the upgrade handler compared the raw `req.url` and did no `Origin` or `Host` check. `server.close()` waits for every socket, and upgraded sockets were never closed.
- **Fix:** the upgrade handler parses the path and applies the same `Host` and `Origin` rules as the API, answering 403 otherwise. `stop()` closes every WebSocket client first (`WebSocketBroadcaster.closeAll`).
- **Verification:** `regression: a WebSocket upgrade from another site is refused` (hung on the old code) and `regression: a WebSocket path with a query string is accepted` (old code: `closed`, expected `101`).

## I-3 · FIXED · Request bodies had no size limit and could be corrupted

- **Symptoms:** a body of any size was buffered in memory. `café` split across two network chunks arrived as `caf��`. Invalid JSON returned "Missing required 'prompt'".
- **Root cause:** `readJsonBody` decoded each chunk to a string on its own and turned every parse error into a `null` body. An exception in a route handler could also call the callback twice.
- **Fix:** collect raw `Buffer` chunks, decode once at the end, reject over 1 MB with 413, answer `400 Invalid JSON body`, and answer 500 at most once if a handler throws.
- **Verification:** `regression: a body over 1 MB is rejected with 413`, `regression: a character split across two chunks arrives intact`, `regression: invalid JSON gets a 400 that says so`.

## I-4 · FIXED · The dashboard rendered event data as HTML

- **Symptoms:** an event whose `type` or `data` held markup was inserted into the page as HTML (cross-site scripting). Interview questions and answers were inserted the same way.
- **Root cause:** `frontend/public/index.html` built the timeline rows and the question list with `innerHTML` template strings.
- **Fix:** both are built with `createElement` and `textContent`. The radio-button selector escapes the question id with `CSS.escape`. The connection badge says "Backend connected", because the page cannot tell whether a daemon runs.
- **Verification:** `frontend/tests/security.test.ts` → `regression: the dashboard never builds HTML out of server or event data`. The dashboard is now a Next.js app; the same test scans its sources for `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML` and `insertAdjacentHTML`.

## I-5 · FIXED · The extension sidebar had no CSP and made up a locked spec when the backend was down

- **Symptoms:** the webview ran any inline script and inserted backend data with `innerHTML`. With the backend offline, "Lock Specification" showed a locked spec with `specHash: "sha256-mock-hash"` and criteria nobody chose. "Key saved" was shown before the save finished. The key field suggested an `sk-...` format.
- **Root cause:** `extension/src/sidebar-provider.ts` had no Content Security Policy, used inline `onclick` handlers and `innerHTML`, and its offline `catch` returned sample data.
- **Fix:** a CSP of `default-src 'none'` with a fresh script nonce per page. Click handlers are attached from the script. The questions are built with DOM calls. Offline, the extension posts `backend_offline` and the sidebar shows that message. The alert waits for `key_saved`.
- **Verification:** `extension/tests/security.test.ts`. All five tests failed on the old code (no CSP, `innerHTML` with data, `['interview_locked', 'interview_result']` instead of `['backend_offline', 'backend_offline']`, `(sk-...)` present).

## I-6 · FOUND · The editor extension cannot load

- **Symptoms:** installing the extension registers no command and no sidebar.
- **Root cause:** `extension/src/extension.ts` exports `activateExtension` but no `activate`/`deactivate`, and never calls `registerWebviewViewProvider` or `registerCommand`. `main` points at a `.ts` file with no build step, and `engines.vscode` is `^1.85`, whose runtime cannot strip types. The `run_verification` and `open_browser_dashboard` messages and the `modelProvider`, `modelName` and `backendPort` settings are declared but never handled.
- **Fix (proposed):** decide the extension's scope first, then add a build to JavaScript, an `activate` that registers the view and commands, and a packaging ignore list.

## I-7 · FIXED · The dashboard showed sample data as if it were live

- **Symptoms:** the overview numbers, the seeded timeline, the verification board ("Verify" only showed an alert) and the diff view never changed.
- **Root cause:** they were fixed HTML, and nothing in `agentdock-cli` sent events to the backend.
- **Fix:** the Next.js dashboard shows only data from the backend. The backend reads the project's `.ctrlplane/audit.db` (the file the CLI daemon writes on every hook call) through a read-only connection, serves it at `/api/dashboard/state`, and streams new rows over `/ws/events` once a second. Panels with no backing data were removed.
- **Verification:** `backend/tests/audit-reader.test.ts` (mapping, counts, polling, read-only, a stopped daemon), `backend/tests/dashboard-api.test.ts` (the endpoint and the stream). By hand: the backend started with `--project` on a project with two recorded hook calls, opened in headless Edge, showed "2 events stored" and "Live stream connected".

## I-8 · FOUND · No license file

- **Symptoms:** the old README claimed MIT, but there is no `LICENSE`. Without one the code is not open source in practice.
- **Fix (proposed):** the owner picks a license and adds `LICENSE`.

## I-9 · FIXED · The dashboard loaded Tailwind from a CDN with no version pin or integrity hash

- **Symptoms:** the old `frontend/public/index.html` ran whatever `https://cdn.tailwindcss.com` served, with the page's full access to the local API.
- **Root cause:** the play-CDN script tag had no version and no `integrity` attribute, and its runtime styles ruled out a strict Content Security Policy.
- **Fix:** the dashboard is a Next.js static export whose scripts and styles are served by the backend. Every HTML response carries a CSP that allows only the page's own files and the inline scripts it shipped with, each by its SHA-256 hash (`backend/src/static-files.ts`).
- **Verification:** `backend/tests/static-serving.test.ts` → `the dashboard page is served with a policy that only runs its own scripts`. By hand: headless Edge reported no CSP violation and the page's scripts ran.

## I-10 · FIXED · `frontend/package.json` pointed at a file that does not exist

- **Symptoms:** `main`, `types` and `exports` named `./src/app.ts`.
- **Fix:** they named `./src/index.ts`. The Next.js frontend now has no `main` or `exports`; the test still checks every workspace.
- **Verification:** `regression: every entry point named in a workspace package.json exists` (old code: `frontend: ./src/app.ts`).

## I-11 · FIXED · One request for `/%` stopped the backend

- **Symptoms:** `GET /%` (or any path with a broken percent-escape) ended the backend process with `URIError: URI malformed`. Any web page could do this with an image tag pointing at `127.0.0.1:45820`.
- **Root cause:** the static-file branch of `backend/src/server.ts` called `decodeURIComponent` with no `try`, inside the request handler, so the exception was uncaught.
- **Fix:** `decodePath` in `backend/src/static-files.ts` returns nothing for a bad escape or a NUL byte, and the server answers 400.
- **Verification:** `backend/tests/static-serving.test.ts` → `regression: a malformed percent-escape gets 400 and the backend keeps running`. On the old code the request never got an answer and the process exited with code 1.

## I-12 · FIXED · The audit log did not store which rule decided a tool call

- **Symptoms:** the dashboard shows "Matched rule: Not recorded", and the Policies tab groups decisions by the first line of their message instead of by rule.
- **Root cause:** the `agentdock-cli` daemon computes `matchedRuleId` for its reply but does not write it to the `events` table, which has no column for it.
- **Fix:** agentdock-cli now writes a `rule_id` column (its own ISSUE.md → I-54). `backend/src/audit-reader.ts` reads it when the column exists and selects `NULL` otherwise, checking on every read because the CLI may add the column while the backend runs. The Policies tab groups by rule ID when there is one.
- **Verification:** `backend/tests/audit-reader.test.ts` → `the rule that decided a call is shown when the CLI stores it` (failed before the reader change); the older tests in that file use the table without the column and still pass. `frontend/tests/events.test.ts` → `when the audit log names the rule, decisions are grouped by rule ID`.

## I-13 · FIXED · Hook calls made while the daemon was stopped never reached the dashboard

- **Symptoms:** with the daemon stopped, the hooks still allow and deny (from local rules), but nothing appears on the dashboard.
- **Root cause:** only the daemon writes `audit.db`; the hook's local fallback records nothing.
- **Fix:** in agentdock-cli (its ISSUE.md → I-55): with no daemon running, the hook writes the call to `audit.db` itself, as the daemon would. Nothing changes here; the dashboard reads those rows like any other. It needs an agentdock-cli version with that fix.

## I-14 · FOUND · The dashboard loads its fonts from Google

- **Symptoms:** opening the dashboard requests `fonts.googleapis.com` and `fonts.gstatic.com`, which tells Google the dashboard is open, and the CSP has to allow both hosts.
- **Root cause:** `frontend/src/app/styles.css` starts with a Google Fonts `@import`.
- **Fix (proposed):** bundle the fonts at build time (`next/font`) or use system fonts, then drop the two hosts from the CSP.
