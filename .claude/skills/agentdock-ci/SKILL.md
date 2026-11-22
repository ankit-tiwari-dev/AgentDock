---
name: agentdock-ci
description: Use before pushing to AgentDock or when one of its GitHub checks fails. Maps every CI job to the local command that reproduces it, says how to read a failing job, and lists the repo rules CI enforces that are easy to miss.
---

# AgentDock CI

## Before you push

Run the whole local gate and read its exit code. A pipe (`make ci | tail`) reports the exit code of `tail`, so a red run looks green.

```bash
make ci > ci.log 2>&1; echo "make ci rc=$?"
```

`make ci` runs, in CI's order: ESLint, the Prettier check, typecheck, the dashboard build, `hygiene`, and every test. Only `rc=0` counts as green.

## Each GitHub check and how to reproduce it

| Check (workflow)                                                  | What it runs                                     | Locally                                                                                                                             |
| ----------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| lint, format, typecheck, build, hygiene, workflow lint (`ci.yml`) | `npm ci`, the five gates, then actionlint        | `make ci`, then `go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 -color` (needs Go)                                       |
| test (ubuntu/windows/macos, node 22/24) (`ci.yml`)                | `npm ci`, `npm test` on six machines             | `npm test` on yours. See "Six machines" below                                                                                       |
| docker image (build and smoke test) (`ci.yml`)                    | `node scripts/docker-smoke.ts`                   | Same command, needs Docker. Use the `agentdock-docker` skill                                                                        |
| CodeQL (`security.yml`)                                           | Static analysis of the JavaScript and TypeScript | No local copy. Read the alert on the PR                                                                                             |
| dependency review (`security.yml`, pull requests only)            | Flags new dependencies with known problems       | `git diff origin/main -- package-lock.json` shows what was added                                                                    |
| known vulnerabilities (OSV) (`security.yml`)                      | OSV scan of `package-lock.json`                  | `go run github.com/google/osv-scanner/v2/cmd/osv-scanner@v2.7.0 scan source --config osv-scanner.toml --lockfile package-lock.json` |
| secret scan (full history) (`security.yml`)                       | gitleaks over every commit                       | `go run github.com/zricethezav/gitleaks/v8@v8.30.1 git --redact --no-banner .`                                                      |

## Releases

Pushing a tag `v*` runs `release.yml`: the CI and security workflows again, a check that the tag equals `v` + the `version` in the root `package.json`, an osv-scanner scan of the built image that blocks on any known vulnerability, then the image pushed to `ghcr.io/ankit-tiwari-dev/agentdock` with an SBOM, provenance and an attestation, and a GitHub Release (D-14). Reproduce the scan with `docker build -t agentdock:release .` and `osv-scanner scan image --config osv-scanner.toml agentdock:release`. Bump the version in the same pull request, never re-push or move an existing tag, and only tag after the developer says yes.

## Six machines, one laptop

The test job runs on Linux, Windows and macOS. A test that passes on your machine can still fail on another one when it depends on:

- path separators (`\` and `/`): build paths with `node:path`, never by joining strings;
- line endings: `.gitattributes` stores every text file with LF;
- time zone and locale: compare timestamps as numbers, not as formatted text;
- open files on Windows: close every SQLite database and stop every server in `finally`, or the temporary folder cannot be removed.

## Reading a failed check

```bash
gh pr checks <pr-number>
gh run view <run-id> --log-failed
```

Reproduce the failure locally before changing anything, then follow the `systematic-debugging` skill. A check that fails on one operating system only is a "Six machines" case until proven otherwise.

## Rules CI enforces that are easy to miss

- Every `uses:` in `.github/workflows/` names a full 40-character commit SHA, with the version in a trailing comment. `hygiene` fails on a tag such as `@v7`.
- `hygiene` (`scripts/hygiene.ts`) also fails on: names that must never appear in the repo (stored only as hashes in that file), wording or paths from private planning documents, tracked build output or local state (`node_modules/`, `*.db`, `.env`), CRLF in the index, a workspace without a test, and lockfile drift. It checks untracked files too, so it catches a problem before the commit.
- The skill folders copied from other projects (listed in `.claude/skills/README.md`) are kept exactly as published, so Prettier skips them (`.prettierignore`). A new copied folder needs an entry there too.
