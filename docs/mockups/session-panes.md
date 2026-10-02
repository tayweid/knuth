# Session panes: the design session of 2026-10-02

Taylor's words that opened it: "for the floating session panes, i'm not sure
what to do here. could you devote a claude design session to this? i don't
know how to make that feel natural. the layout horizontal doesn't feel right
right now. so something needs to improve. the cell vertical column is
basically perfect."

Five mockups were drawn, each in Taylor's rail-layout.html frame (Zen's
shape) with the live app's dark bench inside the room, and three judges
scored them through three lenses: does it feel natural, does it work in a
classroom, can it be built on today's code. This is the record. The five
mockups are beside this file; the recommended one, with the grafts applied,
is `session-panes-recommended.html`.

## Recommendation

Build the inline ledger. The session stops being a second column beside the
document and becomes marginalia beside the cells: a small card in the right
margin for each cell that bound something, its top on the cell's first line,
tied to the cell by a hairline, scrolling with it. Cause and effect sit on
one line, so a run never asks the eye to travel to a far column, and the
cell column never moves and never narrows at any window width. That is the
direct answer to "the layout horizontal doesn't feel right": the thing that
felt wrong was a region competing with the column for width, and a card
tied to a cell is not a region. It also gives provenance for free (a name
rebound by a later cell is struck in the earlier card; a stale cell's card
carries the amber), which none of the other four could. The judges did not
agree on a first place, but this is the only mockup every judge put in the
top three, it has the highest total, and head to head it beats each of the
others with two judges of three (all three against the shelf). The roadmap's
own idea, the floating boxes, was drawn well and that is what settled it:
pulling a box out slides the sheet, a nudge reflows the tabs below it, and
on a wide window the three boxes are exactly the stacked right-hand column
Taylor said does not feel right.

The ledger's two real weaknesses were both fixed with parts the runners-up
already drew, and the recommended mockup has them applied. From
peek-overlay: a 5px dot in the run chip after a run (blue on the last run,
grey on earlier ones), and on a narrow window, where the margin cannot hold a
card, that dot is the ledger's whole affordance: hover shows the cell's card
as a popover in the frame's material, click pins it, and a run peeks it for
a breath. That replaces the fore-edge ticks, which the classroom judge found
invisible from the back of a room. Also from peek-overlay, the receipt marks
(+ first bound here, ~ rebound, the time the run took) and its pin rule for
the viewer: a table is something you look at while you work, so the viewer
is a card hung at the room's right edge that stays while you click and type,
with ⤢ making it large over the dimmed frame for a projector. From
floating-edge: a Session tab tucked at the room's right edge when the cards
are folded, with the count, that opens the whole namespace sorted (the one
thing today's panel does that the ledger alone did not). From bottom-shelf:
three plain-word tabs on the viewer, Session, Data, Figures, with a chip to
pick the table. From zen-rail: a card you have not looked at since its run
keeps a blue rule until the pointer finds it, instead of fading on a timer;
figures captioned by name and cell with a link back to the cell.

## The five mockups

| Mockup | File | In one line |
| --- | --- | --- |
| Inline ledger | `session-panes-inline-ledger.html` | A narrow ledger in the cell column's right margin: one small card per cell that bound something, aligned with the cell and scrolling with it; folds to a fore-edge of ticks on a narrow window; a click opens the card large over the frame. |
| Floating edge | `session-panes-floating-edge.html` | The roadmap's idea done well: three rounded boxes tucked off the room's right edge as 44px tabs, easing 210px in when they change and settling back, pulled fully out by a click (the sheet eases left), open in the margin on a wide window. |
| Zen rail | `session-panes-zen-rail.html` | Zen's shape taken literally: the session lives in the left rail as three tiles that light with a badge and whisper what arrived; a tile opens one floating card over the frame beside the rail; the column never moves. |
| Bottom shelf | `session-panes-bottom-shelf.html` | A console-drawer shelf under the document: a 36px strip of tabs and live chips at rest, rising to show the part that changed after a run (pushing the document up), docked open by a click, three parts side by side on a wide room. |
| Peek overlay | `session-panes-peek-overlay.html` | Nothing docked anywhere: a 5px dot in the run chip summons a glass receipt beside the cell saying what that run did, dismissed by typing; pinned, the card lifts to the room's top-right and becomes the whole session. |
| Recommended | `session-panes-recommended.html` | The inline ledger with the grafts above applied (the gutter dot, the popover, the receipt marks, the Session tab, the tabbed beside/large viewer, acknowledgement instead of timers). |

Every mockup is self-contained: double-click to open, the pill at the bottom
switches the states, ▶ on any cell runs it, and the window can be resized.

## The judges

Scores out of 10, rank in brackets.

| | Natural | Teaching | Buildable | Total |
| --- | --- | --- | --- | --- |
| Inline ledger | 7 (2nd) | 7.5 (1st) | 7 (3rd) | 21.5 |
| Floating edge | 5.5 (4th) | 7 (2nd) | 8 (1st) | 20.5 |
| Zen rail | 7.5 (1st) | 5.5 (4th) | 6 (5th) | 19 |
| Peek overlay | 6.5 (3rd) | 5 (5th) | 7.5 (2nd) | 19 |
| Bottom shelf | 4.5 (5th) | 6 (3rd) | 6.5 (4th) | 17 |

Three judges, three different winners. The disagreements, and how they were
read:

Zen rail won the natural lens (the calmest resting state, the only one that
is Zen rather than Zen-adjacent) and lost the other two: at 1440 its card
opens over the left edge of the column, exactly where the run chips are, and
its signal (a badge and a three-second whisper at the far-left rail) is far
from the cell the eye is on. The buildable judge also found that it needs
the rail to exist first, which the other four only draw, and that three more
tiles overflow the rail's height on a laptop. Its best ideas (acknowledgement
over timers, the frame material for a floating card, figure captions) travel
well, and they were grafted.

