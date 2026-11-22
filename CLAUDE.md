# AgentDock: rules for working in this repo

## Skills

- Whenever a task needs a skill, pick it from the skill picker in `.claude/skills/README.md` first. Use a global skill only when none there covers the task, and never a skill written for another project.

## Session start

- Read this file, the open items in `ISSUE.md` and `git log --oneline -10` before the first change. Detail: `.claude/docs/rules.md` → "Session start".

## Run everything through make

- Read `CONSTRAINTS.md` before writing code. Do not weaken it to make a change pass. `make constraints` runs its checks; the hooks in `.claude/settings.json` run them after each edit and at task end.
- Run every gate from the repo root through `make`: `make ci` (lint, typecheck, build, hygiene, test, in CI's order), or one of `make lint`, `make typecheck`, `make build`, `make hygiene`, `make test`. `make format` fixes Prettier.
- Read the real exit code: `make ci > ci.log 2>&1; echo "make ci rc=$?"`. NEVER pipe `make` into `tail`, `head` or `grep` and read that as pass or fail. Only `rc=0` is green. Delete `ci.log` afterwards; `hygiene` fails on `*.log`.
- NEVER say a change is done without a green `make ci` and its test counts.
- Every bug fix gets a `regression: …` test that fails before the fix and passes after.
- Tests and browser checks use throwaway projects in a temporary folder. NEVER start the backend on a real project for a test, and NEVER write into a real project's `.ctrlplane/audit.db`.
- Only erasable TypeScript syntax (no `enum`, `namespace`, parameter properties). No new npm dependency in `backend/`.

## Agents, commands and skills

| Name               | Kind    | When                                                                |
| ------------------ | ------- | ------------------------------------------------------------------- |
| `verify`           | agent   | Run the gates and report pass or fail per gate                      |
| `review`           | agent   | Review a diff, branch, file or PR against these rules               |
| `fix`              | agent   | Fix a reported bug: root cause, regression test, `ISSUE.md` entry   |
| `brainstorm`       | agent   | A decision with more than one fair answer; analysis only, no code   |
| `audit`            | agent   | Sweep the repo or a module; write findings to `ISSUE.md` as `FOUND` |
| `cleanup`          | agent   | Close one open `ISSUE.md` item                                      |
| `/investigate-bug` | command | Find a bug from the audit log and backend output inward             |
| `/retro`           | command | After a task: save lessons, promote one after three repeats         |
| `feature`          | skill   | Plan, approval, tests first, code, `make ci`, docs                  |
| `pr-review`        | skill   | Review a GitHub PR; post comments only after a yes                  |
| `dead-weight`      | skill   | Before merge: remove what the branch left unused, fix stale docs    |
| `merge-readiness`  | skill   | Is a PR ready to merge; report only                                 |
| `dashboard-ui`     | skill   | Any visible dashboard change                                        |
| `agentdock-ci`     | skill   | Before a push, or when a GitHub check fails                         |
| `agentdock-docker` | skill   | Dockerfile, `compose.yaml`, listen address or port changes          |

- NEVER merge, approve, force-push or delete a branch unless the developer says so for that PR. NEVER post a PR comment before the developer says yes to its text.

## Docs and history

- `docs/DECISIONS.md` holds why: one `D-<n>` entry per decision with Decision, Why and Rules out. A new decision takes the next free number across `main` and open PRs.
- `ISSUE.md` holds bugs and findings: `I-<n>`, status `FOUND` → `IN PROGRESS` → `FIXED`, with symptoms, root cause `file:line`, fix and verification.
- `README.md` holds how to install, run and configure.
- Docs point at code by file and function. No test-run output or phase narratives in docs. A doc that contradicts the code is a bug: fix it in the same change.
- NEVER name, quote or point at planning documents in any repo file, commit or PR.
- Full rules for tests, docs, security, PRs, self-correction and adding instructions: `.claude/docs/rules.md`.

## Code comments

- Comment only a non-obvious why: a security reason, a platform quirk, a rule from a decision.
- One sentence. No block comments, no step-by-step comments, no notes about your own edit.
