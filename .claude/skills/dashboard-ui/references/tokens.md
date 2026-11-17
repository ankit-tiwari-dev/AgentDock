# Colour and type variables

All defined in `:root` at the top of `frontend/src/app/styles.css`. Read the file for the current values; this list says what each one is for.

## Surfaces and lines

| Variable      | Use                                                        |
| ------------- | ---------------------------------------------------------- |
| `--bg`        | page background                                            |
| `--side`      | sidebar, and the inset background of `pg-cmd` rows         |
| `--panel`     | cards and boxes (`ov-card`, `ov-panel`, `pg-box`, buttons) |
| `--panel-2`   | a box inside a box (`pg-note-box`)                         |
| `--line`      | card borders                                               |
| `--line-soft` | row dividers inside a card                                 |

## Text

| Variable   | Use                                                    |
| ---------- | ------------------------------------------------------ |
| `--text`   | main text and values                                   |
| `--soft`   | secondary text that still matters (reasons, nav items) |
| `--muted`  | labels, ledes, `dt` in facts lists                     |
| `--subtle` | the quietest text: notes, times, counts after a title  |

## Accent and status

| Variable                                     | Use                                                                    |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| `--accent`, `--accent-ink`                   | focus outline, active nav item, `pg-primary`, logo                     |
| `--green`                                    | good state words (`pg-good`, `pg-ran`), the health dot                 |
| `--amber`                                    | warning words (`pg-warn`), notice panels                               |
| `--blue`, `--rose`                           | defined but used by no rule today; use the verdict pairs below instead |
| `--ok-bg`, `--ok-fg`                         | allowed verdict chip                                                   |
| `--block-bg`, `--block-fg`                   | blocked verdict chip, error banner, backend-down badge                 |
| `--ask-bg`, `--ask-fg`                       | asked-you verdict chip, the sidebar count badge, open requests         |
| `--guide-bg`, `--guide-fg`                   | guidance verdict chip                                                  |
| `--warn-panel`, `--warn-line`, `--warn-text` | a card that needs attention (`ov-card-warn`)                           |

A verdict colour means that verdict everywhere. Do not use the blocked pair for a generic error that is not a blocked call unless the meaning is "stopped" (as the error banner does).

## Fonts

| Variable         | Use                                        |
| ---------------- | ------------------------------------------ |
| `--font-sans`    | everything by default (Inter, then system) |
| `--font-display` | page titles (same stack today)             |
| `--font-mono`    | `code`, numbers on cards, times, ids       |

Inter and JetBrains Mono come from the Google Fonts `@import` on the first line of the stylesheet. `ISSUE.md` → I-14 plans to bundle them or use system fonts. Do not add another font.

## Sizes in use

- Font sizes: 12, 12.5, 13 (body), 13.5, 14, 15 (section titles), 22 (page titles), 26 (Overview title), 28 (card numbers).
- Radius: 6 px chips, 8 px buttons, inputs and nav items, 10 px banners, 12 px cards and boxes, 999 px pills and badges.
- Spacing: gaps of 10 to 20 px between cards; card padding 16 to 20 px.

Pick from these before adding a new size.