Floating edge won the buildable lens (the most complete numbers, a mockup
whose script really implements the nudge and settle, and nothing changes in
document-view.ts) and came fourth on natural, for the reasons above: the
sheet moves, the tabs reflow, the wide state is the column again. Its
tucked tab and its wide-window behaviour were grafted.

The inline ledger was first, second and third. The two judges who did not
put it first each named the same cost: the data viewer became a modal over
the whole frame, so you could not look at a table and type (natural and
buildable), while the classroom judge called that same 880px overlay the
best projector view of the five. Both are right; the recommended mockup
resolves it with the beside/large toggle. The other named cost, that the
fore-edge is invisible on a 1280 projector, is resolved by the gutter dot.

Peek overlay split the room: second on buildable (honours the constraint
most strictly, accurate line citations), third on natural, last on teaching,
because nothing is visible by default and ⌘J collides with Chrome in the
PWA. Its dot and its receipt were the most-grafted pieces of the session.

Bottom shelf was last or near it for all three for one reason stated three
ways: it takes height from a vertical column and the document moves on every
run. Its plain-word tabs were grafted onto the viewer.

## Open questions

Answer these before it is built. A suggested default follows each.

1. Attribution: which cell bound a name? Default: a client-side diff of
   kernel.namespace() against the last snapshot, by name, type, shape and
   preview, attributed to the cell whose run just finished. This misses an
   in-place mutation that changes none of those (rare: a value set deep in
   a frame). Add a kernel-side `bound: [names]` field, from id() comparison
   before and after the run, only if that bites.

2. The narrow window: the gutter dot with a hover popover, as recommended,
   or the original fore-edge ticks at the room's right edge? Default: the
   dot. The ticks are a second apparatus 150px from the cell; the dot is in
   the chip the cell already has.

3. Where the cards' floor sits. Cards need about 150px of margin beyond the
   832px sheet, which is a full-width 1440 laptop; anything narrower (a
   split screen, a 1280 projector) gets dots. Default: keep 150px, and let
   the Session control force either mode.

