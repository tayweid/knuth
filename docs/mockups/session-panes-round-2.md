# Session panes, round two: 2026-10-02

Taylor this morning, having opened inline-ledger, floating-edge and
peek-overlay from round one: "i like a lot of these three. they all have
nice ideas. lets keep going on prototyping. the layout questions from plass
above also apply here, wiht the sidebar and colors and all that. the knuth
specific things are about the panels."

Round two drew five mockups: a refinement of each of the three he liked, and
two hybrids. Every one uses the frame from his Plass notes of the same
morning: a dark grey surround (about #1e1e21, lighter than Zen's #141414 so
the soft shadow under the room reads), a narrow rail like Zen's (44px, 32px
tiles), and the room rounded at all four corners inside one thin 8px edge,
the top bar and the rail being part of that edge. The column of cells stayed
as it is. The subject was the panels: where the session's names, figures and
tables live, and how they show up when a run changes them. The same three
judges scored them: does it feel natural, does it work in a classroom, can
it be built on today's code. This is the record. Round one is
`session-panes.md`. The recommended composite, with the grafts applied, is
`session-panes-v2-recommended.html`.

## Recommendation

Build the ledger as round two drew it (`session-panes-v2-ledger-v2.html`).
For the first time in this design session the judges agree: all three put it
first (8, 8 and 8.5), three and a half points clear of the next. The session
stays in the margin as notes: a card for each cell that bound something, its
top on the cell's first line, tied to it by a hairline, so cause and effect
sit on one line. Round two fixed what round one left rough. On a narrow
window, a card folds to a small tab at its own corner of the cell. Round
one's dot inside the run button is gone, so the run chip is untouched
(src/styles.css:673 says "No dot", and a near miss on the dot ran the cell).
A table opens out of its card at the margin's width and leans over the
column only while you look at it. A white print says "this cell drew" and a
dark slip says "this cell bound names", and the two tell apart from across a
room. On a twenty-cell notebook the cards clamp to their cells instead of
drifting. Of the other four, three broke at least one of Taylor's rules:
they moved the column (peek-v2's pinned board, hybrid-ledger-float's
left-set column), changed the run chip (the same two), broke the frame's
single edge (hybrid-ledger-float's notch, floating-v2's tabs over the
frame's margin), or showed a run's news a column's width from the cell
(floating-v2). The fourth, hybrid-ledger-peek, keeps the rules but is mostly
a subset of ledger-v2, drawn on a shorter document.

The grafts take apparatus out as much as they add it. Ledger-v2 carried a
fixed Session head, a column of marks at the room's edge and a timer, and
the runners-up had drawn better answers. From peek-v2, the session's trace
moves into the frame: a pill at the top bar's right end holds the kernel
status and every name in cell order, says "empty session" or "fresh session"
in words, and keeps new names blue until you look (click one to go to its
card). It replaces the in-room head and the marks, which sat on the
scrollbar and read as a second one. Also from peek-v2: carrying on is the
acknowledgement (the next run, a keystroke or a click clears the blue rule
on every card on screen, so a keyboard user never piles them up); a card a
run unfolds on a narrow window stays up until you carry on, instead of for
2.2 seconds; a first-run note sits where the first card will go; and the
large Session view takes the board's classroom type, with small tables drawn
whole. From hybrid-ledger-float, the Figures tab follows new figures and the
pin holds one, with a newer figure waiting at the foot as "New: ax2, cell 18
→". From hybrid-ledger-peek, the fold along the tie with a 140/152px
hysteresis, a chip that brings back an opened table's cell, and its notes on
cell identity. From floating-v2, the Session tab opens on the last run's
receipt, and its notes' traps. One kernel change joins the first version: a
`bound` list on the run reply. The designers costed it at twenty lines; it
is about four, because the kernel already computes the assigned names for
figure receipts (python/knuth/session.py:162).

## The five round-two mockups

| Mockup | File | In one line |
| --- | --- | --- |
| Ledger v2 | `session-panes-v2-ledger-v2.html` | Round one's ledger refined on a twenty-cell notebook. Cards fold to tabs at their cell's corner on a narrow window. The viewer grows from its card and leans. White prints, dark slips, clamped cards. A fixed Session head and a column of marks at the room's edge. |
| Floating v2 | `session-panes-v2-floating-v2.html` | The three boxes as frame-grey tabs straddling the room's right edge. A run nudges a tab 5px out. A pulled box lives only in the free lane beside the column, so the sheet never moves. On a window of about 1680 or more they rest open. |
| Peek v2 | `session-panes-v2-peek-v2.html` | Nothing docked. A receipt appears beside the cell just run and flies into a session pill in the top bar when you type. Pinned, a classroom board at the right, and the column eases left. A first-run explanation of saved outputs and an empty session. |
| Hybrid: ledger and peek | `session-panes-v2-hybrid-ledger-peek.html` | One element in two postures: a receipt resting in the margin on a wide window, a tab that lifts a glass receipt on a narrow one. It folds along the tie between them. |
| Hybrid: ledger and float | `session-panes-v2-hybrid-ledger-float.html` | Margin cards for history, plus one box for the current figure or table in a notch cut into the room's top-right corner. The column sits left, so opening the box never moves it. |
| Recommended | `session-panes-v2-recommended.html` | Ledger v2 with the grafts above applied. |

Every mockup is self-contained: double-click to open. Ledger v2 and the
recommended one have a states card at the bottom left, the others a pill or
bar. ▶ on any cell runs it.

## The judges

Scores out of 10, rank in brackets.

| | Natural | Teaching | Buildable | Total |
| --- | --- | --- | --- | --- |
| Ledger v2 | 8 (1st) | 8 (1st) | 8.5 (1st) | 24.5 |
| Hybrid: ledger and peek | 7 (2nd) | 6.5 (3rd) | 7.5 (2nd) | 21 |
| Peek v2 | 6.5 (3rd) | 7 (2nd) | 5.5 (5th) | 19 |
| Floating v2 | 6 (4th) | 5 (5th) | 6.5 (3rd) | 17.5 |
| Hybrid: ledger and float | 5.5 (5th) | 6 (4th) | 6 (4th) | 17.5 |

The judges agreed on first place. They disagreed about the rest, and about
what to graft:

- **Peek v2** split the judges most.
  - Teaching put it second: the best design for a student seeing it once,
    with the pill, the flight home, the first-run note and the board's 17px
    type.
  - Buildable put it last: it breaks the stated constraint twice. Pinning
    slides the column, and the run chip gets round one's dot back.
  - Natural put it in the middle: the calmest resting state, but a receipt
    flies to the top bar on the first keystroke after every run, which is
    motion just when the eye wants to stay on the next cell.
  - Read: its ideas are the most grafted of the round; its posture is not.
- **Where the session's trace lives.** Natural and teaching moved it into
  the frame, as the pill. Buildable kept ledger-v2's in-room Session head,
  made to say "empty session" in words, and dropped only the marks. Two
  judges of three chose the pill, and each found a fault in the head:
  teaching saw it cover the top card when scrolled, and natural saw its
  narrow-window pill overlap prose at 820. The pill also costs almost
  nothing to build: it is today's last toolbar pod (#kernel-status beside
  #toggle-panel, src/main.ts:84-88) made into one control. Taken: the pill.
- **Hybrid: ledger and peek** was second for natural and buildable and third
  for teaching. Two judges called it "mostly a subset of ledger-v2", drawn
  on an eight-cell document. It is weakest exactly where ledger-v2 is
  strong:
  - it folds below about 1310, so a 1280 projector gets tabs where ledger-v2
    still shows cards;
  - crowded cards stack down with elbow ties and drift away from their
    cells.

  Its parts travel well: the fold, the hysteresis, and the most careful
  notes on cell identity in the round.
- **Hybrid: ledger and float.** All three judges called its persistent
  figure a real gain: it is the only design that keeps a figure large while
  you write the next cell, at 720px on a 1920 display. All three refused the
  rest:
  - the notched room breaks the single edge;
  - the column sits off-centre at every width, 16px from the room's left at
    1440 and 1512;
  - on a full-screen 1440 laptop the cards fold to dots in the run chip.

  Its follow-and-hold rule was grafted into the viewer's Figures tab; the
  box was not.
- **Floating v2.** Buildable put it third: it fixes round one's mechanical
  faults cleanly, and its notes catch real traps. Teaching put it last: the
  only sign of a run is a 9px kick and a small badge in the room's far
  top-right corner, invisible from the back of a room. And at 1920 the two
  resting boxes are the right-hand column again.
- **The white print, inside ledger-v2.** Teaching called the print and slip
  the best at-a-glance device of the round. Natural and buildable found a
  second white rectangle, 224px wide, beside every figure heavy. Taken: keep
  it white, make it small (132px).
- **Timers and acknowledgement.** Only the natural judge raised these.
  Ledger-v2's 2.2s narrow peek brings a timer back, after round one moved
  away from them. And acknowledging only by pointer piles up blue rules for
  someone running cells from the keyboard. Taken, with peek-v2's rule.

## What changed since round one, and why

- **The frame.** Round one used `rail-layout.html`: an 80px rail, a 66px top
  bar, a #111112 surround. Round two follows Taylor's Plass notes:
  - a #1e1e21 surround;
  - a 44px rail of 32px tiles and a 44px top bar;
  - the room inset 8px, rounded at all four corners.

  The narrower rail gives back 36px. That is why a 1280 projector now gets
  cards (about 150px) where round one folded them at about 1324.
- **The narrow window.** Round one's fallback was a 5px dot in the run chip,
  with a popover at the room's far edge. It is dropped for three reasons:
  the trigger and the card were a column apart, a near miss on the dot ran
  the cell, and it changed the chip. Now a card folds to a tab at its own
  corner of the cell, so wide and narrow windows share one attachment point.
- **The viewer.** Round one debated modal against beside and settled on a
  toggle. Now the viewer grows out of its card at the margin's width and
  leans over the column only after the pointer rests on it. ⤢ makes it
  large, and the size is remembered.
- **Long documents.** Round one stacked cards down when they overlapped, so
  in a dense notebook they drifted from their cells. Now a card clamps to
  its cell's gap with a +n badge and opens over its neighbour on hover.
- **The whole namespace.** Round one hung a Session tab at the room's edge.
  Ledger-v2 put a head at the top of the margin and a column of marks at the
  room's edge. All three judges dropped the marks, and the pill replaces the
  head.
- **Acknowledgement and timers.** Round one acknowledged a card when the
  pointer entered it, and peeked cards for 2.5s on a narrow window. Now
  carrying on also acknowledges, and there are no timers.
- **Saved outputs and an empty session.** Round one had no answer for a
  notebook opened with its outputs but an empty session. Now the pill says
  so in words and a first-run note explains it. Restart fades the cards
  instead of dropping them.
- **Attribution.** Round one's question 1 deferred a kernel `bound` list
  until it bit. Two designers asked for it and the natural judge grafted it.
  The live source shows it is nearly free, so it is in the first version.
- **Figures.** Round one listed every figure, newest first. The composite
  shows one print at a time with a chip for each, like the Data tab, and
  follows new figures unless pinned.

## Open questions

A suggested default follows each.

1. **Where the pill lives before Knuth has the Zen frame.** Default: in the
   toolbar's last pod (src/main.ts:84-88), which already holds
   #kernel-status and #toggle-panel. Merge them into one control there now,
   and move it to the top bar's right end when the frame comes. Plass's
   `ux/zen` draft is where the frame's values land first.
2. **Does hovering the pill acknowledge?** In peek-v2, and for the natural
   judge, hovering cleared the blue names. The composite does not do that,
   because the pill is also the way to the new card, and a hover would clear
   the name before you could click it. Default: opening the Session tab or
   clicking a blue name acknowledges; hovering does not.
3. **The print's size.** Default: 132px wide, still white. If the margin
   still feels busy, shrink the print to the white mark the tab already
   uses.
4. **The card floor.** Default: fold under a 140px card and unfold above
   152. (Ledger-v2 asked 140 against round one's 150; the gap is the
   hysteresis.)
5. **After a run on a narrow window.** Default: the card stays unfolded
   until you type, press Esc or click the document, then folds into its tab.
   The alternative is ledger-v2's 2.2s timer.
6. **The lean.** Default: a wide table or figure leans over the column after
   the pointer has rested on it for 0.4s. Switch to click-to-lean if that
   still surprises.
7. **What follows.** Default: while the Figures tab is open it follows each
   new figure, and the pin holds one. Tables never follow on their own.
8. **Restart.** Default: cards fade to "before the restart" and come back as
   their cells run. Run stale runs program cells only, so a scratch cell's
   card stays faded.
9. **The first-run note.** Default: shown while the session is empty, beside
   the first code cell; on a narrow window it is a callout under the pill.
   Once a person has seen a card arrive, remember that under
   knuth-session-coached, and from then on only the pill's words remain.
10. **The Session control's modes.** Default: keep auto, tabs and hidden.
    Tabs is the narrow window's own code path, not a second system, so
    letting the control force it costs nothing.
11. **Esc then P for the Session tab.** Default: add it. It joins the
    Esc-Y/S/M chord and avoids Chrome's ⌘J.
12. **`bound` in the first version.** Default: yes, about four lines plus a
    test.
13. **A deleted cell.** Unchanged from round one: its names stay in the
    Session tab as "deleted cell", with no card.
14. **The roadmap.** docs/ROADMAP.md:36-53 still describes the floating
    boxes and says it will be rewritten once a direction is accepted.
    Default: rewrite it to the ledger when Taylor accepts this.
15. **A resumed session.** A reloaded tab reattaches to its living session
    ("Session resumed", src/main.ts:418-420), so the kernel holds names this
    page never saw bound. Default: they appear in the pill and the Session
    tab marked "before this page loaded", with no cards, until their cells
    run again.

## Implementation notes

Checked against main at 2d7a0b2.

Rough size: two evenings and about 750 lines touched. That is ledger-v2's
own estimate of 600, plus about 150 for the grafts, plus four lines of
Python and their tests.

Nothing in the cell column changes. The run chip (RunMarker at
src/document-view.ts:205-229; `.cell .run` at src/styles.css:683 on) is
untouched. The frame (top bar, rail, surround) is the separate Zen work.
This change needs from it only the place where the pill lives.

### Corrections to the designers' notes

These came from checking the notes against the source:

- **Construction order.** Ledger-v2's notes build `new Ledger(..., docView)`
  at main.ts:613. But docView is a const declared at 641, so that line
  throws a temporal dead zone error (floating-v2's notes caught it). Build
  the ledger after line 641. The onRun closure passed at 646 reads it at
  call time, so nothing else moves.
- **The `bound` list is nearly free.** Session.run already sets
  `self.last_assigned = _assigned_names(tree)` (session.py:58-80, 162-163)
  for figure receipts (kernel.py:154-156).
  - Add `"bound": sorted(session.last_assigned)` to the done event at
    kernel.py:194. The Pyodide kernel loads the same knuth.kernel module
    (src/kernel/pyodide-kernel.ts:56, 104), so both engines get it.
  - In protocol.ts, add `bound?: string[]` to the done event (167) and
    `optionalStringArray(event.bound)` to its check (249-251).
  - RunOutcome (kernel.ts:83-90) gains `bound`, set at 360-361.
  - No protocol version bump is needed: an older engine omits the field and
    the page falls back to the diff.
  - Its limit: `_target_names` (session.py:45-55) sees only plain names, so
    by the AST `prices['log_q'] = ...` binds nothing. Keep the preview diff
    for in-place changes like that.
  - The ownership rule: after a run, the cell owns every name in `bound`,
    plus every name whose type, shape or preview changed.
- **Which comparison decides "changed".** A card changed when the cell's new
  bindings differ from that cell's own card, not from the namespace
  snapshot. Against the snapshot, Run all would mark cell 2 changed, because
  prices goes from 1187 × 5 to 1200 × 3 partway through the replay, even
  though nothing has changed by the end. The composite's `applyRun` is the
  rule.
- **Names the page never saw bound.** Today's refresh at main.ts:427 runs on
  every kernel ready, including a resumed session, and is unattributed. The
  ledger must take names with no owner: they go to the pill and the Session
  tab only (open question 15). The same path covers names left by a deleted
  cell.
- **Cell identity.**
  - convertKind (document-view.ts:341) keeps the CellView, so an id minted
    on it survives a kind switch.
  - Deleting a cell and restoring it goes through spliceIn (1232, from the
    undo set up in remove at 1280-1283) with the same Cell object, so a
    `WeakMap<Cell, id>` gives it back its id and its card.
  - render() (566 on, called by setDoc at 482 and setSource at 550) rebuilds
    every view, and in source mode it reparses into new Cell objects. Reset
    the cards there, and keep the names in the Session tab.

### File by file

**index.html** (19-22): change to
`<main id="layout"><div id="doc"><div id="page"><div id="sheet"></div><aside id="ledger"></aside><aside id="coach" hidden></aside></div></div></main>`,
and add `<div id="dim" hidden></div><section id="viewer" hidden></section>`
on body. `aside#panel` goes. Ledger-v2's #shead and #ruler are not built.

**main.ts:**
- 84-88: the last toolbar pod becomes `<button id="session-pill">`, holding:
  - the existing `<span id="kernel-status">`, so paintKernelReady (289) and
    the bad states (428-445) keep working unchanged;
  - a hairline;
  - `icon('braces')`;
  - `<span class="names">`.

  The mode cycle from toggle-panel moves to a small control after the pill.
- 613-614: construct the Ledger after docView (641). knuth-panel stores
  'auto', 'tabs' or 'off', with the legacy '0' read as off and '1' as auto.
  knuth-viewer-size and knuth-session-coached are stored beside it.
- 646: `(run) => void ledger.ran(run)`, where run is
  `{ id, ms, ok, bound, named, batch }`.
- 427 (kernel ready), 741 (after a uv install) and 781 (a new document's
  session): refresh without attribution.
- The restart handler (997-1003): call `ledger.restarted()` after
  markAllStale. It fades the cards, empties the owners, and the pill says
  fresh session.
- 1004-1009: the control cycles auto, tabs and off.
- A capture keydown next to the listener at 1011:
  - Escape closes the viewer, then unpins, but only when focus is not inside
    a `.cell`. That keeps the armed Esc chord working
    (document-view.ts:296-321; the cell keymap arms it at 1132).
  - A 'p' within 2s of an Escape calls preventDefault and opens the Session
    tab.
  - Any printable key, Enter or Backspace calls `ledger.carryOn()`.
- A mousedown in #doc outside `.lcard`, `.ltab` and `.run` also calls
  carryOn.

**document-view.ts** (about 45 lines):
- CellView (107-134) gains `id`, minted in buildView (875) through a
  `WeakMap<Cell, string>` and set as `root.dataset.id`. Expose
  `cellElement(id)` and `cellSource(id)`.
- onRun's type (288) becomes `(run: RunInfo) => void`. In runCell (677),
  time `kernel.run` with `performance.now()`; `named` is already collected
  at 706-708. Call it at 742 with
  `{ id: v.id, ms, ok: outcome.ok, bound: outcome.bound, named, batch: this.batch }`.
- runAllProgram (652-658) and runStale (660-666) set `this.batch = true`
  inside try/finally, so batch runs never unfold a card.
- remove (1269-1284) reports the id, so the card drops.

**panel.ts** (about 60% rewritten; SessionPanel becomes Ledger, around 380
lines):
- State:
  - `cards: Map<cellId, {took, print?, rows}>`
  - `owner: Map<name, cellId>`
  - `snapshot: Map<name, NamespaceVar>` (src/kernel/protocol.ts:11-21)
  - `unseen: Set<cellId>`
  - `restarted`
  - the viewer as `{tab, key, origin, size, held, pending}`
- `ran(run)`:
  - reads `kernel.namespace()`;
  - gives the cell ownership of `bound` plus the changed names;
  - replaces the card;
  - marks it unseen only if its bindings changed, and in a batch never for a
    card's first appearance.

  Marks and strikes are computed at render: + when no card above binds the
  name, struck when another cell owns it now.
- Keep isTabular (12-18), shapeLabel (20-24), open, more, renderViewer and
  openFigure (92-215) nearly verbatim, rendering into #viewer behind the
  Session, Data and Figures tabs. The re-open in refresh (80-90) becomes the
  in-place redraw that says "was 3 × 2".
- Figures come from the cell's own SVGs (CellView.figSvgs through
  createSafeSvgImage), not from kernel.figure(name), so a print survives its
  name being rebound. The tab follows new figures unless held.
- Port these from the composite:
  - layout();
  - fit(): cards when LW ≥ 140, back from tabs at 152, tight when the right
    gap is under 56;
  - the fold (Element.animate on clones placed in #page);
  - paintPill(): overflow to +N, hiding old names before new ones;
  - syncCoach().

**styles.css:**
- Move max-width and margin off #sheet (613-618) onto
  `#page { position: relative; max-width: 52rem; margin: 0 auto }`.
- Delete the #panel block (1089-1130) and the toolbar padding keyed on
  #panel (127-131).
- Keep these, and add a sticky index column:
  - .vars-table (1144-1175);
  - .viewer-head and .viewer-scroll (1177-1193);
  - the figure rule (1196-1208), re-scoped to #viewer;
  - .data-table and .viewer-foot (1210-1254).
- In the source hide rules (1303-1304) and the grid ones (1423-1424), name
  #ledger, #coach, #viewer and #session-pill instead of #panel and
  #toggle-panel.
- Add from the composite (about 260 lines):
  - the cards: .lcard, .lslip, .lprint, .lcap, .lrow, plus .past and .lpast;
  - the tab, its unfold and fold from --ox and --oy, and tight mode;
  - #session-pill, #coach and #pillnote;
  - in the viewer: the chip, the pin, .newpill and .fig-one;
  - the grouped Session rows and the board.
- Use `overflow: clip`, not hidden, on any layer at the window's edge. html
  has `overflow-x: auto` (91-92), so one pixel past the edge becomes a
  sideways scroll.

**icons.ts:** braces, pin, large and small.

**Tests:**
- a protocol test for `bound` (src/kernel/protocol.test.ts);
- a Python test that the done event carries the assigned names
  (python/tests/test_kernel.py);
- three browser tests click a name in today's always-open Session table, so
  they change:
  - tests/browser/app.spec.ts:146-165 clicks 'chart' and expects
    `.viewer .figure img`;
  - tests/browser/protocol.spec.ts:116-130 clicks 'df' and expects
    `.data-table`;
  - tests/browser/app.spec.ts:335 lists #panel among what a source file
    hides.

  The first two open the Session tab from the pill first; the named-figure
  path through kernel.figure(name) and openFigure stays for names picked
  there, so the `img` check keeps its meaning. The third names #ledger and
  #session-pill.
- `npm test`, `npm run test:browser` and `npm run app:smoke` still pass;
  run `npm run check:web` before committing.

## What the recommended mockup shows

Open `session-panes-v2-recommended.html` by double-clicking it. The states
card at the bottom left is mockup chrome, not Knuth. A walk through the
grafts:

- **At rest:** cards in the margin, the session's names in the bar.
- **Run the stale cell, then type a key:** the blue rule goes.
- **Run all:** the edited cell's names stay blue in the bar; click one to go
  to its card.
- **First run:** the empty session explained in the margin. Run cell 1,
  which only imports, so the note stays; then run cell 2.
- **Restart, then Run stale on the rail:** the faded cards come back; the
  scratch cell's card stays faded.
- **Figure held:** the new bar chart waits at the foot.
- **Session large:** the board.
- **On a narrow window,** try A run and then type, The fold, and the 820
  floor.

All 23 states and these interactions were checked in headless Chromium at
1500 × 940 and 1100 × 760, with no console errors.
