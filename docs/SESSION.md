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
(*Second pass*, below, has the rule), and for a run of receipts once
(*Third pass*).

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

**The receipt card.** After a run, the card appears beside the cell:
right of the column, over the chips' lane (its own chip hidden while it
is up), its top on the cell's first line, in the frame's dark glass, its
width following the room's margin up to 300 px. What happens next is the
mode's (*Sixth pass*, 2026-10-06):

- **Peek** (the default): as soon as it has eased in (0.24 s) it flies
  home into the session pill, whatever the pointer or the keys do. The
  column never moves for it: a margin under 160 px lays the card over the
  column's right edge for its moment. Going home is the flight: the card
  lifts and swings along a curve into the pill, shrinking; the pill's
  names update as it lands, the new ones blue and lit for a moment, and
  the chip takes its place at the cell. A chip's click opens its receipt
  over the page as it stands, past the chip where the margin holds it,
  else over the lane or the column's edge — never moving the column.
- **Float**: the card stays, kept (its pin lit), until Esc, its ✕ or a
  click outside it and the column puts it away, or the next run's card
  takes its place; typing and clicks back into the text leave it. A
  margin under 192 px slides the column left for the card's stay, until
  the card has 200. The column stays out while cards keep coming, and a
  card put away takes it home at once; after a run that makes no card it
  goes 1.2 s later (typing on starts that over), and it waits for a run
  still going. A chip's click slides it the same way.

A click on a chip's hover card keeps it. A run that bound more than nine
names lists eight and "+393 more · in the Session card", which opens the
Session tab. A Run all or Run stale never puts up a card.

**The chip.** Once a receipt has flown, a small chip stays at the cell's
right corner, in the lane beside the column (ledger-v2's folded tab,
tied to the column by a hairline): a glyph for what the run made — the
white print for a figure, a table, braces for names — and how many names
it bound (99, with a raised +, past that). Hover opens the receipt card
again, read-only, as it was, past the chip, where the margin holds it
without moving the column (a window of about 1305 px and more);
narrower, there is no hover card — the chip's title names what the run
bound — and a click opens it, kept, standing as a run's card does, the
column sliding for it. A click elsewhere or Esc puts it away. Docked,
the chip's receipt shows in the Session card's band instead. The chip changes
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

- **Peek** (the default): the receipt card, straight up into the pill.
- **Float**: the receipt card kept beside the cell, the column making
  room.
- **Silent**: no card, no motion; the chip appears and the pill's names
  change quietly.
