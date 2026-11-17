---
name: feature
description: Use when adding or changing a feature in the AgentDock dashboard, backend or extension. Plans small steps, waits for approval, writes tests first, implements, runs make ci, and records a DECISIONS entry when a design choice is made.
argument-hint: <what the feature should do>
---

# Build a feature

The order matters: plan, approval, tests, code, gates, docs. Do not skip ahead.

## 1. Read before planning

- `CLAUDE.md`, `.claude/docs/rules.md`, and the open items in `ISSUE.md`.
- Every `docs/DECISIONS.md` entry the feature touches. A feature that would reverse a decision needs the developer's yes and a new entry.
- How the repo already does the nearest job. Trace it end to end, for example: audit log → `backend/src/audit-reader.ts` → `backend/src/server.ts` route → `frontend/src/lib/events.ts` → `frontend/src/components/<page>.tsx`. Reuse that helper or endpoint before adding one.
- For dashboard UI, load the `dashboard-ui` skill. For Docker or listen-address changes, load `agentdock-docker`.

## 2. Write the plan

Plain words, small numbered steps, each one a change you can test on its own:

```
Goal: <one sentence: what the developer can do afterwards>

1. <step>: <files>. Test: <what proves it>.
2. ...

Touches: <endpoints, data shapes, pages, docs>
Decision needed: yes (D-<next>: <one line>) / no
Not doing: <what stays out of scope>
```

- A new endpoint states its method, path, `?project=` handling (D-8), request and response JSON, and its error codes.
- A new endpoint or page passes the same `Host`/`Origin` checks as the rest (D-2). Say how.
- Anything that would write to `.ctrlplane/` is out: the backend reads the audit log only (D-1).
- If a choice has more than one fair answer, run the `brainstorm` agent first and put its recommendation in the plan.

**Stop and wait for the developer's approval of the plan.** After a yes, run all the steps without pausing, unless something destructive or outside the plan comes up.

## 3. For each step: test first, then code

1. Write the test in the workspace's `tests/` folder (`node:test`, `node:assert/strict`). Use a temporary folder and a throwaway `audit.db` for anything that reads the audit log; stop servers and close databases in `finally`.
2. Run it and see it fail for the reason you expect.
3. Write the smallest code that makes it pass. Only erasable TypeScript syntax. No new dependency in `backend/`.
4. Run the test again. Then give the developer one short line: step done, test name, pass.

Put logic the page needs in `frontend/src/lib/events.ts`, where `frontend/tests/` can test it without a browser. Keep components for rendering.

## 4. Check it in the app

For a visible change, build (`make build`), start the backend on a throwaway project, and look at the page at desktop width and at 390 px. Use the `webapp-testing` skill if a scripted check helps. Never point the backend at a real project for this.

## 5. Run the gates

```bash
make ci > ci.log 2>&1; echo "make ci rc=$?"
```

Only `rc=0` counts. Read the test counts from `ci.log`, then delete it. On red, fix and run again; never report done on red.

## 6. Update the docs

- **A design choice was made** (a trade-off, something ruled out): add `## D-<next> · <decision>` to `docs/DECISIONS.md` with **Decision**, **Why** and **Rules out**. Check open PRs for the same number (`gh pr list` and their diffs of `docs/DECISIONS.md`).
- **How to run or configure changed** (a flag, an environment variable, an endpoint): update `README.md`.
- **A known item closed or opened**: update `ISSUE.md`.
- Docs point at code by file and function. No narrative of how the work went.

## 7. Before the PR

- Run the `dead-weight` skill on the branch.
- Fill in `.github/pull_request_template.md` truthfully.

## 8. Report

1. What the feature does now, in plain words.
2. Each touched file: what changed and what depends on it.
3. How it was verified: exact commands and what each proved.
4. Decisions and docs updated.
