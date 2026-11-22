---
description: Find and fix the root cause of a bug in the dashboard, backend or extension. Ground truth from the audit log and backend output first, then narrow the failing stage, then fix at the root with a regression test.
argument-hint: <what the developer saw>
---

Investigate this bug: $ARGUMENTS

Do not guess from code first. Find what the data says, then find the stage where it goes wrong.

## 1. Write down the symptom

- What was seen, on which page or endpoint, with which project.
- What was expected instead.
- When it started, if known: `git log --oneline -15` for recent changes in the area.
- Grep `ISSUE.md` for the symptom. A `FIXED` entry that matches means a regression; name it.

## 2. Get the ground truth

Every value the dashboard shows comes from one chain: `<project>/.ctrlplane/audit.db` → `backend/src/audit-reader.ts` → `/api/dashboard/state` and `/ws/events` → `frontend/src/lib/events.ts` → the page component. Check the start of the chain first.

**The audit log, read-only.** Never open it for writing.

```bash
node --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1], { readOnly: true }); console.table(db.prepare(process.argv[2]).all()); db.close();" \
  "<project>/.ctrlplane/audit.db" \
  "SELECT id, session_id, event_type, tool_name, policy_verdict, created_at FROM events ORDER BY rowid DESC LIMIT 20"
```

Use `PRAGMA table_info(events)` to see which columns this CLI version writes (`rule_id` exists only in newer ones, see I-12).

**The backend.** Read its terminal output: start-up lines and errors. Then ask it directly:

```bash
curl -s http://127.0.0.1:45820/api/health
curl -s http://127.0.0.1:45820/api/projects
curl -s "http://127.0.0.1:45820/api/dashboard/state?project=<id>" > state.json
```

`curl` sends no `Origin`, so the `Host`/`Origin` checks let it through. Delete `state.json` when done.

## 3. Narrow the failing stage

Compare each stage with the one before it:

| Stage           | Right if                                                           | Code to read                    |
| --------------- | ------------------------------------------------------------------ | ------------------------------- |
| Audit log       | the rows you expect are there                                      | (the CLI writes it)             |
| Reader          | the API returns the same rows, mapped right                        | `backend/src/audit-reader.ts`   |
| API and stream  | the state and `/ws/events` messages carry them                     | `backend/src/server.ts`         |
| Dashboard logic | the helper in `frontend/src/lib/events.ts` returns the right value | `frontend/src/lib/events.ts`    |
| Page            | the component shows what the helper returned                       | `frontend/src/components/*.tsx` |

The first stage that is wrong holds the bug. If the audit log itself is wrong, the bug is in `agentdock-cli`: say so and stop.

## 4. Reproduce on a throwaway project

- Build a temporary folder with its own `.ctrlplane/audit.db`, using `createAuditDb()` from `backend/tests/live-view-fixture.ts`, and the rows that trigger the bug.
- Never write into a real project's audit log, and never start the backend with `--project` on a real project to test a fix.
- For a page bug, start the backend on the throwaway project and use the `webapp-testing` skill.

## 5. Find the root cause

Ask "why" until the answer is a `file:line`. Grep for the same pattern elsewhere; fix every copy with the same root, or list them.

## 6. Fix at the root

1. Write `test("regression: <what must stay true>", ...)` in the matching `tests/*.test.ts`. Run it; see it fail for the right reason.
2. Make the smallest change at the failing stage. Do not patch a later stage to hide it.
3. Run the test again; it passes.
4. Run `make ci > ci.log 2>&1; echo "make ci rc=$?"`. Only `rc=0` counts. Delete `ci.log`.
5. Add or update the `ISSUE.md` entry: symptoms, root cause `file:line`, fix, verification (what the test got before and after).

## 7. Report

- The ground truth you found and the stage where it went wrong.
- The root-cause chain.
- The diff, the regression test's before and after, and `make ci rc=0` with test counts.