- **Pinned**: the card docks beside the column, on the page, in its own
  look (not the code cells'), as a sidebar card that scrolls inside
  itself; the column slides left by only what the card lacks (narrowing
  under about 1275 px). A run's receipt goes straight into its band,
  lit for a moment; no card beside the cell; the chip still appears, and
  its hover or click shows its cell's receipt in the band ("Earlier run ·
  cell 2"). Choosing Peek, Float or Silent unpins it back to floating; closing
  it unpins it.

Peek, Float or Silent is remembered (localStorage `knuth-receipts`); Pinned is
remembered per window (sessionStorage `knuth-session-pinned`, with the
last choice in localStorage as a new window's start).

**With the scroll rail** (docs/ZEN-DRAFT.md, *The scroll rail*): the rail
is in the frame's gutter outside the room, and the docked card slides the
column inside it, so the two never meet; its rule reads the room's box,
which is 12 px narrower while the rail shows (at 1100 × 760 the column
644 px beside the 320 px card, 656 without the rail; the room scrolls
sideways under a window of about 1097 px rather than 1085). Docked, the
column is narrower still, and a figure drawn to its width is shorter
in it: a column that fits the room only with the gutter's 12 px taken
keeps the gutter (scroll-rail.ts asks again at the wider width before
the frame paints), where the gutter had come and gone every frame (a
window 1100 wide and 665 to 668 tall, a `figsize=(10, 4)` figure).

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
| the receipt card's stay | Peek: **0.24 s**, its ease-in, then the flight; Float: until put away or replaced (*Sixth pass*) | Taylor, 2026-10-06: the flight up "as the default behavior but with no pause", and floating receipts "that change the margin and don't go away" as the option; the first passes' 6 s dwell, the pointer holding it, and `p` to keep it are gone |
| the flight | **460 ms**, a quadratic curve that lifts first and swings across into the pill, shrinking to the names' box, above the bar; opaque until it is seven eighths of the way, the names lighting then (at 60 % of the time) while it still shows, gone only as it settles into them | peek-v2's 380 ms read as a blink on a real window; the curve is the "sends it up" Taylor liked; the first pass faded it before it reached the pill |
| what puts the card away | Peek: nothing, it goes at once; Float: Esc, its ✕, a click outside it and the column, the next run's card | Taylor: clicking back into the text should not move the margin |
| keeping a run's card | a click anywhere on it (but its pin, ✕, a table or the figure, which act on their own); `p` only when the keystroke would not type (focus off the text); the hint names what works now | after ⌘↩ the cursor stays in the cell, where a `p` must stay a `p`; Esc then P was weighed and left out, since Esc also closes the completion popup and the next `p` would be swallowed |
| when a run gets a card | a single, clean run that bound or drew something; a run whose news only the snapshot saw gets its card when the snapshot lands, unless you carried on meanwhile | a card saying "nothing" is motion for nothing |
| the chip's glyphs | white print = drew a figure; table = bound a DataFrame, Series or 2-D array; braces = names; the count = names bound (or figures drawn, for a figure alone), 99 with a raised + past that; 4 px in, 3 px apart, 38 px at the most | ledger-v2's tab, with braces for plain names; narrow enough that no chip reaches the docked card past the 46 px lane |
| the column after a receipt | Peek: never moves. Float: stays where the card slid it while cards keep coming: through a run (its card stands where the last one did) and through a Shift-Enter stepping to the next cell, up to 6 s if no run comes; at once when the card is put away on purpose (Esc with it up, its ✕, a click outside the card and the column), but for a run still going (*Fifth pass*); 1.2 s after typing, a click into the column or the dwell put the card away, or after a run that makes no card (silent, failed, a batch, nothing bound); each keystroke, and each click in the column, starts the 1.2 s over, so it goes at a pause and not under a word; never while a run is still going (up to 30 s after the last card went), and never from under a pointer resting on a chip | the verifiers' traces at 1100: 88 px each way on every Shift-Enter; then 88 px under the line being typed, mid-word, and home and straight out again for a 7 s cell; Taylor, on the 1.2 s after a dismissal: "the margin takes a second to return" |
| a chip's hover | a card past the chip, the column where it stands, when that leaves the card 160 px (a window of about 1305 px and more); else none, the title naming the run's names; a click opens it kept, past the chip where it fits, else over the lane as a run's card, the column sliding | hovering never moves the column; a click is a decision, as a run is |
| a run that bound many names | the receipt card lists eight and "+N more · in the Session card" (it opens the Session tab); the docked band the same, its line scrolling to the list below | a loop of globals made a 10,634 px card |
| a value in a narrow row | a float to six significant digits ("-0.408882"), whole in the tooltip and on a wide card; a numpy scalar is previewed by its value: numbers and dates by numpy's own str (a float64 as Python's float says it, `0.1` for a float32, `2024-01-01T00:00:00.000000000`, `NaT`), strings, bytes and objects by their Python value's repr | "elasticity float64" said nothing; `item()` widened a float32 and turned a nanosecond date into an int and NaT into None |
| what the receipt lists from the folder | the bound values values.json mirrors (`saved` from the kernel) and the run's `figs/<name>.svg` receipts; "no folder yet" when the document has no folder | both are what the page already writes; a scratch run lists none |
| new names in the pill | blue until the next single run, or until the Session tab is opened; a batch's add up | round two's rule: opening the Session acknowledges, hovering does not |
| the card beside the cell | a run's 6 px from the column (over the chips' lane), a chip's past its chip; as wide as the margin up to 300 px, 8 px in from the room's edge; slim under 270 px (a short value — a number, a string of 16 characters or fewer — in place of its kind, the kind in the tooltip); a margin under 192 slides the column left until the card has 200, and the card then takes down to 160 | about 280 px with previews at 1470–1500; 198 px at 1300 with the column where it stands (it slid 2 px per run for 200); 186 px slim at 1100 with the column all the way left |
| the docked card | clamp(320, what is beside the column, 380) wide past the chips' lane, 10 px in from the room's right edge, the room's height less 24 px; inside the room | peek-v2's board |
| the column, docked | margin-left max(0, min(centred, room − column − need)), need = the card, the lane and its gap less the room's own 24 px margin; narrows under about 1275 px to a 640 px floor; under about 1085 px the room's floor rises and it scrolls sideways | peek-v2's rule, and Taylor's "right beside the cells … just on the page" |
| the slide | 0.36 s, cubic-bezier(.2,.7,.2,1), on the pin and for a receipt's stay (the card riding beside the column on the same curve); never on a resize, never on a run | peek-v2's timing |
| cell numbers | on the receipt, the band and the Session tab, the code cells only, 1-based (cell zero, the preamble, is 0), text cells uncounted; the autosave record's `cell run [n]` keeps main's count, the cell's place among the document's `# %%` blocks | no number is drawn on the page, so a student counts the cells that run; the record is read beside the shell's history view, which numbers every `# %%` block and lights the cell a run's commit changed by that number |
| the floating card | 380 px, 10 px in from the room's top right | the tabs, the three modes and ✕ on one line |
| a narrow room | under about a 1075 px window the receipt card, 160 px, lies at the room's right edge over the column's (after sliding it all the way left); the docked card never does: the room scrolls sideways, and the pin scrolls it to the card's controls | see *What is open*, 1 |
| the pin's fade | the docked card fades in once the chips riding beside the sliding column have passed its left (the column's own edge where there are none), worked out on the slide's own curve: about 65–80 ms at 1470–1500 and 120 ms at 1100 with no chips, 180–190 ms and 225 ms with them | it showed over the column for the slide's first 150 ms, and then over the chips for 100 ms |
| runs queued behind a busy kernel | each receipt is what its run reported (`bound`): the snapshot after a run that had others queued with it, before or behind, is the session after them too, so it adds nothing to that receipt (no change in place found, no late card, no owner); a receipt's time counts from when the run before it ended | the snapshot credited each cell with the next cells' names ("6" and a figure on a DataFrame cell), and the queued cell's time with the wait |
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

