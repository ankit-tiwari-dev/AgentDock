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
- **Verification:** `frontend/tests/security.test.ts` → `regression: the dashboard never builds HTML out of server or event data`.

## I-5 · FIXED · The extension sidebar had no CSP and made up a locked spec when the backend was down

- **Symptoms:** the webview ran any inline script and inserted backend data with `innerHTML`. With the backend offline, "Lock Specification" showed a locked spec with `specHash: "sha256-mock-hash"` and criteria nobody chose. "Key saved" was shown before the save finished. The key field suggested an `sk-...` format.
- **Root cause:** `extension/src/sidebar-provider.ts` had no Content Security Policy, used inline `onclick` handlers and `innerHTML`, and its offline `catch` returned sample data.
- **Fix:** a CSP of `default-src 'none'` with a fresh script nonce per page. Click handlers are attached from the script. The questions are built with DOM calls. Offline, the extension posts `backend_offline` and the sidebar shows that message. The alert waits for `key_saved`.
- **Verification:** `extension/tests/security.test.ts`. All five tests failed on the old code (no CSP, `innerHTML` with data, `['interview_locked', 'interview_result']` instead of `['backend_offline', 'backend_offline']`, `(sk-...)` present).

## I-6 · FOUND · The editor extension cannot load

- **Symptoms:** installing the extension registers no command and no sidebar.
- **Root cause:** `extension/src/extension.ts` exports `activateExtension` but no `activate`/`deactivate`, and never calls `registerWebviewViewProvider` or `registerCommand`. `main` points at a `.ts` file with no build step, and `engines.vscode` is `^1.85`, whose runtime cannot strip types. The `run_verification` and `open_browser_dashboard` messages and the `modelProvider`, `modelName` and `backendPort` settings are declared but never handled.
- **Fix (proposed):** decide the extension's scope first, then add a build to JavaScript, an `activate` that registers the view and commands, and a packaging ignore list.

## I-7 · FOUND · The dashboard shows sample data as if it were live

- **Symptoms:** the overview numbers, the seeded timeline, the verification board ("Verify" only shows an alert) and the diff view never change.
- **Root cause:** they are fixed HTML. Nothing in `agentdock-cli` posts events to `/api/events/broadcast`.
- **Fix (proposed):** either connect the CLI daemon to the backend, or label each sample panel as a preview until it is.

## I-8 · FOUND · No license file

- **Symptoms:** the old README claimed MIT, but there is no `LICENSE`. Without one the code is not open source in practice.
- **Fix (proposed):** the owner picks a license and adds `LICENSE`.

## I-9 · FOUND · The dashboard loads Tailwind from a CDN with no version pin or integrity hash

- **Symptoms:** `frontend/public/index.html` runs whatever `https://cdn.tailwindcss.com` serves, with the page's full access to the local API.
- **Root cause:** the play-CDN script tag has no version and no `integrity` attribute. It also generates styles at runtime, which stops the dashboard from using a strict Content Security Policy.
- **Fix (proposed):** build the CSS once and serve it from the backend, then add a CSP to the dashboard like the extension's.

## I-10 · FIXED · `frontend/package.json` pointed at a file that does not exist

- **Symptoms:** `main`, `types` and `exports` named `./src/app.ts`.
- **Fix:** they name `./src/index.ts`.
- **Verification:** `regression: every entry point named in a workspace package.json exists` (old code: `frontend: ./src/app.ts`).
