# Class families

Grouped as they appear in `frontend/src/app/styles.css`. Grep the stylesheet and `frontend/src/components` for a class before adding a near-copy.

## Shell (`ad-*`)

| Class                                  | What it is                                                             |
| -------------------------------------- | ---------------------------------------------------------------------- |
| `ad-shell`, `ad-main`                  | the two-column frame; one column at 860 px and below                   |
| `ad-side`, `ad-side-open`              | the sidebar; on a phone a top bar whose menu opens with `ad-side-open` |
| `ad-brand`, `ad-logo`, `ad-brand-text` | logo and name at the top of the sidebar                                |
| `ad-menu-btn`, `ad-menu`               | the phone menu button and the menu it shows                            |
| `ad-group`, `ad-group-h`, `ad-nav`     | nav groups and links; the current page has `aria-current="page"`       |
| `ad-badge`                             | count next to a nav item (Waiting on you)                              |
| `ad-project`                           | project picker, shown with two or more projects                        |
| `ad-side-foot`, `ad-health`, `ad-hdot` | backend status at the bottom of the sidebar                            |

## Shared building blocks (`ov-*` used outside the Overview)

| Class                                                            | What it is                                                                    |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `ov-btn`, `ov-btn-sm`                                            | the button (44 px); `-sm` is 36 px, raised to 44 px on phones inside `pg-cmd` |
| `ov-chip`, `ov-chip-allowed`, `-blocked`, `-review`, `-guidance` | verdict chip; render it with `StatusChip`                                     |
| `ov-mono`, `ov-muted`                                            | mono text, muted text                                                         |
| `ov-kv`, `ov-pre`                                                | key-value list and payload block in the call detail                           |
| `ov-banner`                                                      | full-width error banner (backend not reachable), in the shell                 |

## Overview only (`ov-*`)

`ov-head`, `ov-live*`, `ov-metrics`, `ov-card*`, `ov-k`, `ov-v*`, `ov-columns`, `ov-panel`, `ov-row`, `ov-pills`, `ov-search`, `ov-empty`, `ov-needs`, `ov-session*`, `ov-drawer*`, `ov-why-*`, `ov-sr`. They belong to that page. On another page use the `pg-*` patterns; if one is truly needed elsewhere, move it to the shared list on purpose.

## Pages (`pg-*`)

| Class                                                     | What it is                                                                  |
| --------------------------------------------------------- | --------------------------------------------------------------------------- |
| `pg-head`                                                 | page title and lede; render it with `PageHead`                              |
| `pg-note`, `pg-note-in`, `pg-note-box`                    | quiet notes; `PartialNote` uses `pg-note`                                   |
| `pg-box`                                                  | the card every page section sits in                                         |
| `pg-empty`                                                | empty message inside a `pg-box`                                             |
| `pg-good`, `pg-warn`                                      | a one-word state in green or amber                                          |
| `pg-group`                                                | a titled group of rows (`h2` with a quiet count in a `span`)                |
| `pg-reqs`, `pg-req`, `pg-req-open`, `pg-req-*`            | approval request rows on Waiting on you                                     |
| `pg-ran`, `pg-not-ran`                                    | "Ran afterwards" and "No record it ran" words (D-7)                         |
| `pg-split`                                                | list and detail side by side; one column at 860 px                          |
| `pg-picks`, `pg-pick`, `pg-pick-top`, `pg-pick-sub`       | the pickable list in a split page; the picked one has `aria-current="true"` |
| `pg-state`, `pg-state-on`                                 | small status text with a dot in a pick                                      |
| `pg-detail-head`                                          | title row of the detail card                                                |
| `pg-tl`, `pg-tl-row`, `pg-tl-what`, `pg-tl-target`        | a timeline of calls                                                         |
| `pg-strip`, `pg-t`, `pg-t-<verdict>`, `pg-legend`         | the verdict strip; render with `VerdictStrip` and `StripLegend`             |
| `pg-counts`, `pg-count`                                   | small counts by verdict                                                     |
| `pg-howto`, `pg-cmd`, `pg-cmd-label`                      | a how-to card and copyable command rows (`CommandLine`)                     |
| `pg-two`                                                  | two cards side by side; one column at 860 px                                |
| `pg-facts`                                                | a `dl` of label and value rows; stacks on a phone                           |
| `pg-steps`, `pg-step`, `pg-num`, `pg-step-*`              | numbered steps, used only by Plan & review                                  |
| `pg-field`, `pg-textarea`, `pg-form-foot`, `pg-primary`   | form parts; `pg-primary` is the one main action                             |
| `pg-questions`, `pg-q`, `pg-choice`                       | interview questions and their choices                                       |
| `pg-handoff`, `pg-review`, `pg-review-cols`, `pg-kv-pair` | Plan & review results                                                       |

## Global

| Class or rule                           | What it is                                                    |
| --------------------------------------- | ------------------------------------------------------------- |
| `:focus-visible`                        | 2 px `--accent` outline, 2 px offset, on everything           |
| `sr-only`                               | screen-reader-only text in the shell                          |
| `toast`                                 | copy confirmation, bottom right, `role="status"`              |
| `panel`, `notice-panel`, `content-wrap` | older frame classes still in use; check usage before changing |
