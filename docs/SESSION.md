# The session: receipts, chips and the Session card

Built on the branch `ux/session` (2026-10-02), replacing the side panel
(`aside#panel`, `src/panel.ts`). The round-two mockups are the source:
`docs/mockups/session-panes-v2-peek-v2.html` (the receipt beside the cell,
the flight into the pill, the floating board) and
`docs/mockups/session-panes-v2-ledger-v2.html` (the folded tab at each
cell's corner). The record of the round is
`docs/mockups/session-panes-round-2.md`.

## What Taylor asked for

Looking at peek-v2: "this is the one i'm liking the best right now. i
like the ability to have it floating by clicking on the button in the
top right. id like it to go away when you click anywhere else unless it's
pinned. and then pinning it makes it no longer floating, putting it right
beside the cells like you have it in one of the other demos i saw, just
on the page. but maybe its more of a floating card, instead of the same
look as the code cells. … having the ability to toggle somehow between
the 'peaking' version, where it sort of gives some indication that
something has changed in one of the cards even when hidden, and silent,
where nothing is bumped, and fully pinned open, would be nice."

Then, on receipts, with peek-v2's receipt card and ledger-v2's folded
chips side by side: "i think this version of receipts could work for
permanent receipts. … in the animation, it sends it up to the topbar
location. that's nice. and i actually love that. maybe there's a way to
do that plus a permanent receipt chip on the side like the first
screenshot, and a way to also have the state and data and figures pinned
open on the side."

## What was built

One data structure, the **receipt** (`src/receipts.ts`), under three
surfaces (`src/session.ts`). The cell column is untouched: every surface
lies over the room and none of them moves or narrows the column.

**The receipt.** Every run of a cell produces one: the cell, the time
the run took, the names it bound (`+` new, `~` rebound or changed in
place), the session's other names ("unchanged · prices · n"), the
figures it drew (a thumbnail of the first, through the same sanitizer
as every figure), and what it put in the folder ("to the folder ·
values.json: n · figs/ax.svg", or "no folder yet" when the document has
none). The kernel reports what a run bound on its `done` event (below);
the page marks new against rebound from its last snapshot, then reads
the snapshot after the run, which adds what the AST could not see — a
name bound inside an `if`, a frame changed in place (`prices['q'] = …`).

**The receipt card** (Peek mode). After a run, the card appears beside
the cell: right of the column, past the chips' lane, its top on the
cell's first line, in the frame's dark glass. It stays while you look —
the pointer on it holds it — and goes home into the session pill when
you keep typing, press Esc, click elsewhere, start another run, or
after six seconds. Going home is the flight: the card lifts and swings
along a curve into the pill, shrinking; the pill's names update as it
lands, the new ones blue and lit for a moment, and the chip takes its
place at the cell. `p`, when the keystroke would not type into a cell
(after clicking ▶), or the card's pin keeps it in place until it is
closed (✕ or Esc). A Run all or Run stale never puts up a card.

**The chip.** Once a receipt has flown, a small chip stays at the cell's
right corner, in the lane beside the column (ledger-v2's folded tab,
tied to the column by a hairline): a glyph for what the run made — the
white print for a figure, a table, braces for names — and how many names
it bound. Hover opens the receipt card again, read-only, as it was; a
click keeps it; a click elsewhere or Esc puts it away. The chip changes
when its cell runs again, turns amber with the cell's staleness, and
fades after a restart until its cell runs. A cell whose last run bound
and drew nothing has no chip. When the lane is too narrow for it (a
window under about 990 px) it tucks inside the cell's top-right corner.

**The pill.** The bar's right end: the kernel's status
(`#kernel-status`, its words unchanged, which the shell's smoke reads),
a hairline, the session's mark, and its names in cell order — new names
blue — or "empty session" / "fresh session" in words. When the names do
not fit, the oldest give way to "+N" before the new ones. A click drops
the Session card; while the kernel is not ready, it opens the onboarding
as the status did.

**The Session card.** From the pill, a rounded dark-glass card at the
room's top right, with three tabs: **Session** (the last run's receipt
on top behind a blue rule, then every name with its kind glyph, type,
preview and the cell that bound it; a table's or figure's name opens it,
"cell 4" goes to the cell), **Data** (a chip per table, and the table
viewer, paging 100 rows at a time as the panel did), **Figures** (a chip
per figure, and the figure viewer; it follows each new figure unless
held, and a held one shows "New: …" for the one waiting). A click
anywhere outside closes it, as does Esc; so does the pill and the rail's
Session tile (`#toggle-panel`, lit while the card shows).

**The modes**, a segmented control in the card's header:

- **Peek** (the default): the receipt card and the flight, as above.
- **Silent**: no card, no motion; the chip appears and the pill's names
  change quietly.
- **Pinned**: the card docks beside the column, on the page, in its own
  look (not the code cells'), as a sidebar card that scrolls inside
  itself. A run's receipt goes straight into its top, lit for a moment;
  no card beside the cell; the chip still appears. Choosing Peek or
  Silent unpins it back to floating; closing it unpins it.

Peek or Silent is remembered (localStorage `knuth-receipts`); Pinned is
remembered per window (sessionStorage `knuth-session-pinned`, with the
last choice in localStorage as a new window's start).

**The kernel change.** `Session.bound(names)` (python/knuth/session.py)
returns the snapshot's entry for each name the run assigned, in the
cell's order (`_assigned_names` now keeps it), with `saved` on a value
values.json mirrors; `handle_request` puts it on the `done` event as
`bound`. Both engines run that code, so uv and Pyodide report it alike.
The field is optional — no protocol bump — and validated on the page
(`parseBound`, used by both kernels); an engine without it leaves the
page to its snapshot diff. A failed run's `error` event carries none,
since its assigned names are the AST's, not what was bound before the
error.

**What moved.** The data and figure viewers are `src/viewers.ts`, moved
from `src/panel.ts` with their paging and their sanitizing as they were
(the variables table went: the Session tab is its successor). The
DocumentView gives each cell an id that survives a kind switch and a
delete-and-restore (a `WeakMap` on the Cell), times each run, and
reports it with what the kernel said (`RunInfo`), and marks Run all and
Run stale as a batch. Every shortcut is as it was: Esc is never
prevented, so in a cell it still arms the Esc-Y/S/M chord while it puts
the receipt away.

## The defaults taken

| | default | why |
|---|---|---|
| the receipt card's dwell | **6 s**; the pointer on it holds it, 2 s after it leaves | Taylor's "about six seconds"; long enough to read four lines, short enough not to be furniture |
| the flight | **460 ms**, a quadratic curve that lifts first and swings across into the pill, shrinking to the names' box; the names land at 72 % | peek-v2's 380 ms read as a blink on a real window; the curve is the "sends it up" Taylor liked |
| what puts the card away | typing (a printable key, Enter, Backspace, Delete, Tab), Esc, a click elsewhere, another run, the dwell | peek-v2's "carrying on is the acknowledgement" |
| `p` | keeps the card only when the keystroke would not type (focus off the text) | a plain `p` in a cell must stay a `p`; Esc then P was weighed and left out, since Esc also closes the completion popup and the next `p` would be swallowed |
| when a run gets a card | a single, clean run that bound or drew something; a run whose news only the snapshot saw gets its card when the snapshot lands, unless you carried on meanwhile | a card saying "nothing" is motion for nothing |
| the chip's glyphs | white print = drew a figure; table = bound a DataFrame, Series or 2-D array; braces = names; the count = names bound (or figures drawn, for a figure alone) | ledger-v2's tab, with braces for plain names |
| what the receipt lists from the folder | the bound values values.json mirrors (`saved` from the kernel) and the run's `figs/<name>.svg` receipts; "no folder yet" when the document has no folder | both are what the page already writes; a scratch run lists none |
| new names in the pill | blue until the next single run, or until the Session tab is opened; a batch's add up | round two's rule: opening the Session acknowledges, hovering does not |
| the card beside the cell | 220–300 px wide past a 46 px chips' lane; previews drop under 270 px | the lane at 1500 px is 310 px |
| the docked card | 220–380 px wide past the chips' lane, the room's height less 24 px | the column keeps its width at every size |
| the floating card | 380 px, 10 px in from the room's top right | the tabs, the three modes and ✕ on one line |
| a narrow room | under about a 1435 px window the lane cannot hold a card: the receipt card (290 px) lies over the room's right edge, 12 px in, and the docked card likewise (320 px) | see *What is open*, 1 |
| a restart | the chips fade, the pill says "fresh session", the Session card empties | round two's default |
| a deleted cell | its names stay, marked "deleted cell" | round one's default |
| names bound before the page loaded (a resumed session) | in the pill and the Session tab, with no cell | round two's default |
| the old `knuth-panel` key | ignored; the card starts closed | the panel was open by default, the card is not |

## The record

The screenshots are the checkout shell (`app/knuth.json` on
`~/Projects/claerbout`) on uv, through Playwright's `_electron`, with
`docs/mockups`' demand example as a document (pandas and matplotlib from
its header) in a scratch folder, so the name pill's folder line is that
folder. The page is laid out at 1500 × 940 and 1100 × 760 at 2× by device
metrics emulation, since this screen is 1470 points wide; they are page
captures, so the traffic lights are not in them.

- `docs/session-receipt-1500.png`, `-1100.png`: the receipt beside the
  run cell (cell 4: three new names, the figure, figs/ax.svg to the
  folder); at 1100 it lies over the room's right edge.
- `docs/session-chips-1500.png`, `-1100.png`: the chips at rest after
  Run stale; at 1100 the pill's oldest names give way to "+2".
- `docs/session-floating-1500.png`, `-1100.png`: the Session card from
  the pill.
- `docs/session-pinned-1500.png`, `-1100.png`: docked; at 1500 beside the
  column past the chips, at 1100 over the room's right edge.

## Checks

- `npm test`: green (with `src/receipts.test.ts`, the receipt's rules,
  and the protocol test for `bound`).
- `npm run build:engine`, `npm run check:web`: green.
- `npm run test:browser`: 84 passed. `tests/browser/session.spec.ts`
  (16) drives a mock engine that answers runs with `bound` names and a
  figure: the card beside the cell and its flight into the pill on Esc
  and on typing, the dwell and the pointer holding it, `p`, the chip's
  glyph, count, hover, click and Esc, amber and the restart's fade, the
  Session card from the pill closing on an outside click and Esc, the pin
  docking it with the column's width unchanged and a reload keeping it,
  Silent and Pinned, Run all, a table paging in the Data tab and a figure
  in the Figures tab, a change in place, Esc still arming the kind chord,
  `p` typed in a cell, and the narrow room. The app, protocol and frame
  specs open the card from the pill where they clicked the panel, and the
  frame spec's floor is main's 640 px whether the card is docked or not.
- The checkout-shell smoke, `node ~/Projects/claerbout/smoke.mjs --config
  app/knuth.json browser` and `uv`: ok, with the autosave record's
  subjects. On Pyodide in the shell, a run's receipt lists `answer` and
  `words` with values.json as their folder.
- The engine's tests from the worktree:
  `PYTHONPATH=python ~/Projects/knuth/.venv/bin/python -m pytest
  python/tests -q`: 161 passed, two of them new (`bound` on the done
  event, in order, kinds, previews, `saved`, scratch, none on a failed
  run; and its cap). The venv's editable install points at the main
  checkout, so the PYTHONPATH is what puts the worktree's engine first
  (`../.venv` does not exist from the worktree).

## What is open

1. **A narrow room.** The brief said the card "overlaps the room's right
   edge, never the column". At 1100 px the lane beside the column is
   110 px, and the card is 290, so it cannot be beside the column without
   leaving the window. It now lies over the room's right edge, 12 px in,
   which lays it over the column's last ~180 px (where code lines rarely
   reach, peek-v2's argument). The other way is a lane-wide strip — the
   names alone, about 90 px — which never touches the column but says
   much less. The docked card does the same, which at 1100 covers the
   chips under it (its own top holds the last receipt).
2. **No keyboard pin from inside a cell** (`p` there is a `p`). If one is
   wanted: a chord nothing else uses, or Esc then P with the completion
   popup's Esc excepted.
3. **The receipt card is slim at 1500** (no previews): the lane there is
   310 px, less the chips' lane. Dropping the chips' lane while a card is
   up would give 290 px and the previews.
4. **Chips do not survive the document reloading from disk** (an outside
   edit, `knuth run`): every Cell is new, so the receipts are dropped; the
   names stay in the pill, unowned, until their cells run.
5. **Round two's other parts are not built**: the ledger's margin cards,
   the clamp on dense notebooks, the lean of a wide table, the large
   viewer, the first-run note, a pill name that goes to its cell, Esc-P
   for the Session.
6. **The Session card's header** wraps the modes under the tabs when it
   is docked narrow (under 300 px). One line would need the modes as
   glyphs.
7. **A function's preview** carries its address, so a re-run that
   redefines it always reads as rebound — true, if noisy.
8. `undefined/knuth-pm.png` is committed at the repository's root; it
   predates this branch and is untouched.
