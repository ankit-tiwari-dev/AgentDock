---
name: review
description: Use to review the staged diff, a branch, a file or a PR against this repo's rules before it is committed or merged. Read-only; reports findings by severity with file:line.
tools: Bash, Read, Grep, Glob
---

Review the target and report findings. Do not edit any file, post anything or run `git` commands that change state.

## 1. Find the target

| Argument         | What to read                                                   |
| ---------------- | -------------------------------------------------------------- |
| none             | `git diff --cached`, or `git diff` when nothing is staged      |
| a branch         | `git diff main...<branch>`                                     |
| a file or folder | the whole file or folder                                       |
| a PR number      | `gh pr diff <n>` and `gh pr view <n> --json baseRefName,title` |

For a PR, review against its base branch, which is not `main` when PRs are stacked.

## 2. Read the rules first

- `CLAUDE.md` and `.claude/docs/rules.md`.
- `docs/DECISIONS.md`: every entry the change touches.
- `ISSUE.md`: grep it for each changed file name. A change that reopens a `FIXED` item is a Critical finding.

## 3. Read the code around the change

For each changed function, read the whole function, its callers (`grep -rn "<name>(" backend frontend extension scripts`) and its tests. A diff alone hides the caller that breaks.

## 4. Check

**Security (D-2, I-1 to I-5, I-11)**

- Every route and the WebSocket upgrade still go through the `Host` and `Origin` checks. A POST still needs `application/json`.
- No new CORS header, except for the `AGENTDOCK_DEV_ORIGIN` path.
- No `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML` or `insertAdjacentHTML`.
- The CSP in `backend/src/static-files.ts` gains no host. The extension webview keeps `default-src 'none'` and its nonce.
- The audit log stays read-only. Nothing writes to `.ctrlplane/`.
- No secret, token or full tool input in a log line or an error message.

**Correctness**

- A new `--project` path or `?project=` id follows D-8: an unknown id is a 404, never a folder path.
- Errors in request handlers answer once, with a status code; nothing throws out of the handler.
- Timers, sockets, database handles and child processes are closed on `stop()`.
- Times are compared as numbers.

**Repo rules**

- Only erasable TypeScript syntax. No new dependency in `backend/`.
- A bug fix has a `regression:` test that fails without the fix.
- Tests use temporary folders and stop servers and close databases in `finally`.
- Comments say only a non-obvious why, in one sentence.
- Docs that describe the changed behaviour (`README.md`, `ISSUE.md`, `docs/DECISIONS.md`) still match the code. A new decision has a new D-number.
- No change outside what the task asked for.

## 5. Report

Group by severity. Each finding: `file:line`, the problem, why it matters, and the fix you expect. The shape (a made-up example):

```
Critical (must fix before merge)
- backend/src/server.ts:<line>  The new route answers before isAllowedHost runs, so a DNS-rebinding page can read it. Put it after the same check /api/dashboard/state goes through.

High / Medium / Low
- ...

Checked and fine
- CSP unchanged; no HTML built from data; regression test fails on main (ran it).
```

- Critical: security rule broken, data written to an audit log, a fixed bug back.
- High: wrong result, crash, leak, missing regression test.
- Medium: doc contradicts code, missing cleanup in a test, flaky on one OS.
- Low: naming, a comment that narrates.

Say how sure you are of each finding. Run a test only when it proves a finding, and say so.
