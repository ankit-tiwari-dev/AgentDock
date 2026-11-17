---
name: dead-weight
description: Use before merging a branch, or after removing a feature, endpoint or setting. Finds code the branch left unused and docs (README, DECISIONS, ISSUE, skills) that now contradict the code, proves each with a grep, and removes or corrects them.
argument-hint: "[base branch, default: main]"
---

# Remove what the branch left behind

A branch that removes or changes something often leaves its old helpers, types, settings and doc lines behind. They pass every gate and mislead the next reader. Find them and remove them, with proof.

Base: the argument, or `main`. For a stacked PR, use its base branch (`gh pr view --json baseRefName`).

## 1. List what the branch changed

```bash
git diff --stat <base>...HEAD
git diff <base>...HEAD
```

Note every symbol, route, message type, CSS class, setting and file the branch removed or renamed, and every behaviour it changed.

## 2. Find candidates

**Code with no caller left.** For each export, function, type, CSS class or message type the branch touched or orphaned:

```bash
grep -rn "<name>" backend frontend extension scripts --include='*.ts' --include='*.tsx' --include='*.css' --exclude-dir=node_modules --exclude-dir=out --exclude-dir=.next
```

- A name found only at its own definition is a candidate.
- A name found only in tests is a candidate too: a test for code nothing uses tests nothing.
- Routes: a route in `backend/src/server.ts` with no caller in `frontend/src`, `extension/src` or the docs.
- CSS: an `ad-*`, `ov-*` or `pg-*` class in `frontend/src/app/styles.css` used by no `className`. Grep the class name without its dot; a class may be built from parts (`` `pg-t-${mark}` ``), so check for the prefix too before calling it unused.
- Settings: an environment variable read nowhere, or read but missing from the README table.

**Docs that now contradict the code.** For each changed behaviour, grep the docs for it:

```bash
grep -rn "<route|flag|page name|setting>" README.md docs ISSUE.md CLAUDE.md .claude/docs .claude/skills/README.md .claude/skills/agentdock-ci .claude/skills/agentdock-docker .claude/skills/dashboard-ui
```

- A README line, settings row or endpoint list that no longer matches.
- A `docs/DECISIONS.md` entry whose **Decision** the branch changed. Do not rewrite history: add a new D-entry that replaces it, and add "Replaced by D-<n>" to the old one.
- An `ISSUE.md` entry still `FOUND` that the branch fixed, or a `FIXED` entry whose **Verification** names a test the branch renamed or removed.
- A skill or rules line that names a file, class or command that is gone.

Leave alone the skill folders copied from other projects (listed in `.claude/skills/README.md`).

## 3. Prove each candidate

Before removing anything, check both:

- **Reachability:** no caller in any workspace, test, script, Dockerfile, workflow or the extension's `package.json` (`contributes`, `main`). Dynamic uses (built strings, message types in a `switch`) count as callers.
- **Contract:** nothing outside this repo relies on it. A backend route the extension or `agentdock-cli` calls, or a column the audit reader selects, is a contract even with no caller here. When unsure, keep it and list it.

Drop any candidate that fails either check.

## 4. Fix

- Remove proven dead code, and its tests.
- Correct each doc line to match the code. Do not add history to it.
- Change only what step 3 proved. No other clean-up.

## 5. Verify

```bash
make ci > ci.log 2>&1; echo "make ci rc=$?"
```

Only `rc=0` counts. Delete `ci.log`.

## 6. Report

The shape (made-up rows):

| Removed or fixed              | Where                            | Proof                              |
| ----------------------------- | -------------------------------- | ---------------------------------- |
| `oldHelper`                   | `frontend/src/lib/events.ts:120` | grep: only the definition          |
| README row for a removed flag | `README.md:48`                   | flag read nowhere in `backend/src` |

Then: candidates kept and why, `git diff --stat`, and `make ci rc=0` with test counts.
