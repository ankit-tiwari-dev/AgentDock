---
name: dashboard-ui
description: Use when adding or changing anything visible in the AgentDock dashboard (frontend/src/app/styles.css or frontend/src/components), such as a page, card, list, button, colour or layout. The dashboard's own design system - colour variables, type, ad-/ov-/pg- classes, page patterns, phone rules and CSP limits. Keep the existing look; reuse classes before adding new ones.
---

# The dashboard's design system

The dashboard is a dark, dense, plain-CSS app: one stylesheet (`frontend/src/app/styles.css`), no Tailwind, no component library, no icon package. Every page is built from the same few classes.

**Keep the existing look. Reuse a class before adding one. Ask the developer before changing a colour, font or layout that is already there.** For a new page or a new kind of surface, show one version and get a yes before building the rest.

## Where things live

| What                                          | Where                                                      |
| --------------------------------------------- | ---------------------------------------------------------- |
| Colours, fonts, every class                   | `frontend/src/app/styles.css`                              |
| Shell: sidebar, nav groups, project picker    | `frontend/src/components/dashboard.tsx` (`NAV`)            |
| Page list and the address hash                | `PAGES` and `pageFromHash` in `frontend/src/lib/events.ts` |
| Shared page parts                             | `frontend/src/components/page-parts.tsx`                   |
| Verdict chip                                  | `StatusChip` in `frontend/src/components/overview.tsx`     |
| Logic a page shows (counts, grouping, labels) | `frontend/src/lib/events.ts`, tested in `frontend/tests`   |

## Class prefixes

- `ad-*`: the app shell (`ad-shell`, `ad-side`, `ad-nav`, `ad-badge`, `ad-main`). Change only when the shell changes.
- `ov-*`: the Overview's classes. A few are shared by every page: `ov-btn`, `ov-btn-sm`, `ov-chip-*` (through `StatusChip`), `ov-mono`, `ov-muted`, `ov-kv`, `ov-pre`, `ov-banner`. The rest belong to the Overview.
- `pg-*`: the other pages (`pg-head`, `pg-box`, `pg-facts`, `pg-split`, `pg-picks`, `pg-tl`, `pg-cmd`, `pg-strip`).
- A new class takes the prefix of where it is used. Put it next to its family in the stylesheet, not at the end.

Full class list with what each is for: `references/classes.md`.

## Colours and type

Use the CSS variables in `:root`, never a new hex value. The palette and what each colour means: `references/tokens.md`.

- Verdict colours carry meaning: blocked = `--block-*` (rose), asked you = `--ask-*` (amber), guidance = `--guide-*` (blue), allowed = `--ok-*` (grey-blue). Use them only for those verdicts.
- `--accent` is for focus, the active nav item and the one primary action on a page (`pg-primary`).
- Body text 13 px Inter. Page title `pg-head h1` 22 px. Section title `h2` 15 px, weight 600. Small text 12 to 12.5 px. Numbers on cards `ov-v` 28 px mono.
- Paths, commands, rule ids and tool input go in `<code>`, which uses `--font-mono`.

## Page patterns

Every page except the Overview has the same frame:

1. `<PageHead title lede />`: a short title and one sentence on what the page shows.
2. `<PartialNote snapshot />` when the page is built from events, since the backend sends only the newest ones.
3. Content in `pg-box` cards.

Pick the closest existing pattern:

| Need                           | Pattern                                                        | Example page    |
| ------------------------------ | -------------------------------------------------------------- | --------------- |
| Label and value pairs          | `<dl className="pg-facts">` inside `pg-box`                    | Project         |
| List on the left, detail right | `pg-split` with `pg-picks` buttons and a detail `pg-box`       | Rules, Sessions |
| Grouped list of items          | `pg-group` with `h2`, then `pg-box` and `pg-req` rows          | Waiting on you  |
| A command to copy              | `<CommandLine label command onCopy />` (`pg-cmd`)              | Project         |
| Two cards side by side         | `pg-two`                                                       | Project         |
| Nothing to show                | `<p className="pg-empty">` that says what will appear and when | Rules           |
| A list of calls                | `<Timeline />` (`pg-tl`) with `StatusChip`                     | Sessions, Rules |

A new page also needs: an id in `PAGES`, an entry in `NAV` with its group, and a test in `frontend/tests/pages.test.ts` for any logic it adds.

## Phones and tablets

- Breakpoints in use: 1120 px (narrower padding), 860 px (sidebar becomes a top bar, grids go to one column), 640 px (Overview list), 620 px (tightest padding). Reuse these; do not add new ones.
- Every control a finger presses is at least 44 px tall at 860 px and below. Desktop sizes are 36 to 40 px; the 860 px block raises them.
- At 390 px wide, nothing scrolls sideways. Grids use `minmax(0, 1fr)`; long paths and commands wrap with `overflow-wrap: anywhere`.
- In a `pg-split` page, call `revealOnPhone(detail.current)` after a pick, so the detail scrolls into view under the list.
- Check every change at 390 px and at desktop width before saying it is done.

## Accessibility

- Focus: the global `:focus-visible` outline (2 px `--accent`, 2 px offset). Never remove it.
- Use real elements: `button type="button"` for actions, `a` for navigation, `dl` for facts, `time dateTime` for times.
- The selected item carries `aria-current`. Icon-only and colour-only signals get an `aria-label` or text (see `VerdictStrip`).
- Status that changes on its own (the toast) uses `role="status"`.
- Motion respects `prefers-reduced-motion`; add any new animation to that block.

## Limits the CSP sets

The backend sends a Content Security Policy with every page (`contentSecurityPolicy` in `backend/src/static-files.ts`):

- Scripts: only the dashboard's own files and its build's inline scripts, by hash. No script from another host, no `eval`, no inline event handler strings.
- Styles: own files and inline styles. Fonts: own files only; Inter and JetBrains Mono are bundled from `frontend/src/app/fonts/`. Do not add another font, icon font or CDN.
- Images: own files and `data:` URLs. Icons are inline SVG.
- Network: only this backend and its WebSocket.

Never add a host to the CSP for a UI change. Never build HTML from data (`dangerouslySetInnerHTML` and the like); `frontend/tests/security.test.ts` fails on it.

## Before saying done

1. `make build` passes, then the backend on a throwaway project shows the change.
2. Checked at 390 px and desktop width, keyboard focus visible.
3. `make ci > ci.log 2>&1; echo "make ci rc=$?"` is `rc=0`.