## Third pass: the verifier's findings

The second pass's adversarial verifier drove the checkout shell (uv and
Pyodide, at 1470, 1300, 1100 and 1000) and returned ok: false with ten
problems, ranked, beside the implementer's five open items. Pinned and
the receipt beside the column held up; what Taylor would notice at the
app's default 1100 window was motion. In the verifier's order:

1. **The column slides once while cards keep coming.** Traced at 1100,
   sheet.left went 148 → 60 for a run's card, back to 148 at 900–1190 ms
   when the next run tucked the card (the return was due at FLY_MS × 0.3),
   and → 60 again for the next card: 88 px each way on every Shift-Enter.
   Now a card that goes leaves the column where it is (`cardGone`):
   through the run about to start, whose card stands where the last one
   did; through a Shift-Enter that steps over a text cell, up to six
   seconds if no run follows; otherwise 1.2 s after typing, Esc, a click,
   the dwell, or a run that makes no card. It never goes home from under
   a pointer resting on a chip. The traces below move once out and once
   back.
2. **A chip's hover never moves the column.** Its card stands past the
   chip with the column where it is, and only where that leaves it
   160 px (a window of about 1305 px and more). Narrower there is none:
   the chip's title names what the run bound and says "click for the
   receipt", and a click opens it kept — past the chip where it fits,
   else over the lane as a run's card stands, the column sliding for it
   as for a run.
3. **Keeping a card moves nothing.** A card is placed once, over the lane
   or past the chip, and keeps that place; a run's card kept by a click
   stays where it was, as wide, still "this run", its chip still hidden.
   Before, it jumped 40 px to stand past the chip and turned slim.
