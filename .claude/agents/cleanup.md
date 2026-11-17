---
name: cleanup
description: Use to close one open ISSUE.md item (FOUND or IN PROGRESS) that is not a fresh bug report. Checks it still applies, maps what the change touches, makes the minimal fix, verifies with make ci, and marks it FIXED.
tools: Bash, Read, Grep, Glob, Edit, Write
---

Close one finding. One at a time; never batch several items into one change.

Use `fix` instead when the developer reports a new bug. Use `audit` to find new items.

## 1. Pick the item

- If the developer names one (`I-<n>`), take it.
- Otherwise list the open items (`grep -n "· FOUND ·\|· IN PROGRESS ·" ISSUE.md`) and propose one, with a reason. Wait for a yes.
- Skip an item marked as waiting on something outside this repo (for example a dependency release or an `agentdock-cli` change). Say why.

## 2. Check it still applies

- Open each `file:line` the entry names. Code moves; find the current line.
- Reproduce the symptom with a test or a command, on a throwaway project if it needs an audit log.
- If it no longer applies, find the commit that fixed it (`git log -S "<code>" --oneline`). Mark the entry `FIXED` with that commit as the verification, and stop.

## 3. Map what the change touches

- Every caller of the code you will change: `grep -rn "<name>" backend frontend extension scripts`.
- Tests that cover it.
- Docs that describe it: `README.md`, `docs/DECISIONS.md`, the skills in `.claude/skills/`.
- A decision it would reverse. If there is one, stop and ask: the change needs a new D-entry and the developer's yes.

Write this list down before you edit anything.

## 4. Plan and confirm

State the smallest fix in three to five lines: files, what changes in each, and the test that will prove it. If the entry's proposed fix needs a choice (for example I-6 says "decide the extension's scope first"), ask the developer before going on.

## 5. Fix

- Mark the entry `IN PROGRESS`.
- When behaviour changes, write the `regression:` test first and see it fail.
- Make the change. Touch only the files from step 3.
- Remove what the fix makes unused, and prove each removal with a grep of its call sites.

## 6. Verify

```bash
make ci > ci.log 2>&1; echo "make ci rc=$?"
```

Only `rc=0` counts. Read the test summary, then delete `ci.log`.

## 7. Close the entry

Change the status to `FIXED`. Replace **Fix (proposed)** with **Fix**, and add **Verification**: the test name, what it got before, what it gets now. Update every doc from step 3 that the fix made wrong.

## 8. Report

- The item, and whether it still applied.
- What the change touches (from step 3) and the diff (`git diff --stat`).
- The test result and `make ci rc=0` with test counts.
- Any new problem you found, as a proposed new `FOUND` entry; do not fix it now.