4. The viewer's default size: beside the column (non-modal, stays while you
   type, leans over the column's edge on a laptop) or large (centred, frame
   dimmed, the projector view)? Default: beside, and remember the last
   choice under knuth-panel, since in class he will pick large once.

5. What acknowledges a card? Default: the pointer entering the card (not the
   cell; after a click on ▶ the pointer is already on the cell), a click on
   the dot, or opening the Session tab. No timer.

6. Thumbnails in the cards. The margin thumbnail duplicates the inline
   figure right beside it. Default: keep it, small; it is the one thing in
   the margin that says "this cell drew" from across a room, and it is the
   click target for the large print. Drop it if the margin feels busy.

7. The run that is off screen (Run all, Run stale): the card eases in where
   no one is looking. Default: nudge the Session tab's count instead, as
   the mockup does in the narrow mode, and in the wide mode rely on the
   unseen rule staying until looked at.

8. A deleted cell whose names are still in the session. A card cannot hang
   off a cell that is gone. Default: the names stay in the Session tab with
   the provenance "deleted cell"; no card.

9. The keystroke for the Session tab. ⌘J collides with Chrome's downloads in
   the PWA. Default: the topbar's Session control and the dot are the two
   paths; add Esc-then-P to the Y/S/M chord family (document-view.ts:296)
   only if a key proves wanted.

10. Whether the timing of the peek in narrow mode (2.5s hold, 0.9s re-arm
    after the pointer leaves) feels right. Default: ship the mockup's
    numbers and tune by feel; they are two constants.

11. The roadmap entry. docs/ROADMAP.md lines 36–48 still describe the
    floating boxes. Default: rewrite it to the ledger once the direction is
    accepted.

## Implementation notes

Rough size: about one evening, 500 lines touched, nothing in the cell column
itself. The grafts add perhaps a hundred lines over the plain ledger.

index.html: wrap the sheet so the ledger has a positioned parent:
`<div id="doc"><div id="page"><div id="sheet"></div><aside id="ledger"></aside></div></div>`.
The `<aside id="panel">` goes; its vars-table moves into the viewer's Session
tab. Add the viewer layer on body (`<div id="viewer" hidden>`) and the
Session tab button (`<button id="session-tab">`) inside #layout.

styles.css (about 180 lines net). Move the max-width and margin off #sheet
(615–618) onto a new `#page { position: relative; max-width: 52rem; margin: 0 auto }`.
Add #ledger absolute at `left: calc(100% + 24px)`, width
`clamp(150px, calc((100cqw - 100%) / 2 - 32px), 224px)`; the cqw works
because #doc is already `container-type: inline-size` (611). The .lcard,
.lrow, .m, .note, .lthumb rules and the two keyframes come from the
recommended mockup, with the same corner, border and fill as today's .pane,
which they replace. The dot: `.run .dot` inside the run button (`.cell .run`
is at 683; the dot sits at the right of the ▶ band, in the fold column),
shown by `.cell.ran`, blue by `.cell.ran-last`. The narrow mode under
`body[data-ledger='spine']`: cards hidden unless `.peek` or `.pinned`, then a
232px popover at `right: calc(-1 * ((100cqw - 100%) / 2) + 8px)` in the frame
material. #session-tab at the room's right edge (inset below the top of
#doc's scrollbar so the thumb stays clickable). The viewer: a fixed layer,
`.big` absolute at the right with `width: clamp(360px, calc((100vw - 40px - 52rem) / 2 - 20px), 720px)`
and `max-height`, `.large` centring it at 880px over a dimmed backdrop; keep
.data-table, .viewer-foot and the #panel .figure rules (1196–1208, re-scoped)
verbatim. Delete the #panel block (1091–1130), .vars-table's #panel scoping
(1144–1175 stays, re-scoped to the viewer), the toolbar padding-right rule
keyed on #panel (129–131), and rename the source and grid view hide rules
(1303, 1423) to #ledger, #session-tab and #viewer. The 640px floor on #doc
(595) stays; nothing stacks on it any more.