4. **Numpy scalars show their value.** The kernel previews a
   zero-dimensional numpy value by its value (`python/knuth/session.py`,
   `_is_numpy_scalar`), so the elasticity reads `-0.4088817904210866`,
   not `np.float64(-0.4088817904210866)`; a Python test beside the
   `bound` test. (The third pass used `repr(value.item())`; the fourth
   takes numbers and dates by numpy's own str, below.) A narrow row
   shows a float to six significant digits
   (`briefValue`, receipts.ts), whole in its tooltip and on a wide card,
   and the slim card's cells are a little tighter, so "elasticity
   -0.408882" sits whole on the 186 px card.
5. **A receipt that bound hundreds of names** lists eight and "+393 more
   · in the Session card", which flies the card home and opens the
   Session tab. The docked band does the same, its line scrolling to the
   list below. A loop of 400 globals made a 10,634 px card.
6. **Chip counts.** The suggested "99+" does not narrow a chip in the
   mono face ("99+" is as wide as "401"), and a two-digit chip already
   reached 4 px into the docked card past the 46 px lane (43.7 px, from
   a 6 px tie). The chips are tighter, 4 px in and 3 px apart (31 px
   with one digit, 38 with two), and a count over 99 reads 99 with a
   raised +. The lane and every docked number are unchanged.
7. **The pin's fade** waits until the sliding column's right edge has
   passed the docked card's left, worked out on the slide's own curve
   (about 80 ms at 1500, 120 ms at 1100). No frame shows the card over
   the column; before, it lay over the column's edge for 150 ms.
8. **The return began before the flight had cleared the column.** Moot:
   the return now comes 1.2 s after the card has gone.
9. **Under the docked floor** (about 1085 px) the pin scrolls the room to
   its right end, the card's modes and ✕ in view. The receipt card's
   overlap under about 1075 px stays open, for Taylor (*What is open*, 1).
10. **The screenshots**, all eight again, from the document opened
    through a temporary link at `~/Projects/week-3` (removed
    afterwards), so the folder line reads like Taylor's own.

Two small untruths the second pass left:

- Its code commit (19a5175) says the column narrows while docked under
  about 1290 px. The code narrows under about 1275, as this record and
  ROADMAP say, and now the slide-rule test's comment too. The commit is
  history and stays as it is.
- The CSS comment on #doc's floor said the docked floor rises under about
  1080 px; measured, it is 1085. Fixed.

Main merged again (ad1bbb1, and 56837e7 after it, a note in history.md):
`src/place.ts`, the rewind's save and reload, the error run in the
record, File → History…. The only conflicts were the committed web,
rebuilt from both. A rewind's reload goes through setDoc, so the
receipts drop as for an outside edit (*What is open*, 4).

### The traces

The checkout shell on Pyodide, the verifier's document (a heading, code
cell 1, a text cell, code cells 2 to 5), sheet.left read every frame:

- **1100, three runs** (click into cells 2, 3 and 4 and ⌘↩, 1.5 s apart,
  then a click on the room): 148 → 60 over the first 365 ms, 60 until
  5836 ms, home at 148 from 6131 ms, 1.2 s after the click. One slide
  out and one back.
- **1100, Shift-Enter five times from cell 1** (runs 1, steps over the
  text cell, runs 2, 3, 4): 60 from 382 to 8820 ms, home at 148 from
  9115 ms. The card was down from 2033 to 3099 ms while stepping over
  the text cell, and the column stayed.
- **1470, both**: 333 throughout; nothing slides.
- **A chip's hover**, a pass down the lane resting 450 ms on each of four
  chips. At 1100: 148 throughout, no card, "n, rate — click for the
  receipt". At 1470: 333 throughout, each card at 1211, 243 wide, past
  its chip (1171 to 1202).
- **A pointer on a chip when the return was due** (1100): the column held
  at 60 until the pointer left at 3306 ms, and was home by 3625.
- **Keeping**: at 1470 the card stood at 1171, top 400, 283 wide, before
  and after the click, not slim, "Cell 3 · this run", its chip hidden,
  sheet.left 333 in every frame. At 1100: 898, 400, 186 and slim before
  and after, sheet.left 60.
- **The pin at 1100**: the column's right edge 980 → 716 over the slide;
  the card, at 762, at opacity 0 until 185 ms (the edge at 764), first
  showing at 235 ms (the edge at 739). At 1000 the room scrolled its
  84 px to the end, ✕ at 975 inside the room's 992, the card first
  showing at 174 ms with the edge (675) past it (677).

## Fourth pass: the verifier's findings

The third pass's verifier drove the checkout shell again (uv and
Pyodide, at 1000, 1100, 1300 and 1470) and found the second pass's ten
closed — stepping through cells slides the column once, a chip's hover
never moves it, a kept card stays put, and the new tests fail on the old
code and hold over four repeats — and ten problems more, two of them
real. In its order:

