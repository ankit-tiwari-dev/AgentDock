# Constraints

What "good enough to merge" means for this repo, with the command behind each number. An agent reads this before writing code and never weakens it to make a change pass: fix the code, or add a dated exception below and say so in the PR. Tightening a number needs no discussion; loosening one does (`docs/DECISIONS.md` → D-12).

Last reviewed: 2026-11-21 by @ankit-tiwari-dev

## Floor (always enforced, blocks from day one)

Checked by `npm run check:floor` (`scripts/floor-guard.ts`) on the diff against `origin/main`: after every agent edit and in CI.

- No new suppression comments: `@ts-ignore`, `@ts-nocheck`, `@ts-expect-error`, `eslint-disable`, `istanbul`/`c8`/`v8 ignore`, `nosemgrep`, `gitleaks:allow`
- No unfinished work: a "not implemented" throw, an empty `catch {}`, a new `TODO` or `FIXME`
- No easier tests: no `.skip`, `.todo` or `.only`, no `{ skip: true }`, no deleted test file, no assertion removed from a test that stays
- No secrets in source: gitleaks over the full history (`.github/workflows/security.yml`)
- This file is not weakened: no threshold loosened, rule removed, exception added or extended, or path added to `.constraintsignore`

## Enforced with numbers

| Dimension                 | Rule                                                                                                                                                           | Checked by                                      | Runs at      | Blocking        |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------ | --------------- |
| Types                     | Zero type errors                                                                                                                                               | `npm run typecheck`, `npm run build` (`.tsx`)   | task end, CI | yes             |
| Lint                      | Zero ESLint errors                                                                                                                                             | `npm run lint`                                  | task end, CI | yes             |
| Format                    | Prettier reports no file                                                                                                                                       | `npm run format:check`                          | task end, CI | yes             |
| Repo rules                | `scripts/hygiene.ts` reports nothing                                                                                                                           | `npm run hygiene`                               | CI           | yes             |
| Tests                     | Every test passes on Linux, Windows and macOS with Node 22 and 24                                                                                              | `npm test`                                      | CI           | yes             |
| Container                 | The image builds and serves the dashboard read-only (D-4)                                                                                                      | `npm run docker:smoke`                          | CI           | yes             |
| Security: code            | No CodeQL alert                                                                                                                                                | CodeQL (`security.yml`)                         | CI           | yes             |
| Security: dependencies    | No known vulnerability without a dated exception in `osv-scanner.toml`                                                                                         | osv-scanner, dependency review (`security.yml`) | CI           | yes             |
| Coverage of changed lines | >= 80% of added executable lines covered                                                                                                                       | `npm run check:coverage`                        | task end, CI | from 2026-12-05 |
| Architecture              | backend, frontend and extension never import each other; the backend's only npm import is `@anthropic-ai/sdk` (D-10); no import cycle; src never imports tests | `npm run check:arch` (dependency-cruiser)       | task end, CI | from 2026-12-05 |
| CLI copies                | Every file in `scripts/cli-copies.ts` matches agentdock-cli `main`; update a copy only with `--sync`                                                           | `npm run check:cli-copies`                      | CI           | from 2026-12-05 |
| Page LCP                  | at most 1600 ms on every dashboard page                                                                                                                        | `npm run check:pages` (Lighthouse, desktop)     | CI           | from 2026-12-05 |
| Page CLS                  | at most 0.2 on every dashboard page                                                                                                                            | `npm run check:pages`                           | CI           | from 2026-12-05 |
| Accessibility             | at most 1 failing serious or critical audit on any dashboard page                                                                                              | `npm run check:pages` (axe-core via Lighthouse) | CI           | from 2026-12-05 |

Why these numbers:

- **80% of changed lines:** high enough that new code comes with a test, low enough to allow a line no test can reach. The gate counts only lines the coverage report marks executable, in files a test loads; `.tsx` components are not loaded by the tests and are not counted.
- **Pages, measured and held.** On 2026-11-21 (Windows, Chrome, the seven pages on a seeded throwaway project) the worst page measured LCP 1289 ms (Waiting on you), CLS 0.182 (Rules) and one serious accessibility audit (`label-content-name-mismatch` on Overview, Sessions and Rules). LCP is that plus 25% for run-to-run noise; CLS and accessibility hold today's worst page. The targets are the Core Web Vitals "good" line, CLS 0.1, and zero serious or critical audits: tighten these rows as the pages reach them. Re-measure from the CI `constraints` job before 2026-12-05, since CI runs on Linux.
- **2026-12-05:** two weeks of warnings to tune the new gates before they block. `scripts/warn-window.ts` holds the date; after it a failure fails the run.

## Ratchets

Today's value, held. The value moves up when the code improves and never down.

| Metric                  | Today  | Direction                           | Checked by               |
| ----------------------- | ------ | ----------------------------------- | ------------------------ |
| Project line coverage   | 94.81% | must not fall (0.5 point tolerance) | `npm run check:coverage` |
| Project branch coverage | 90.42% | must not fall                       | measured only            |

Measured 2026-11-21 with `npm run test:coverage` (Node 26.13, Windows). The 0.5 point tolerance absorbs a moved unrelated file.

## Exceptions

| ID  | Rule | Path | Reason | Owner | Expires |
| --- | ---- | ---- | ------ | ----- | ------- |

## Known gaps

- The page check runs the built dashboard against the real backend, but only in CI: it needs `npm run build` and a Chrome install, and takes over two minutes.
- Coverage does not see the React components (`frontend/src/components/*.tsx`): the tests run under Node, which does not load `.tsx`. The build and the page check are what exercise them.

## When each check runs

| Stage                                          | What runs                                                                      | Budget        |
| ---------------------------------------------- | ------------------------------------------------------------------------------ | ------------- |
| After each agent edit (PostToolUse)            | floor                                                                          | a few seconds |
| Task end (Stop hook, `npm run check:task`)     | lint, format, typecheck, floor, tests with coverage, architecture, in parallel | under 90 s    |
| CI (`make constraints`, the `constraints` job) | all of the above plus the page check, and every existing gate                  | no limit      |

The hooks live in `.claude/settings.json` and call `scripts/agent-check.ts`. The Stop hook runs only when the working tree has uncommitted code changes.
