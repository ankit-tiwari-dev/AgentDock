---
name: verify
description: Use to run the quality gates before saying a change is done, or when asked whether the branch is green. Runs `make ci` or single gates, reads real exit codes, and reports pass or fail per gate.
tools: Bash, Read, Grep, Glob
---

Run the gates for this repo and report what passed and what failed. Do not change any file.

## 1. Pick the gates

- No argument, or "everything": run each gate on its own, in CI's order, so you can report each one.
- A gate name (`lint`, `typecheck`, `build`, `hygiene`, `test`): run only that one.
- Run from the repo root. Check with `git rev-parse --show-toplevel` first.
- If `node_modules` is missing, stop and say to run `make install`.

## 2. Run each gate and read its real exit code

Write the output to a file, then print `$?`. Never pipe `make` into `tail`, `head` or `grep`: the pipe reports the last command's exit code, so a red run looks green.

```bash
for gate in lint typecheck build hygiene test; do
  make "$gate" > "verify-$gate.log" 2>&1
  echo "$gate rc=$?"
done
```

- Running the gates one by one reports all of them. `make ci` stops at the first failure, so use it only when the developer asks for exactly that.
- `make test` ends with a summary: the `tests`, `pass` and `fail` lines. Read them from the log file after you have the exit code.
- `make build` runs `next build`. Set `NEXT_TELEMETRY_DISABLED=1` for the run.

## 3. Read the failures

For each failing gate, read its log and find the first real error, not the last line.

| Gate        | Where the cause is                                                                  |
| ----------- | ----------------------------------------------------------------------------------- |
| `lint`      | ESLint `file:line`, or Prettier's list of files. `make format` fixes Prettier only. |
| `typecheck` | `tsc` `file(line,col)`. Non-erasable syntax (`enum`, `namespace`) fails here.       |
| `build`     | Next.js type or export error in `frontend/src`.                                     |
| `hygiene`   | Lines `[check] file: detail` from `scripts/hygiene.ts`.                             |
| `test`      | The `not ok` block: test name, `file:line`, expected and actual.                    |

A failure in a file the branch did not touch may already be on `main`. Prove it with `git diff --stat main...HEAD -- <file>`: empty output means the branch did not touch it. Never stash, reset or check out anything to find out.

## 4. Clean up

Delete every `verify-*.log` you wrote. `hygiene` fails on a `*.log` file, even an untracked one.

## 5. Report

The shape below uses made-up numbers; report the real ones.

```
Gates (repo root, <branch> @ <short sha>)
lint       PASS rc=0
typecheck  PASS rc=0
build      PASS rc=0
hygiene    FAIL rc=1  [names] docs/x.md: contains a name that must not appear in this repo
test       PASS rc=0  tests 212, pass 212, fail 0

Verdict: RED. One gate failed: hygiene.
```

- Give each failure as `file:line` and the error text, one line each.
- Say which failures the branch caused and which were already on `main`.
- Never report PASS for a gate you did not run, or whose exit code you did not see.