1. **Runs queued behind a busy kernel credited each cell with the next
   cells' names.** Shift-Enter three times down a fresh pandas document:
   cell 1's chip showed a figure and "6", and the Session tab said
   elasticity came from cell 1, so "go there" went to the wrong cell. A
   run is sent to the kernel when it is asked for, and the snapshot its
   receipt asks for once it ends queues behind the runs after it, which
   it then credited to this one. The session now counts the runs in
   flight: a run that started while another was going, or ended with
   others still queued behind it, keeps what it reported (`bound`), and
   the snapshot adds nothing to its receipt (`settle`'s `alone`; no
   change in place found, no late card, no owner). The verifier's fix
   counted only the runs behind; the runs before count too, since the
   session as the page knows it before such a run lacks what they changed
   unseen, and the last of a queue took an earlier cell's change in
   place. A receipt's time now counts from when the run before it ended
   (`DocumentView.lastRunEnd`): a queued cell's read 5.45 s, its wait.
2. **The column went home under the line being typed** (the third pass's
   open item 2, measured): at 1100 it slid 88 px right 1.2 s into typing
   in the next cell, mid-word. Each keystroke, and each click in the
   column, now starts the 1.2 s over, so it goes home at a pause. The
   verifier's other way, waiting until no editor has the focus, was not
   taken: it would hold the column out for as long as one writes.
3. **A slow cell sent the column home and straight back out** (the same
   item's other half): a 7 s cell run 1.5 s after another's card let the
   6 s timer send it home at 7.6 s, and its card slid it out at 8.6 s.
   The return now waits while a run is still going (`goHome` looks again
   every 400 ms), up to 30 s after the last card went; the run's card
   then stands where the last one did, or a run with none sends the
   column home 1.2 s after it.
4. **The pin's fade began over the chips.** It waited for the column's
   edge, not the chips riding beside it (24 px over at opacity 0.22, at
   1100). It now waits for the widest chip's right edge, worked out on
   the same curve: 225 ms at 1100 and 188 at 1470 with chips, as before
   without. The verifier's formula used the lane's full 46 px, whose
   edge meets the card only as the slide ends (a 360 ms wait).
5. **1300 twitched 2 px a run**: the margin gave the card 198 px, under
   200, and the column slid 2 px for it and back. A margin up to 8 px
   short of 200 now takes the card where the column stands.
6. **The autosave record's numbering went the wrong way.** The third pass
   (fed3d0d) made `cell run [n]` count the code cells only, saying it
   fixed a mismatch with the history view. The shell's history view
   (claerbout's `history/history.html`, `cellsIn` and `cellAt`) numbers
   every `# %%` block, markdown included, and lights the cell a run's
   commit changed by that number, so the same row read `cell run [2]
   (error)` beside "cell 3". `DocumentView.onRunDone` reports the cell's
   place in the document again, as main does; `src/shell.ts` and
   AUTOSAVE.md are main's again, and main's raising-run test keeps the
   text cell the third pass put in and expects `cell run [3] (error)`.
   The receipt still counts code cells. Counting them everywhere would
   need `cellsIn` to skip `# %% [markdown]` blocks too: a change in the
   shell, for Taylor.
7. **A column could stay slid with no card up.** A run's card, a second
   run's card while the column lingered for the first, then ⌘⇧E twice by
   keyboard: the source view's observer put the card away without
   `cardGone`, and the first card's stale lean held the column at 60 for
   good. The observer now clears the lean and its timer (those views
   ignore it, and the column comes back centred), and a card coming up
   clears any lean it inherits.
8. **A numpy scalar's preview was wrong past plain numbers.** `item()`
   turns a nanosecond datetime64 (pandas < 3's default) into an int, NaT
   into None, and widens a float32 to 0.10000000149011612. Numbers and
   dates now preview by numpy's own str (a float64 as before, `0.1`,
   `2024-01-01T00:00:00.000000000`, `NaT`), strings, bytes and objects
   by their Python value's repr. The verifier's test of `kind in 'USb'`
   also passes an empty kind, and would have taken objects (and
   longdouble's `np.longdouble('1.5')`, by `item()`) the other way; this
   names the numeric and date kinds. `_persistable` still writes a
   nanosecond date to values.json as an int: main's code (*What is
   open*, 10).
9. **"+N more", the pin and ✕ took the focus**, so the caret left the
   cell, where the pill, which opens the same card, keeps it. The
   receipt now prevents the focus for every mousedown on it; its buttons
   still get their click, and Tab still reaches them.
10. **The chip's accessible name offered hover**, which a keyboard never
    makes. It reads "Receipt of cell 1's last run: prices, n — click for
    the receipt" at every width; Enter or Space opens it kept. Its title
    is as it was.

Every fix was taken; 2 took the verifier's first way, and 1, 4 and 8 go
a little past its code, as said.

### The traces, fourth pass

The checkout shell on uv, `docs/mockups`' demand example (pandas and
matplotlib from its header, a text cell, five code cells, the last a 7 s
sleep), a fresh session, sheet.left read every frame:

- **Shift-Enter three times, 300 ms apart, from the pandas cell** (1100):
  chips "prices, n", "elasticity, demand" and "fig, ax", the Session tab
  owning each name by its own cell; the receipts' times 8.21 s (the
  environment and pandas), 69 ms and 2.49 s (matplotlib).
