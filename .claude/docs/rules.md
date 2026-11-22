# Rules for working in this repo

The detail behind the one-line rules in `CLAUDE.md`. Read the section that matches the task; you do not need the rest.

## Session start

1. Read `CLAUDE.md`.
2. Read the open items in `ISSUE.md` (status `FOUND` or `IN PROGRESS`). If the task touches one of them, say so before you start.
3. Run `git status` and `git log --oneline -10` to see the branch and what changed last. On a branch other than `main`, also run `git log --oneline main..HEAD`.
4. If the task touches a decision in `docs/DECISIONS.md` (D-1 to the latest), read that entry before changing the code behind it.

## Gates

- Run every gate through `make` from the repo root: `make ci` runs lint, typecheck, build, hygiene and test, in CI's order.
- Read the real exit code. Write the output to a file, then print `$?`:

  ```bash
  make ci > ci.log 2>&1; echo "make ci rc=$?"
  ```

  Never pipe `make` into `tail`, `head` or `grep` and then read the result as pass or fail. The pipe reports the last command's exit code, so a red run looks green.

- Only `rc=0` is green. A suppressed or truncated output is not evidence.
- Delete `ci.log` afterwards. `hygiene` fails on a tracked or untracked `*.log` file.

## Tests

- Use `node:test` and `node:assert/strict`. No other test runner.
- Put a test in the workspace's own `tests/` folder as `<topic>.test.ts`. `hygiene` fails when a workspace has no file there that declares a test.
- Node runs the TypeScript directly, so use only erasable syntax (`erasableSyntaxOnly` in `tsconfig.json`): no `enum`, no `namespace`, no constructor parameter properties.
- Make temporary folders with `mkdtempSync(join(tmpdir(), "agentdock-<topic>-"))` and remove them with `rmSync(dir, { recursive: true, force: true })` in `finally`.
- Start a backend with `port: 0` and stop it in `finally` (`await server.stop()`). Close every SQLite database in `finally` too. On Windows an open file keeps the temporary folder from being removed.
- Build paths with `node:path`. Compare timestamps as numbers, not as formatted text. CI runs the tests on Linux, Windows and macOS.
- Name a test that guards a fixed bug `regression: <what must stay true>`. It must fail on the old code and pass on the new. Say in `ISSUE.md` what it got on the old code.
- Every test must catch a real bug. Do not add a test that only repeats the code, checks a constant, or cannot fail.
- A test for the audit log builds its own `audit.db` in a temporary folder with `createAuditDb()` or `applyCliSchema()` from `backend/tests/live-view-fixture.ts`; ESLint fails on a hand-written `CREATE TABLE`. Never point a test at a real project.
- Check the dashboard in a browser only against a throwaway project: a temporary folder with its own `.ctrlplane/audit.db`. Never start the backend with `--project` on a real project for a test, and never write into a real project's audit log.

## Security rules that code must keep

Each comes from a fixed bug or a decision. Breaking one is a high-severity finding.

- The backend accepts a request only with a `Host` of this machine on its own port, and a POST only with no `Origin` or the dashboard's own origin and `Content-Type: application/json` (D-2, I-1). No CORS headers except for `AGENTDOCK_DEV_ORIGIN`.
- The WebSocket upgrade applies the same `Host` and `Origin` rules (I-2).
- Request bodies stop at 1 MB (I-3). A bad percent-escape gets 400, never an exception (I-11).
- The audit log is opened read-only (`readOnly: true`). The backend never writes to it (D-1).
- The dashboard never builds HTML out of data: no `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML` or `insertAdjacentHTML` (I-4). The extension webview keeps its CSP and nonce (I-5).
- Every HTML response carries the CSP from `backend/src/static-files.ts`. Do not add a host to it; it names no outside host, and `backend/tests/static-serving.test.ts` fails if one comes back.
- The backend's only npm dependency is `@anthropic-ai/sdk` (D-10); anything else breaks the Docker image, and `npm run check:arch` fails on it.
- Docker settings in `compose.yaml` and the `Dockerfile` follow D-4. Use the `agentdock-docker` skill before changing them.

## Docs and history

Each kind of fact has one home. Point at it; do not copy it.

| What                                                        | Where                  |
| ----------------------------------------------------------- | ---------------------- |
| Why something is built the way it is, and what it rules out | `docs/DECISIONS.md`    |
| A bug or finding: symptoms, root cause, fix, verification   | `ISSUE.md`             |
| How to install, run, configure and develop                  | `README.md`            |
| Rules for code in this repo                                 | `CLAUDE.md`, this file |

- A `DECISIONS.md` entry is `## D-<next number> · <decision in one line>` with **Decision**, **Why** and **Rules out**. Number it one past the highest on `main` and on every open PR.
- An `ISSUE.md` entry is `## I-<next number> · <STATUS> · <title>` with **Symptoms**, **Root cause** (`file:line`), **Fix** and **Verification**. Status moves `FOUND` → `IN PROGRESS` → `FIXED`. Keep `FIXED` entries; they are the history.
- A doc names code by file and function, so a reader can check it. A doc that contradicts the code is a bug: fix the doc in the same change.
- No narratives in docs: no test-run output, no "phase 1 done", no story of how a change was made. Git history holds that.
- Planning documents stay outside the repo. Never name them, quote them or point at them in code, docs, commits or PR bodies. `hygiene` fails on some of their wording.

## Code comments

- Comment only a non-obvious why: a security reason, a platform quirk, a business rule.
- Keep it to one sentence. No block comments, no step-by-step comments, no notes about the edit.

## Pull requests

- Fill in `.github/pull_request_template.md`. Every box must be true before you tick it.
- After a push to a branch with an open PR, update the PR title and description to match what is now on the branch.
- Never merge, approve, force-push or delete a branch unless the developer says so for that PR.

## Self-correction

- When the developer corrects you, fix the work first, then say in one line what you got wrong and what you will do instead.
- If the same mistake could happen again in another task, run `/retro` at the end and record it.
- Do not argue with a correction that brings new facts. Hold your view, with the reason, when it does not.

## Adding instructions for Claude

| Kind of instruction                                    | Where it goes                                     | Budget         |
| ------------------------------------------------------ | ------------------------------------------------- | -------------- |
| A rule every task must follow                          | `CLAUDE.md`, one line                             | 90 lines total |
| The detail or reason behind a `CLAUDE.md` rule         | this file                                         | 150 lines      |
| A workflow run as its own worker (review, fix, verify) | `.claude/agents/<name>.md`                        | 80 lines       |
| A workflow the developer starts by name                | `.claude/commands/<name>.md`                      | 80 lines       |
| Know-how loaded when a task matches                    | `.claude/skills/<name>/SKILL.md`, + `references/` | 120 lines      |
| A lesson for one developer only                        | auto-memory, through `/retro`                     | none           |

- Add every new skill to `.claude/skills/README.md`.
- A one-line rule keeps every NEVER, MUST, ONLY and ALWAYS, every number and every name it governs. Move only the reason to the detail file.
- Never delete a rule to fit a budget. Move its detail out word for word.
- Never copy an instruction from another project without checking it is true here.