panel.ts (about 60% rewritten, 250 lines). SessionPanel becomes the ledger.
State: `Map<cellId, Binding[]>` plus the last namespace snapshot
(NamespaceVar from src/kernel/protocol.ts:11–21: name, type, shape, length,
preview, scratch, figure). `refresh(cellId?)` diffs kernel.namespace()
against the snapshot: a new name, or one whose type, shape or preview
changed, is attributed to cellId with mark + (new) or ~ (it existed from
another cell), and marked gone in any card that held it; names that vanished
are dropped; the card takes `unseen`. `layout()` sets each card's top from
its cell's .cm-editor (or .ProseMirror) offset relative to #page, stacking
down only on overlap, driven by a ResizeObserver on #sheet. `fit()` reads
#doc.clientWidth, subtracts the padding and 832, halves it, and switches
data-ledger between cards and spine at 182px (150 plus the 32 of gutters).
`peek(card)`, `pin(card)`, `ack(card)`, `unpinAll()`. The viewer:
openFigure(), open(), more() and renderViewer() are kept nearly verbatim,
rendering into #viewer behind the three tabs; the Session tab is today's
refresh() row builder plus a cell column and the unseen dot; the Data tab
adds the chip row from the tabular names (isTabular); the Figures tab lists
DocumentView.collectFigures() (document-view.ts:791) plus the named figures,
newest first, captioned by name and cell. The diff is against the panel's
own last snapshot, not a "before the run" call: onRun fires after the run
(document-view.ts:742), and the snapshot is already there.

document-view.ts (about 30 lines). Cell (src/format/percent.ts:13–23) has
no id, so mint one on CellView (107–130): a counter in the constructor,
carried across convertKind (341) and splices (insertAt 1233–1236, delete
1270–1274), and set as `data-id` on `root`. Expose `cellElement(id)`. Pass
the id through onRun (742: `this.onRun?.(v.id)`) and tell the ledger about
deletions (the restorable delete path at 1166–1180) so it can drop the
card. RunMarker.toDOM (205–228) appends `<i class="dot">` to the run button
with a click handler that stops propagation and calls the ledger; runCell
toggles `.ran` and `.ran-last` on `v.root`. The armed Esc chord (296–310) is
where an Esc-then-P would go if wanted.

main.ts (about 40 lines). The onRun callback (646) forwards the id:
`(id) => void ledger.refresh(id)`; the restart handler (997–1003) calls
`ledger.reset()` after markAllStale; the toggle-panel handler (1004–1009)
cycles data-ledger over auto, spine and hidden on body and persists the
string under knuth-panel instead of '0'/'1'; the viewer's size is persisted
beside it. A document-level mousedown on #doc unpins a popover; Escape
closes the viewer, then unpins.

icons.ts: one glyph, `braces`, for the Session tab (the path is in the
recommended mockup), and `large`/`small` for the viewer's size toggle.

Kernel and Python: nothing for the first version. The optional `bound`
field in the run reply (id() comparison before and after exec, about 20
lines of Python) makes attribution exact for in-place mutations; add it only
if question 1 bites.

## What the recommended mockup shows

Open `session-panes-recommended.html`. At a full-width 1440 window the cards
stand in the margin with their marks; hover a card or its cell and the two
light each other and the run's time appears at the right of the first row.
Click ▶ on the stale cell (or "Run the stale cell"): the chip spins, the cell
gains its figure, the card eases in with a blue halo, keeps a blue rule until
the pointer finds it, and the names count ticks to 8; the chip's dot turns
blue (the previous blue goes grey). Click the Session head for the sorted
namespace with the cell that bound each name; a row opens the Data tab with
the chip picker and the "bound by" link, which scrolls to the cell; ⤢ makes
the viewer large; Esc closes it. Press Narrow (or resize under about
1324px): the cards fold, the Session tab hangs off the room's right edge,
and a dot's hover shows the cell's card as a popover; click pins it; a run
peeks it for a breath, and a run whose cell is off screen nudges the tab.
