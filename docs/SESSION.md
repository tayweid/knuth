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
surfaces (`src/session.ts`). Every surface stands beside the cell column
and never over it: the receipt card in the room's margin, the docked
Session card past the chips' lane; the column slides left for either
(*Second pass*, below, has the rule).

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
the cell: right of the column, over the chips' lane (its own chip is
hidden while it is up), its top on the cell's first line, in the frame's
dark glass. Its width follows the room's margin, up to 300 px; a margin
under 200 px slides the column left by the difference for the card's
stay. It stays while you look —
the pointer on it holds it — and goes home into the session pill when
you keep typing, press Esc, click elsewhere, start another run, or
after six seconds. Going home is the flight: the card lifts and swings
along a curve into the pill, shrinking; the pill's names update as it
lands, the new ones blue and lit for a moment, and the chip takes its
place at the cell, and the column, if it slid, slides back. A click
anywhere on the card, `p` when the keystroke would not type into a cell
(after clicking ▶), or the card's pin keeps it in place until it is
closed (✕ or Esc); its hint says which works now ("type or esc ↗ · click
to keep" in a cell, "· p keeps it" elsewhere). A Run all or Run stale
never puts up a card.

**The chip.** Once a receipt has flown, a small chip stays at the cell's
right corner, in the lane beside the column (ledger-v2's folded tab,
tied to the column by a hairline): a glyph for what the run made — the
white print for a figure, a table, braces for names — and how many names
it bound. Hover opens the receipt card again, read-only, as it was,
past the chip; a click keeps it; a click elsewhere or Esc puts it away.
Docked, the chip's receipt shows in the Session card's band instead. The chip changes
when its cell runs again, turns amber with the cell's staleness, and
fades after a restart until its cell runs. A cell whose last run bound
and drew nothing has no chip. When the lane is too narrow for it (a
window under about 990 px) it tucks inside the cell's top-right corner.

**The pill.** The bar's right end: the kernel's status
(`#kernel-status`, its words unchanged, which the shell's smoke reads),
a hairline, the session's mark, and its names in cell order — new names
blue — or "empty session" / "fresh session" in words. When the names do
not fit, the least recently bound give way to "+N", and never the names
a receipt is bringing home or the last run bound. A click drops the
Session card; while the kernel is not ready, it opens the onboarding as
the status did. In source and grid views it rests, its title saying
why (there are no cells for the card to stand beside).

**The Session card.** From the pill, a rounded dark-glass card at the
room's top right, with three tabs: **Session** (the band: the last
run's receipt on top behind a blue rule, "Last run · cell 3", each name
with its kind and its value under it — a table of six rows or fewer
whole, the figure at the card's width; then every name with its kind
glyph, type, preview and the cell that bound it; a table's or figure's
name opens it, "cell 4" goes to the cell), **Data** (a chip per table, and the table
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
  itself; the column slides left by only what the card lacks (narrowing
  under about 1275 px). A run's receipt goes straight into its band,
  lit for a moment; no card beside the cell; the chip still appears, and
  its hover or click shows its cell's receipt in the band ("Earlier run ·
  cell 2"). Choosing Peek or Silent unpins it back to floating; closing
  it unpins it.

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
| the flight | **460 ms**, a quadratic curve that lifts first and swings across into the pill, shrinking to the names' box, above the bar; opaque until it is seven eighths of the way, the names lighting then (at 60 % of the time) while it still shows, gone only as it settles into them | peek-v2's 380 ms read as a blink on a real window; the curve is the "sends it up" Taylor liked; the first pass faded it before it reached the pill |
| what puts the card away | typing (a printable key, Enter, Backspace, Delete, Tab), Esc, a click elsewhere, another run, the dwell | peek-v2's "carrying on is the acknowledgement" |
| keeping a run's card | a click anywhere on it (but its pin, ✕, a table or the figure, which act on their own); `p` only when the keystroke would not type (focus off the text); the hint names what works now | after ⌘↩ the cursor stays in the cell, where a `p` must stay a `p`; Esc then P was weighed and left out, since Esc also closes the completion popup and the next `p` would be swallowed |
| when a run gets a card | a single, clean run that bound or drew something; a run whose news only the snapshot saw gets its card when the snapshot lands, unless you carried on meanwhile | a card saying "nothing" is motion for nothing |
| the chip's glyphs | white print = drew a figure; table = bound a DataFrame, Series or 2-D array; braces = names; the count = names bound (or figures drawn, for a figure alone) | ledger-v2's tab, with braces for plain names |
| what the receipt lists from the folder | the bound values values.json mirrors (`saved` from the kernel) and the run's `figs/<name>.svg` receipts; "no folder yet" when the document has no folder | both are what the page already writes; a scratch run lists none |
| new names in the pill | blue until the next single run, or until the Session tab is opened; a batch's add up | round two's rule: opening the Session acknowledges, hovering does not |
| the card beside the cell | a run's 6 px from the column (over the chips' lane), a chip's past its chip; as wide as the margin up to 300 px, 8 px in from the room's edge; slim under 270 px (a short value — a number, a string of 16 characters or fewer — in place of its kind, the kind in the tooltip); a margin under 200 slides the column left by the difference, and the card then takes down to 160 | about 280 px with previews at 1470–1500; 186 px slim at 1100 with the column all the way left |
| the docked card | clamp(320, what is beside the column, 380) wide past the chips' lane, 10 px in from the room's right edge, the room's height less 24 px; inside the room | peek-v2's board |
| the column, docked | margin-left max(0, min(centred, room − column − need)), need = the card, the lane and its gap less the room's own 24 px margin; narrows under about 1275 px to a 640 px floor; under about 1085 px the room's floor rises and it scrolls sideways | peek-v2's rule, and Taylor's "right beside the cells … just on the page" |
| the slide | 0.36 s, cubic-bezier(.2,.7,.2,1), on the pin and for a receipt's stay (the card riding beside the column on the same curve); never on a resize, never on a run | peek-v2's timing |
| cell numbers | the code cells only, 1-based (cell zero, the preamble, is 0); text cells uncounted | no number is drawn on the page, so a student counts the cells that run |
| the floating card | 380 px, 10 px in from the room's top right | the tabs, the three modes and ✕ on one line |
| a narrow room | under about a 1075 px window the receipt card, 160 px, lies at the room's right edge over the column's (after sliding it all the way left); the docked card never does: the room scrolls sideways | see *What is open*, 1 |
| a restart | the chips fade, the pill says "fresh session", the Session card empties | round two's default |
| a deleted cell | its names stay, marked "deleted cell" | round one's default |
| names bound before the page loaded (a resumed session) | in the pill and the Session tab, with no cell | round two's default |
| the old `knuth-panel` key | ignored; the card starts closed | the panel was open by default, the card is not |

## Second pass: the reviewers' findings

Two reviewers drove the first pass on the checkout shell (uv and
Pyodide, 900 to 1500 px). The flight, the chips and the floating card
worked as Taylor asked; Pinned did not. At Taylor's 1440–1470 the docked
card was a 230 px strip of names with no values, and under about 1435 px
it lay over the column's right edge and every chip — at the app's
default 1100 window too — "floating there all the time". The receipt
card did the same under 1435, and at full width it said `n int` where
the value was the point. The decisions taken on the findings, and what
was built:

1. **Pinned slides the column** (peek-v2's board rule). Docking gives
   #sheet a margin-left of max(0, min(centred, room − column − need)),
   need being the card's width, the chips' lane and its gap less the
   room's own margin; the column slides left, its width unchanged, by
   only what the card lacks, over 0.36 s, on the pin, and a run never
   changes it. The card is clamp(320, free, 380) wide. Under about
   1275 px the column narrows while docked, to a 640 px floor (656 at
   1100); under what the floor allows (about 1085 px) the room's floor
   rises and the room scrolls sideways, the card past the column's edge,
   never over its text. The docked card is inside the room, so it goes
   sideways with the column. This replaces "the column untouched" for
   the docked card only; unpinned, nothing moves. Taylor's words:
   "putting it right beside the cells like you have it in one of the
   other demos i saw, just on the page".
2. **The band keeps the values.** Each name on its line with its kind
   at the right and its value under it: the preview on one line, a table
   of six rows and columns or fewer whole as a mini table (asked of the
   kernel once per receipt, and only while the name still holds that
   run's value), the figure at the card's width.
3. **A chip while docked** lights its cell's receipt in the band,
   "Earlier run · cell 2" behind a grey rule, scrolled into view — no
   card over the docked one. A hover from the Data or Figures tab goes
   back there when it ends; a click keeps the band until Esc, a click
   elsewhere or the next run.
4. **The receipt card never covers the column.** A run's card stands
   6 px from it, over the chips' lane; a chip's past its chip. Its width
   follows the margin up to 300; under 200 the column slides left by the
   difference for the card's stay — the same margin rule, animated, the
   card riding beside the column on the same curve — and slides back once
   the flying card has lifted clear. With the column all the way left,
   the card takes what there is down to 160 (186 at 1100). A slim card
   shows a short value in place of its kind.
5. **Keeping it.** A click anywhere on a fresh card keeps it (the cursor
   stays in the cell); the hint says "type or esc ↗ · click to keep"
   while a text entry has the focus and "· p keeps it" only where p
   would keep it, on one line.
6. **The pill** hides the least recently bound names first (a running
   count of bindings), never the names a receipt is bringing home or the
   last run bound; the first pass hid from the bottom of the document,
   which is the cell being worked on. It is laid out once per paint —
   every width read in one pass, the hiding worked out in script and
   written at the end — where the first pass reflowed once per hidden
   name (518 ms for 1500 names on the reviewer's machine); with 1,505
   names a run and its flight now leave no task over 50 ms. In source
   and grid views the pill rests (aria-disabled, its title saying why),
   and the card cannot be opened where it cannot be seen.
7. **Cell numbers** count the code cells only; the receipt says "Cell 3"
   for the third cell that runs, the text cells between uncounted.
8. **The flight** stays opaque until it is nearly in the pill, flies
   above the bar, and the names light while it still shows.
9. **Merged with main**: the 44 px bar, 30 px pills and 32 px tiles; the
   session pill takes main's numbers (30 px, 12 px in, 9 px corners) and
   the frame spec measures it at 30. The committed web is rebuilt from
   both.

## The record

The screenshots are the checkout shell (`app/knuth.json` on
`~/Projects/claerbout`) on uv, through Playwright's `_electron`, with
`docs/mockups`' demand example as a document (pandas and matplotlib from
its header, a text cell, then five code cells) in a scratch folder, so
the name pill's folder line is that folder. The page is laid out at
1500 × 940 and 1100 × 760 at 2× by device metrics emulation, since this
screen is 1470 points wide; they are page captures, so the traffic lights
are not in them. Taken after the merge with main (the 44 px bar).

- `docs/session-receipt-1500.png`, `-1100.png`: the receipt beside the
  run cell (cell 3: three new names, the figure, figs/ax.svg to the
  folder). At 1500 it is 300 px with previews and the column has not
  moved; at 1100 it is slim (186 px) and the column has slid all the
  way left for it.
- `docs/session-chips-1500.png`, `-1100.png`: the chips at rest after
  Run stale; at 1100 the pill's least recently bound names give way to
  "+3" and the last run's stay.
- `docs/session-floating-1500.png`, `-1100.png`: the Session card from
  the pill, over the room, the column centred; its band shows the last
  run's DataFrame whole and its list.
- `docs/session-pinned-1500.png`, `-1100.png`: docked. At 1500 the card
  is 380 px and the column has slid left with its width; at 1100 the card
  is 320 px (the modes as one line, Pinned as its pin) and the column has
  narrowed to 656 px beside it, the chips between.

## Checks

On `ux/session` after the merge with main:

- `npm test`: green.
- `npm run build:engine`, `npm run check:web`: green; the committed app
  matches its sources.
- `npm run test:browser`: 92 passed. `tests/browser/session.spec.ts`
  (24) adds to the first pass's: the slide rule at 1470, 1300 and 1100
  (the card's width, beside the column past the lane, the column whole
  or narrowed to its floor, slid all or part of the way, back on
  unpinning) and the room scrolling sideways under the floor at 1000;
  the slide's 0.36 s; a run not moving the column; the receipt beside
  the column at 1470, 1300 and 1100 with the column sliding for it and
  coming back after the flight; the slim card's short values and its
  one-line hint; click to keep; the pill's order; the docked band on a
  chip's hover and click, and from the Data tab; its mini tables and
  figure; the resting pill in source view. The frame spec's column and
  floor tests say what docking does now.
- The checkout-shell smoke, `node ~/Projects/claerbout/smoke.mjs --config
  app/knuth.json browser` and `uv`: ok, with the autosave record's
  subjects (`knuth: cell run [1]`, `knuth: session open`).
- The engine's tests from the worktree:
  `PYTHONPATH=python ~/Projects/knuth/.venv/bin/python -m pytest
  python/tests -q`: 161 passed (the engine is unchanged in this pass).

## What is open

1. **The receipt under about 1075 px.** With the column slid all the way
   left there is less than 160 px beside it, and the card (160 px) lies
   at the room's right edge over the column's last part, for its stay.
   The way out is narrowing the column for the card, which rewraps the
   code twice in six seconds; left for Taylor's call.
2. **The column's see-saw on a narrow window.** Under about 1305 px a
   run's card slides the column left and the next keystroke slides it
   back (at 1100, 88 px each way); running cells one after another moves
   it every run. That is the rule as decided (the receipt's stay only);
   keeping the slide while cards follow one another is the alternative.
3. **Docked under about 1085 px** the room scrolls sideways to reach the
   card (the floor rises with it), where the first pass let the card lie
   over the column.
4. **Chips do not survive the document reloading from disk** (an outside
   edit, `knuth run`): every Cell is new, so the receipts are dropped;
   the names stay in the pill, unowned, until their cells run.
5. **The autosave subject counts every cell** (`knuth: cell run [4]` is
   the fourth cell, text cells included), where the receipt now counts
   code cells; the shell's record was left as it is.
6. **Round two's other parts are not built**: the ledger's margin cards,
   the clamp on dense notebooks, the lean of a wide table, the large
   viewer, the first-run note, a pill name that goes to its cell, Esc-P
   for the Session.
7. **A function's preview** carries its address, so a re-run that
   redefines it always reads as rebound — true, if noisy.
8. **The band's mini tables are asked of the kernel** once per receipt
   for each small table: one more message per small table per run.
