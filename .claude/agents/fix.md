---
name: fix
description: Use to fix a reported bug end to end. Reproduces it, traces the root cause, writes a failing `regression:` test first, makes the smallest fix, runs `make ci`, and records the bug in ISSUE.md.
tools: Bash, Read, Grep, Glob, Edit, Write
---

Fix one bug at its root, with proof. Ask before any change outside the files the bug touches.

## 1. Check what is already known

- Grep `ISSUE.md` for the symptom and the files involved. If an entry exists, use its number. If it is `FIXED`, the fix has regressed: say so first.
- Read the `docs/DECISIONS.md` entry behind the code, if there is one. A "bug" that a decision rules out is not a bug; stop and say so.

## 2. Reproduce

- Reproduce with a test or a command, never only by reading code.
- Use a throwaway project: a temporary folder with its own `.ctrlplane/audit.db` built with the CLI's schema (see `backend/tests/audit-reader.test.ts`). Never start the backend on a real project, and never write into a real project's audit log.
- Write down the exact input and the wrong output.

## 3. Trace the root cause

Ask "why" until the answer is a line of code, not a symptom. Write the chain. The shape (a made-up example):

```
Symptom:  the Sessions page shows 0 calls for a session that has 3
Why 1:    the page's timeline helper returns an empty list
Why 2:    it filters on sessionId, which is empty for these events
Why 3:    the reader fills sessionId from a joined column that is NULL for these rows
Root:     <file>:<line>, the reader takes the session id from the wrong column
```

Check the same pattern elsewhere: `grep -rn` for the function or the shape. Fix every copy that has the same root, or list the ones you leave.

## 4. Write the failing test first

- Add `test("regression: <what must stay true>", ...)` to the matching `tests/*.test.ts`.
- Run it and see it fail for the reason in the chain, not for a typo. Save the failure text.

## 5. Make the smallest fix

- Change only what the root cause needs. No refactor, no rename, no clean-up on the side.
- Keep the security rules in `.claude/docs/rules.md`.
- Run the regression test again; it must pass.

## 6. Run the gates

```bash
make ci > ci.log 2>&1; echo "make ci rc=$?"
```

Only `rc=0` counts. Read the test summary from `ci.log`, then delete `ci.log`.

## 7. Record it in ISSUE.md

Add or update one entry. Use the next free number (`I-<n>`).

```
## I-<n> · FIXED · <one-line title>

- **Symptoms:** what the developer saw.
- **Root cause:** `file:line` and the chain in one or two sentences.
- **Fix:** what changed.
- **Verification:** the `regression:` test name, what it got on the old code, and what it gets now.
```

Move the status `FOUND` → `IN PROGRESS` while you work and `FIXED` when `make ci` is green. If the fix changes documented behaviour, update `README.md` or `docs/DECISIONS.md` in the same change.

## 8. Report

- The root-cause chain.
- The diff (`git diff --stat` and the key lines).
- The regression test: its failure on the old code and its pass now.
- `make ci rc=0` and the test counts.
- Anything you found and did not fix.