- **⌘↩, a click into the next cell, and typing at 150 ms a key** (1100):
  60 from the run through the last key (near 4170 ms), home from
  5395 ms.
- **The 7 s cell, run 1.5 s after another's card** (1100): 148 → 60 over
  0–327 ms for that card, then 60 through the run to its card at
  8561 ms ("7.01 s"). One slide.
- **1300**: 248 throughout a run and its card's stay; the card 198 px.
- **The pin, with chips**: at 1100 the card at opacity 0 until 246 ms,
  the chips' right edge (761) then past its left (768); at 1470 until
  213 ms (1070 against 1078). No frame shows it over a chip.
- **⌘⇧E twice with a second card up** (1100): 60 with the card, 148 in
  every sample after.
- **The pin and ✕ of a fresh receipt after ⌘↩**: the caret stays in the
  cell (the active element its cm-content after each).
- The console: nothing.

## Fifth pass: a dismissal goes home at once

Taylor, at the app's default window: "when i close a receipt after it
made space next to the cell, the margin takes a second to return to the
original alignment. id love it to just go back right away." The fourth
pass held the column out 1.2 s after every way a card goes, so that
stepping through cells slides it once; a card put away on purpose waited
the same 1.2 s, which reads as lag.

**The rule.** An explicit dismissal brings the column home at once: the
0.36 s slide starts on the dismissal, with no 1.2 s wait and no 6 s
hold. The explicit ways are Esc with a card up (a run's, a kept one, a
chip's), the card's ✕, and a click outside both the card and the column
(the room's margin, the bar, the pill, the rail). A run's card flies
home as ever; the column slides home under the flight as it lifts (the
card flies above it), where the second pass waited for the card to clear
and the third made that moot with the 1.2 s. The one exception is a run
still going when the card is put away — its card is on the way and will
stand where this one did — so the column keeps the hold for it
(`goHome` waits for the run, up to HOLD_MS, as before). The card's pin
only keeps; there is no "keep" to turn off, so it is not a way out.

The implicit ways keep the fourth pass's rules exactly: the flight at
the end of the dwell (1.2 s after it), the next run tucking the card
(`runStarting`; the column waits for its card), typing in a cell (1.2 s
after the last key), a view switch (the lean dropped, as the fourth
pass's 7 has it). A click **into the column** — into the next cell, its
▶ — counts as carrying on, as typing does, not as a dismissal: the third
pass's trace clicks into cells 2, 3 and 4 and runs each with ⌘↩, and
the column has to stay out through that, not swing home at each click
and out again at each run. Opening the Session card from "+N more", a
table or a figure on the card is going somewhere, and keeps the linger.

In the code: `dismiss()` puts the card away (a fresh one by `tuck`, else
`hideCard`) with `now`, which `cardGone` passes on to `goHome` at once
rather than setting the timer; Esc and ✕ call it, and the document's
mousedown passes `now` when the click is outside `#sheet`.

### The traces, fifth pass

`session.spec.ts` against the mock engine (Chromium, 60 frames a
second), 1100 × 760, sheet.left every frame as [ms from the dismissal,
left] wherever it changed:

- **Esc on a run's card**: [-19,60] [31,75] [47,90] [64,103] [81,114]
  … [247,146] [281,147] [314,148]. Moving on the second frame after the
  key, home at 314 ms.
- **The card's ✕**, fresh: [27,75] … [310,148]; kept: [29,75] …
  [312,148].
- **A click on the room's margin**: [17,74] … [301,148].
- **A click into the next cell** (carrying on): 60 until [1231,75],
  home at 1514 ms — the 1.2 s, as before.
- **The dwell** (from the card's flight beginning): 60 until [1219,75],
  home at 1502 ms — the 1.2 s, as before.
- **Shift-Enter three times** from cell 1, 400 ms after each card, then
  Esc: 148 → 60 over 117–401 ms, 60 through the three cards, and home
  over 1517–1800 ms, from the Esc. One slide out, one back.
- **Esc on a kept card while a slow cell is running**: 60 in every frame
  through to that cell's card.

## The record

The screenshots are the checkout shell (`app/knuth.json` on
`~/Projects/claerbout`) on uv, through Playwright's `_electron`, with
`docs/mockups`' demand example as a document (pandas and matplotlib from
its header, a text cell, then five code cells), a scratch copy opened
through a temporary link at `~/Projects/week-3` (removed afterwards), so
the name pill's folder line reads `~/Projects/week-3`. The page is laid
out at 1500 × 940 and 1100 × 760 at 2× by device metrics emulation,
since this screen is 1470 points wide; they are page captures, so the
traffic lights are not in them. Taken after the third pass and its merge
with main; the fourth pass changes nothing they show.

- `docs/session-receipt-1500.png`, `-1100.png`: the receipt beside the
  run cell (cell 3: three new names, the figure, figs/ax.svg to the
  folder). At 1500 it is 300 px with previews and the column has not
  moved; at 1100 it is slim (186 px) and the column has slid all the
  way left for it.
- `docs/session-chips-1500.png`, `-1100.png`: the chips at rest after
  Run stale, as tight as the third pass made them; the pill holds every
  name at both sizes now that the folder line is short.
- `docs/session-floating-1500.png`, `-1100.png`: the Session card from
  the pill, over the room, the column centred; its band shows the last
  run's DataFrame whole and its list.
- `docs/session-pinned-1500.png`, `-1100.png`: docked. At 1500 the card
  is 380 px and the column has slid left with its width; at 1100 the card
  is 320 px (the modes as one line, Pinned as its pin) and the column has
  narrowed to 656 px beside it, the chips between.

## Checks

On `ux/receipt-return` after the fifth pass: `npm test` green; `npm run
build:engine`, `npm run check:web` green (the committed app rebuilt);
`CI=1 npx playwright test tests/browser/session.spec.ts
tests/browser/frame.spec.ts`, 59 passed on 5198 (`session.spec.ts` 41,
six new: Esc, ✕ fresh and kept, a click outside against a click into a
cell, Esc on a kept card while a run is going, the dwell's 1.2 s, and
Shift-Enter stepping once; the stepping test's Esc now comes home in
under 900 ms, where it asserted over). The four dismissal cases fail on
the fourth pass's code; the dwell, Shift-Enter and in-flight cases pass
on both, guarding what stays. The checkout-shell smoke, `browser`: ok.

On `ux/session` after the fourth pass:

- `npm test`: green (receipts.test.ts adds a queued run's `settle`,
  which keeps the run's own report).
- `npm run build:engine`, `npm run check:web`: green; the committed app
  matches its sources.
- `CI=1 npx playwright test`: 109 passed, on its own port 5198 (free, so
  the embed test, which hardcodes 5198, ran too). `session.spec.ts` has
  35; its mock engine now answers one request at a time, in order, as
  the engine does (a cell with `sleep(s)` takes s seconds). New: runs
  queued behind a slow cell, each chip and the Session tab naming its
  own cell's names and each receipt its own time; a change in place
  while runs are queued credited to no cell; two seconds of typing after
  a run at 1100 with the column still, then home after the pause; a run
  still going holding the column for its card; the pin's fade never over
  a chip, frame by frame; ⌘⇧E twice with a second card up. Changed: 1300
  takes the 198 px card unslid; the hundred-name receipt runs from the
  cell and keeps the caret through "+112 more"; a kept card's ✕ keeps it
  too; the chip's aria-label at 1100 and 1470. `history.spec.ts`'s
  raising run, past a text cell, is `cell run [3] (error)`. The new and
  changed cases fail on the third pass's code (the in-flight hold's only
  once the typing fix is in; the queued in-place case on the verifier's
  fix alone).
- The engine's tests: `cd python &&
  ~/Projects/knuth/.venv/bin/python -m pytest tests -q`, 162 passed;
  the numpy test adds a float32, a nanosecond datetime64, NaT and a
  string (a worktree has no `python/.venv`; run from its own `python/`,
  the worktree's knuth is the one imported).
- The checkout-shell smoke, `node ~/Projects/claerbout/smoke.mjs --config
  app/knuth.json browser` and `uv`, autosave on, in the smoke's
  throwaway folders: both ok, the record `knuth: cell run [1] | knuth:
  session open`.

## What is open

1. **The receipt under about 1075 px.** With the column slid all the way
   left there is less than 160 px beside it, and the card (160 px) lies
   at the room's right edge over the column's last part, for its stay.
   The way out is narrowing the column for the card, which rewraps the
   code twice in six seconds; left for Taylor's call.
2. **The column's one return.** On a narrow window the column still goes
   home once the cards stop: typing on after a run, it goes 1.2 s after
   the last keystroke, at the pause but beside the text (at 1100, 88 px).
   A run that takes longer than 30 s lets it go home, and its card slides
   it out again.
3. **Docked under about 1085 px** the room scrolls sideways to reach the
   card (the floor rises with it), where the first pass let the card lie
   over the column. The pin scrolls it there; a reload while docked opens
   at the column's left.
4. **Chips do not survive the document reloading from disk** (an outside
   edit, `knuth run`, a rewind in the shell's history view): every Cell
   is new, so the receipts are dropped; the names stay in the pill,
   unowned, until their cells run.
5. **No hover card under about 1305 px**: there the chip's receipt takes
   a click. The verifier's other idea, lighting the chip's names in the
   pill on hover, is not built.
6. **Round two's other parts are not built**: the ledger's margin cards,
   the clamp on dense notebooks, the lean of a wide table, the large
   viewer, the first-run note, a pill name that goes to its cell, Esc-P
   for the Session.
7. **A function's preview** carries its address, so a re-run that
   redefines it always reads as rebound — true, if noisy.
8. **The band's mini tables are asked of the kernel** once per receipt
   for each small table: one more message per small table per run.
9. **Runs queued together get no snapshot of their own.** Their names,
   owners and times are right, but what only a snapshot sees is lost for
   them: a frame one of them changed in place shows on no receipt, a
   name one bound inside an `if` is missing from its receipt (it joins
   the pill unowned), and a queued run that failed shows an empty
   receipt. A snapshot per run would need the kernel to send one with
   each `done`.
10. **values.json writes a nanosecond datetime64 as an int**
    (`_persistable` unwraps numpy scalars by `item()`; main's code): the
    receipt previews it right now, the folder's copy is not.

## Sixth pass: Peek goes up at once, Float keeps the card (2026-10-06)

Taylor, on the column taking a moment to come back after a click into a
cell: the receipt going up into the pill and the page settling after it
should be the default, "but with no pause", and a chip's click should
"just pop up over what's there". The old behaviour, the column making
room, stays as an option whose cards "don't go away".

- **Peek** shows the card for its 0.24 s ease-in and flies it; the
  column never moves for a receipt, and a chip's click opens a kept card
  over the page (past the chip, over the lane, or over the column's right
  edge on a narrow window). Over a card that is leaving, the pointer
  holds nothing; once it lands, a chip come up under the pointer opens
  its hover card, as any chip does.
- **Float** keeps every run's card (kept from the start: pin lit, ✕),
  the column sliding for it as before. Typing and clicks back into the
  column leave it; Esc, ✕ or a click outside both put it away and take
  the column home at once; the next run's card takes its place with the
  column still out.
- Gone with the dwell: the 6 s timer, the pointer holding a fresh card,
  `p` to keep it, and the card's hint line.
