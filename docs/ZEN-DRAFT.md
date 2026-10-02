# The Zen draft

Knuth in Zen's shape, on the branch `ux/zen` (2026-10-02): the same
frame Plass has had on its main since this morning (Plass's
`docs/ZEN-DRAFT.md`, merge c5ed545), so the two apps read as one system.
The first draft was the morning's; the second pass, the same afternoon,
answers the two reviewers' findings (below, *The second pass*) and
merges main's autosave record. A dark grey frame — the bar across the
top beside the traffic lights, a narrow rail of tools down the left,
one 8 px edge round the rest — holds the room, a rounded graphite panel
where the document sits. The document column itself is untouched ("the
cell vertical column is basically perfect"): it keeps its 52rem measure
and centres in the room. Taylor's own drafts of the shape are
`docs/mockups/rail-layout.html` and this morning's
`docs/mockups/session-panes-v2-recommended.html`.

The record is `docs/zen-draft-1100.png` and `docs/zen-draft-1500.png`:
the shell from the checkout on `app/knuth.json`, at 1100 and 1500 px
wide, after a run on uv, the document opened from `~/Projects/week-3`
(for the capture a link there to a scratch folder, removed after, so the
pill's folder line reads as a real project's does). They are page
captures (Playwright's `_electron`, `webContents.capturePage`), so the
traffic lights — the window's own, drawn over the page — are not in
them: their room is the empty 100 px left of the File tile.
(`screencapture` of the window needs a screen-recording grant this
session does not have; Plass's record has the same gap.)

The scroll rail (branch `ux/rail`, the evening of 2026-10-02) maps the
document in a 20 px gutter of the frame at the window's right while the
column runs past the room: Plass's rail with Knuth's marks (below, *The
scroll rail*; its record is `docs/zen-rail-1100.png` and
`docs/zen-rail-1500.png`).

## The scroll rail

Taylor, once Plass's rail was built (Plass's `docs/ZEN-DRAFT.md`, *The
scroll rail*; its design round, `plass/docs/mockups/scroll-rail.md`,
where Taylor chose the gutter: "i think i like gutter-hover.png the
most"): "would it be easy to add a scroll rail similar to plass for
knuth?", and then "yeah queue it up after the plass rail lands". So
this is Plass's rail (branch `ux/rail` there, 7f0b47e) on Knuth's frame,
with Knuth's own marks. Plass's next commit there, eddd06c (the page
numbers keep an even run at any window height), changes only where the
page numbers go and which hairline gives way under one; the track, the
band, the label, the drag and the keys are as they were, and Knuth has no
pages, so there is nothing of it to carry. The record is `docs/zen-rail-1100.png` and
`docs/zen-rail-1500.png`: the checkout shell (`~/Projects/claerbout`,
launched as `app/run.mjs` does, on a scratch state folder and port) on
uv, a coffee-demand notebook opened through a temporary link at
`~/Projects/week-3` (removed afterwards), every cell run (the fifth
raises a NameError), mid-document with the figure in the room and the
pointer on the "Elasticity" heading's mark, its label beside it, the
red mark below the band. Page captures at 2× through Playwright's
`_electron` and device metrics, so the traffic lights are not in them.

**What was built.** While the column runs past the room in the cell
view, the frame's right edge widens from 8 px to a 20 px gutter and the
rail lives there, on the dark frame, outside the room. The room keeps
its left, top and bottom edges and is 12 px narrower; the column keeps
its own width rules (the 52rem measure at any usual width, so only its
margins change). The rail stands for the whole document, its track
exactly the room's height, so at the top the band's top is level with
the room's top and at the end its bottom with the room's bottom. A
document that fits the room, and the source and grid views, keep the
8 px edge and no rail. On the rail, light marks on the dark, shown at
rest:

- headings in text cells as dots by level: a `#` heading the title's
  7 px, `##` a section's 5, `###` and deeper a subsection's 3;
- each code cell (scratch cells too, which the receipt also numbers) as
  a faint 7 × 1 px tick at its top, so the rail reads as the notebook's
  rhythm, code and prose; on a long notebook a tick within 4 px of the
  last one drawn is left undrawn (still a target), as Plass thins its
  hairlines;
- the cell whose last run raised as a red tick (9 × 2 px, the readout's
  #cd6452), the running cell's tick pulsing in the run control's green;
  neither is dimmed outside the band or thinned;
- a figure under a cell as a filled 5 px square at the figure's top, and
  a table as an open one, Plass's two squares;
- the cursor's cell as the blue bar at the cell's top, under the cell's
  own mark and wider than it, so it shows either side of a red tick;
- the visible span as a lighter rounded band, the marks outside it a
  step quieter.

The pointer: the nearest mark within 7 px grows and turns white, and one
dark-glass label hangs to the rail's left over the room's margin: a
heading's words in the bar's serif; a code cell's number as the receipt
counts it and its first line in the code's mono ("Cell 3 ·
demand = prices.groupby(…)"), or with its last run raised the
traceback's last line in red ("Cell 5 · NameError: name 'fit_line' is
not defined"), or "running" while it runs; "Figure · Cell 3";
"Table · prices · Cell 2"; the cursor's bar "Cursor · Cell 9", or in a
text cell the cell's first block ("Cursor · Demand for coffee": its
heading when it opens with one, else its first paragraph); over empty
track a faint line and the cell or section that point is in. A click puts the mark's place an eighth of
the way down the room (a cell's top, a heading, a figure); empty track
centres that point; a press that drags scrubs the band and jumps
nothing; the wheel over the gutter scrolls the room. The keyboard: one
tab stop, Up and Down, Home and End between the marks with the label
following, Return or Space jumps. The band brightens while the pointer
is in the gutter and for 0.9 s after the room scrolls. A press that
began in a cell (a selection dragged toward the edge) wakes nothing on
the rail, and a gutter due under a held button waits for the release.

**The mechanism.** The marks come from `src/rail-marks.ts`, Knuth's mark
source, which reads the cells (`DocumentView.railCells`: each row, its
number, its headings, the figures and the readout under it, whether its
last run raised, whether it runs; `focusedId`, the cursor's cell) and
the session (`Session.tables`: the names a cell's last run left that
are a DataFrame or a 2-D array). `src/scroll-rail.ts` is Plass's
module, its structure and names kept so a fix carries across (its
header says so): it places each mark at its element's top in the room's
scroll px over the room's scroll height, written once as `--f` and
placed by CSS, and the band at the room's scrollTop and height over the
same scroll height, so the two agree by construction. The marks are
read again when the column settles: one ResizeObserver on the column
(`#sheet`) and the room (`#doc`), coalesced into a frame (an output
arriving, a figure loading, a cell added or removed, a line typed, a
rewrap at a new width, the window's height, which moves the 40vh under
the column); and when a run starts or ends (`onRunStart`, `onRunDone`
in main.ts), which changes a tick's colour without a size. A mark is
reused by its key (the cell and the mark's place in it; a heading
retyped to another level changes its dot), so a read writes only what
moved, and the focus and the hover survive it. Every place is read
before any mark is written: a write between two reads lays the column
out again, so reading and writing mark by mark cost a layout per mark
(246 for a new line in rail.spec's 240-cell notebook, about 40 ms),
and reading first costs 4 or 5. A cell run again after it raised is
running, not raised, until the run ends (its readout keeps the red till
then; `railCells` does not). The cursor's bar moves on
`focusin` in the column, in a frame. A scroll writes, in a frame, the
band's offset (a transform on its own layer; its height only when the
range or the room changed) and the class `in` on the marks the band's
edges crossed, usually none; nothing it writes is inherited by the
marks. A keystroke that keeps the column's height writes nothing to the
rail (rail.spec watches the rail's DOM through typing); a new line is
the column settling and moves the marks under it. The gutter is the
`has-rail` class on the root, set when the column's end at the top of
the scroll is below the room's bottom (the 40vh under the column is room
to type into, not document), which sets `--edge-right`, split out of
`--edge` as Plass split it: the room, the onboarding over it, `#doc`'s
floor and `--axis` (the toast) read it. The room draws no scrollbar of
its own in the cell view, rail or not (the source view's editor keeps
its own): the rail is the map, and a scrollbar that came and went with
the rail would widen the column as the gutter narrowed the room. So the
gutter's 12 px are all that come and go. A narrower column is mostly a
taller one, but not always: a figure is drawn to the column's width
(`max-width: 100%`), so it is shorter in a narrower column, and a column
can fit the room only once the gutter has taken its 12 px, and run past
again without them (a matplotlib-sized figure in a 700 px window about
850 px tall; the pinned Session card at 1100 with a `figsize=(10, 4)`
figure). The gutter would then come and go every frame. So when it would
go, `refresh` asks again at once at the wider width, before the frame
paints, and a column that runs past there keeps its gutter; the class
ends where it began, so nothing asks again. It comes and goes at once,
not animated.

**The pinned Session card** is unaffected in kind: it slides the column
inside the room, and the rail is outside it, so the two never meet. Its
rule reads the room's box (session.ts, `frame()`), so with the rail it
has 12 px less: at 1100 × 760 docked, the card 320 px and the column 644
(656 without the rail); at 1500 × 940 the card 380 and the column its
832, slid 12 px further left; the window under which the room scrolls
sideways rather than the card lie over the column is about 1097 px
(1085 without).

| | no rail (main's numbers) | with the rail |
|---|---|---|
| the frame at the room's right | 8 px | 20 px |
| the room at 1100 × 760 | (44, 44) to (1092, 752), 1048 × 708 | (44, 44) to (1080, 752), 1036 × 708 |
| the room at 1500 × 940 | (44, 44) to (1492, 932), 1448 × 888 | (44, 44) to (1480, 932), 1436 × 888 |
| the column at 1100 / 1500 | 832, x 148–980 / 348–1180 | 832, x 142–974 / 342–1174 |
| `#doc`'s floor (min-width) | 640 − 44 − 8 = 588 | 640 − 44 − 20 = 576 |
| the window the room scrolls sideways under | 640 | 640 |
| the column at the floor | 548 | 536 |
| docked at 1100: card / column | 320 / 656 | 320 / 644 |
| the docked floor's window | about 1085 | about 1097 |
| the chip tucks inside its cell under (`@container`) | about 990 | about 1002 |

The rail: 20 px wide, its track the room's height (708 px at 760, 888 at
940). The band, the marks' sizes and colours and the label's glass are
Plass's: the band 14 px wide, 4 px corners, at least 10 px tall, white
3.5 % over an 8 % edge at rest, 7.5 / 17 % lit, 11 / 24 % dragged; dots
7, 5 and 3 px at .86, .72 and .56; squares 5 px, a figure filled at .60,
a table a 1.2 px line at .70; outside the band the marks at 60 %; the
label rgba(27, 26, 30, .94), the heading 13 px STIX Two Text. Knuth's
own: the code tick 7 × 1 px at rgba(240, 238, 233, .5); the red and the
running tick 9 × 2 px at full strength (#cd6452; #6ea576 pulsing to 30 %
over 1.1 s); the cursor's bar 12 × 2 px #9db8d6 (Plass's caret is
8 px; open, below); a code line in the label 12 px mono, an error #e08a7b. The bar
keeps its own 8 px at the right: the session pill ends at the window's
edge less 8 whether the rail shows or not.

**What differs from Plass, and why.**

- *When the marks are read.* Plass's paper is laid out once at 816 px
  and drawn to the panel by a transform, so it reads the marks from the
  settled layout pass and a resize moves none of them. Knuth's column
  reflows and a cell grows as its output arrives, so the marks are read
  whenever the column or the room changes size, and when a run starts
  or ends; reusing each mark by its key keeps that cheap.
- *What the track maps.* The room's whole scroll height: the 24 px above
  the column and the 40vh under it are part of the scroll, so the band
  can go there, and the bottom of the track is that empty run (about 7 %
  of it on a forty-cell notebook at 1100 × 760, about a third on a
  document just past the room; in Plass the marks run to the rail's
  foot). The 40vh changes with the window's height, so a change of the
  height alone moves every mark a little along the track though no cell
  moved (forty cells: the last mark 0.909 of the way down at 760 tall,
  0.898 at 900, 0.922 at 600, about 10 px of track); a change of width
  moves a mark only where the column rewraps. Mapping the
  column alone would keep the marks still and run them to the foot, but
  the band could then not be the room's scroll: over the last 40vh it
  would stop at the foot while the room still moved. Whether the rail
  shows is asked of the column alone.
- *No pages.* Plass's page breaks, their numbers and the numbers'
  crowding rule have no place here; the code ticks thin instead.
- *The landing.* CodeMirror lays out a cell far off screen from an
  estimate of its lines and measures it as it comes into view (3 px for
  one cell of rail.spec's notebook, more for long wrapped lines), which moves what
  is under it while a jump's smooth scroll is on its way. At the
  scroll's end the target is read once more and the scroll put right at
  once; a wheel, a press or a key before then cancels that.
- *The scrollbar.* Plass's panel never draws one; Knuth's room drew the
  system's. It draws none in the cell view now, rail or not, which is
  also what lets the gutter decide on the column's height alone (Plass
  asks whether its paper runs past at the gutter's width, which a
  reflowing column cannot know without laying it out).
- *The cursor.* Plass's caret bar is the caret's line; Knuth's is the
  cursor's cell, at its top, and moves when the focus goes to another
  cell, not with the arrows inside one. It is drawn under the cell's
  own mark and wider, and loses a tie at the cell's top to it, so a
  hover there names the cell.
- *The labels* lead with the cell's number and carry no page; a code line
  is in mono, an error in red; empty track names the cell or section
  there rather than a page.
- *The session pill* no longer ends where the room does while the rail
  shows: it keeps the bar's 8 px, 12 px past the room over the gutter,
  as Plass's bar keeps its own, so it does not move when the rail comes
  and goes (frame.spec's alignment holds for every document that fits).

**What is open.**

1. *The pill's right edge* (above): keep it at the window's 8 px, or move
   it with the room (it would then shift 12 px whenever the rail comes or
   goes, a view switch for one).
2. *Tables.* A Series is not one here, though the chip's table glyph
   and the Data tab count it (`isTabular`): counting it put an open
   square on nearly every pandas cell (seven in the record's ten). So the
   elasticity cell's chip shows a table where the rail shows none. One
   rule for both would be one line either way.
3. *The cursor's bar at the cell's top* or at the cursor's line, as
   Plass's: the line would follow the arrows inside a long cell, and
   needs a hook on each editor's selection.
4. *The cursor's bar's width*: 12 px, against Plass's 8, on the 14 px
   band. It stands at the cell's top, where the cell's own tick is, and
   is drawn under it, so it shows either side of the 9 px red tick of a
   cell that raised, the cell you are most likely fixing; at Plass's
   8 px it would vanish under that tick (and show half a pixel either
   side of a plain one). One value in styles.css (`.sr-caret`).
5. *The track's foot* (above, *What the track maps*): it is the empty
   run under the last cell, so the marks stop short of the foot, and a
   change of the window's height moves them by the 40vh's share.
6. *Staleness* is not drawn (an amber tick would read the way the
   gutter's amber does); nor is uv's work for a cell (its spinner) a
   pulse, only a run.
7. *Thinned ticks* on a very long notebook are not drawn; a label still
   names them. Whether a notebook that long wants the ticks at all is
   for a long notebook to say.
8. *Cell zero* folded to the package header has no mark; unfolded (or a
   script's body before its first marker) it is "Cell 0".
9. Plass's open items apply: the unrolling outline, the frame's uneven
   edge (6 beside the tiles, 8 at the bottom, 20 at the right while the
   rail shows).

**The verifiers' round.** Two verifiers drove 09c4456: one in the
checkout shell beside main and Plass's rail (four documents, three
window sizes, a zoom step, the pinned card, CDP's layout counts), one
over the code with probes in a copy. Nine problems, seven distinct;
each closed with a test in rail.spec that fails on 09c4456:

1. *A new line cost a layout per mark* (twice reported). `build` read
   each mark's place after writing the last one's `--f`, so a change of
   the column's height, which moves every mark under it, laid the column
   out once per mark: 246 layouts per Enter on the 240-cell notebook
   (about 40 ms), 44 per key on a forty-cell one against main's 2. Every
   place is now read first (`markFor` takes it), then every mark
   written: 4 or 5. Test: a new line in the 240-cell notebook, under 30
   layouts by CDP's count, the last tick moved.
2. *The cursor's label in a text cell* ran the heading into the
   paragraph ("Cursor, Demand for coffeeThe price…", twice reported):
   the editor's textContent has no space between blocks. It is now the
   cell's first block with words, its heading when it opens with one,
   read block by block (innerText would lay the column out). Test:
   the bar's name in the title's cell.
3. *The gutter could come and go every frame*: the header, this record
   and 09c4456's message said a narrower column is never shorter, which
   a figure drawn to the column's width disproves (15 class writes on
   the root in 250 ms). `refresh` asks again at the wider width before
   the frame paints and keeps the gutter (the mechanism, above). The
   verifier's two height scans (a 700 px window, 560–900 tall; the
   pinned card at 1100, 500–900 tall) find nothing now. Test: an
   800 × 600 figure at 700 wide, the window's height between the two
   column ends, at most two class writes in 250 ms, the gutter kept.
4. *A heading retyped to another level kept its dot*: its key is its
   place in its cell, which survives the retype, and the reused mark
   kept its kind. `markFor` now swaps the class and the kind. Test:
   Mod-Alt-2 in the title, a 5 px section dot; Mod-Alt-1, the 7 px
   title's again.
5. *A cell run again after it raised read as raised while it ran*
   (red, "raised" in red in its label): the readout keeps its class till
   the run ends. `railCells` reports no error while a cell runs. Test:
   Cell 4 run again slowly, running and not red, named by its first
   line, red again when it raises.
6. *The cursor's bar is 12 px, Plass's 8*: kept, and put to Taylor
   (*What is open*, 4), since at 8 px it vanishes under a red tick.
7. *A change of the window's height alone moves the marks*: kept, and
   said (*What the track maps*; *What is open*, 5), since mapping the
   column alone would part the band from the room's scroll.

## Checks (the scroll rail)

- `npm test`: green. `npm run build:engine` and `npm run check:web`:
  green ("committed app matches its sources"), the stamp committed.
- `CI=1 npx playwright test` on a spare port (a scratch config on 5487
  with `--strictPort`, outside the checkout, deleted after): 123 passed
  and one failed, `app.spec.ts`'s embed test, which hardcodes 5198 in
  its iframe and so fails alone on any other port; nothing else retried.
  rail, frame and session specs `--repeat-each=3` with no retries:
  201 of 201. (09c4456's run: 120 and the same one.)
  `tests/browser/rail.spec.ts` (15 tests): the gutter and the rail only
  while the column runs past the room, the room's box with and without
  it, the session pill unmoved, no scrollbar in the cell view, the
  onboarding's right edge and the toast's axis following the room; none
  on a short document, in the source view (and back) or in a long
  .csv's grid and source views; the room's box at 1100 and 1500, the
  column 832 and centred, the pinned Session card inside the room 46 px
  past the column and 10 px in from the room's edge with the rail
  showing, the floor still a 640 px window with the column 536 there;
  every mark's place against its cell's (title, sections, subsections,
  twelve code ticks, a figure and a table after runs, the marks
  following the cells the figure pushed down, and again after a rewrap
  at 1500), the marks' sizes; the red tick after a run that raised
  (history.spec's message), its label, the running cell's pulse, the
  raised cell run again running and not red, then red again; the
  cursor's bar moving with a click, named by its cell or, in a text
  cell, by the heading; a heading retyped to another level taking that
  level's dot, and back; the label for a heading and a code
  cell, a retyped first line, empty track and the track's ends; a click
  landing a cell's top an eighth down the room, a heading too; a drag
  scrubbing and jumping nothing; the wheel; the band's span against
  scrollTop and scrollHeight at four places, lit while the pointer is in
  the gutter and 0.9 s after a scroll; a scroll writing only the band and
  `in`, a keystroke writing nothing to the rail, a new line moving the
  ticks; the keyboard; nothing waking during a selection dragged from a
  cell into the gutter; a 240-cell notebook's ticks thinned 4 px apart
  with a red one always drawn, and a new line there under 30 layouts by
  CDP's count (4 or 5; 246 before the verifiers' round); an 800 × 600
  figure at 700 wide with the window's height between the column's two
  ends, at most two class writes on the root in 250 ms and the gutter
  kept. The five checks the verifiers' round added fail on 09c4456 and
  pass now. `frame.spec.ts` says where the room's
  right edge is the gutter's (its documents fit the room, so its numbers
  stand).
- The Python tests are untouched (no engine change).
- `node ~/Projects/claerbout/smoke.mjs --config app/knuth.json browser`
  and `uv`: ok, with the autosave record's subjects ("knuth: session
  open", "knuth: cell run [1]") in the smoke's throwaway folders; after
  the verifiers' round, `browser` again: ok, the same two.
- The record's run in the checkout shell: no console errors; the rail
  there at 1100 and 1500 with the room at (44, 44)–(1080, 752) and
  (44, 44)–(1480, 932).

## The second pass

Two reviewers approved the frame — it matches Plass to the pixel — and
found where Knuth still behaved unlike Plass, and one defect. Each is
now Plass's way (`plass/src/toolbar.ts`, `toolbar.css`, `style.css`),
since one system is the point.

- **File is Plass's text menu.** The tile dropped a row of three bare
  glyphs, and Recent then swapped it for a text list; at the same spot,
  in the same glass, Plass drops a vertical text menu. Now Knuth does:
  New window, Open… ⌘O, Recent documents ›, Save ⌘S, and below a rule
  the three that apply in one place each — **Get Knuth for your Mac ›**
  on the hosted demo, **Install Knuth** in a locally served tab the
  browser offers to install, **Check for updates…** in Knuth.app
  (Plass's item: it asks the shell, and reads *Install update* once the
  shell has a newer build, asked or by itself after launch). Recent and
  Get take the menu's place with a "‹ File" way back. Plass's dark glass
  and item style: 258 px wide, 13 px corners, 32 px items, the shortcut
  in soft ink. The mechanics are Plass's, ported as `src/menu.ts`: a
  click opens it on its first item; the arrows, Home, End and a letter
  walk it; ArrowRight opens a submenu, ArrowLeft goes back; Escape, Tab,
  a click elsewhere or a second click on the tile close it. One
  difference: closing hands the focus back to where it was when the
  menu opened — the cell being typed in, or the tile when the keyboard
  opened it — so a File action leaves the typing where it was, and
  Escape no longer also starts the cell's Esc-Y/S/M chord (a wrinkle the
  first draft had). The bar's right end now holds the kernel's status
  alone.
- **The save mark is Plass's dot**: 6 px beside the name, green
  (rgba(110, 165, 118, .9)) when the file on disk holds the document,
  red (rgba(205, 100, 82, .95)) for unsaved changes or no file yet (its
  title then says ⌘S picks the folder). It was an amber ● inside the
  name, shown only when dirty, and an ellipsis on the name hid it.
- **The name pill gives up the folder, never the name or the mark.**
  Flexbox weighs shrinking by width, so a folder line of about 65
  characters at 1100 px (any iCloud or Dropbox path) cut the name to
  'week3.…'. Now the name and the mark do not shrink (the name takes an
  ellipsis only if it alone overfills the pill), and the folder
  ellipsizes from its start, so the nearest folder stays:
  '…/Teaching/econ-101/week-3'. `tilde()` leaves `/Users/Shared` alone:
  the page cannot ask for the home folder (neither the shell nor the
  engine reports it), so a home is `/Users/<name>` or `/home/<name>`,
  and Shared is no one's.
- **Resting tools stay on the rail** (Plass's rule: they rest, disabled
  and dim). Source and grid views, and so every plain file, rest the
  cell and run tiles and the session panel's — `aria-disabled`, at 40 %
  (the old bar's resting ink), no hover, no lit tile, no caption, a click
  does nothing — rather than hiding them. A script without `# %%` cells
  rests the view switch too, since there is no other view to go to. The
  rail reads as the rail in every view; a plain file's was an empty
  48 px strip.
- **The view switch has its own glyph**, a page of lines (the file as
  its text), so the rail's foot no longer repeats the Code cell's `<>`
  at its top.
- **Main's floor.** `#doc`'s min-width is main's 640 px less what the
  frame takes (the rail and the right edge): 584 then, 588 with the 44 px
  rail. With the panel shown the room fits a 990 px window again (the
  first draft needed 1046), so
  the default 1100 × 760 window survives one ⌘+ without the room
  scrolling sideways or the panel running past the room's edge; the
  column bottoms out at 548 px (544 with the 48 px rail) instead of 600.

## Running it

The shell that draws the bar is claerbout's main (the title-bar option,
adaadcb, after the 0.2.1 version bump; no tag yet). Knuth's
`node_modules/claerbout` is the tagged v0.2.0, which ignores the two new
keys, so run the shell from its checkout, on a spare port and config
folder (the installed Knuth uses 5187 and `~/Library/Application
Support/Knuth`):

    cd ~/Projects/knuth-wt-zen
    CLAERBOUT_APP=app/knuth.json KNUTH_PORT=5641 KNUTH_CONFIG_DIR=/tmp/knuth-zen \
      ~/Projects/claerbout/node_modules/.bin/electron ~/Projects/claerbout

The page is the committed build in `python/knuth/web/` (after an edit:
`npm run build:engine`). `npm run app` runs the pinned v0.2.0: the same
page under a native title bar, with no lights' room in the bar (the
`env()` fallbacks), which is also what Knuth.app from the deploy shows
until the shell is tagged and pinned.

## What moved where

**The bar** (`#toolbar`, the window's title bar in Knuth.app; a drag
region but for its controls), left to right, padded on the left by the
lights' room (`env(titlebar-area-x)`; none in a tab, the PWA or
fullscreen, where the File tile stands over the rail's column):

- **File** (`#file-tile`, new id) — a bare 36 px tile, the folder glyph,
  Plass's File. Its text menu (`#tb-menu-file`) drops 10 px below it on
  a click, left-aligned with it (never nearer than 8 px to the window's
  edge): New window, Open… ⌘O, Recent documents ›, Save ⌘S and, where
  they apply, Get Knuth for your Mac › (`#get-app`), Install Knuth
  (`#install-app`) and Check for updates… (`#update-app`) — the old
  buttons' ids, now on the items. The first draft's way, a hover flyout
  laid over its own trigger inside the name pod, would sit under the
  lights.
- **The name pill** (`#doc-pod`) — Plass's address pill, 42 px: the
  document's name (`#file-name`: click to rename), Plass's save dot
  (`#doc-mark`; the pod carries `doc-saved` or `doc-unsaved`) and, new,
  its folder (`#doc-folder`, a sibling so the name's text stays exact):
  the path's folder with home as `~` (the whole path in its title), or
  an attached folder's name in a tab, or nothing. Only the folder gives
  way when the bar is short, from its start; it is hidden under 760 px.
  The rail-layout mockup's path, in the pill.
- At the right (`.tb-end`): the **kernel's status** (`#kernel-status`),
  a pill that matches the name pill, its right edge on the room's. It
  holds its words and nothing else (the smoke compares `uv` / `Pyodide`
  exactly); a click opens the onboarding while the kernel is not ready.
  This is where the panes design's session pill will grow.

The rest of the bar is empty: drag region.

**The rail** (`nav#rail`, 48 px in the first drafts, 44 since the afternoon's
bar change below; not a drag region, since it scrolls),
top to bottom, in the old bar's groups under a hairline:

- *Cells* (`#cells-pod`): Code cell, Scratch cell, Text cell.
- *Run* (`#run-pod`): Run stale, Run all, Stop, Restart session.
- Pinned at the foot, as Zen pins its bottom icons and Plass its
  Document settings: **Session panel** (`#toggle-panel`), lit while the
  panel shows (`aria-pressed`), and below it the **view switch**
  (`#view-toggle`, ⌘⇧E), which was the floating pill at the window's top
  right: the same id and Cells / Grid / Source captions, its own glyph,
  lit in source view.

The captions are the longer words of the mockup ("Code cell", "Restart
session", "Session panel"), beside the tile; the titles, ids and handlers
are unchanged. When the window is short the two groups scroll as one,
with a fade at the cut (at the 360 px minimum the groups need 252 px of
the 219 there are); the foot never scrolls. A tile that cannot act in
the view rests (*The second pass*).

**The room** (`#layout`): under the bar and right of the rail, 8 px from
the window's right and bottom, rounded 12 px. The column starts 24 px
under its top edge (the bar no longer floats over the cells) and centres
in what the session panel leaves; the panel (`#panel`, untouched beyond
its padding) sits at the room's right. Below the layout floor — main's
window widths, 640 px for the document and 990 with the panel — the
room scrolls sideways, not the page, so the bar and the rail stay put.
The onboarding covers the room only, rounded as it is, so the status
that opens it and the rail stay usable; the toast sits on the room's
axis, 12 px above its bottom edge.

**Source and grid views** keep the frame. The room turns One Dark and
the editor (or the grid) runs edge to edge inside it; the rail's cell
and run tiles and the session panel's rest, the view switch lit; the bar
keeps File, the name and the status — under the hidden title bar it is
the only place the document's name shows. Before, these views hid the
bar and painted the whole window One Dark.

**Keyboard**: every shortcut is as it was (⌘S, ⌘O, ⌘⇧E, ⌘Z, ⌘↩, ⇧↩, ⌥↩,
⌘⇧↩, Esc then Y/S/M). Tab walks the bar, then the rail, resting tiles
included; a rail tile under the fade scrolls clear of it. The File
menu's keys are Plass's (*The second pass*).

**The shell** (`app/knuth.json`): `titleBarStyle: "hiddenInset"`, the
lights at `{x: 20, y: 23}` (a 60 px band, 2·23 + 14), and no
`followZoom`, on purpose (said in the config's `"//"` key, since JSON has
no comments): that is for a page laid out as a fixed-width paper
(Plass). Knuth's room is fluid — the column has a max-width and rewraps —
so a zoom step rewraps it inside the same window. The bar still follows
the lights' band under a zoom, through `env(titlebar-area-height)`.
**The setup page** gets the same bar from shell 0.2.1, so `setup.css`
gives it a drag strip the height of the band; its content is centred,
clear of the lights. From main, the config also sets `autosave: true`
and the smoke's autosave subjects (docs/AUTOSAVE.md).

## The colours and sizes, and why

All of them Plass's (`plass/src/style.css`, `toolbar.css`), so the two
apps are one system.

| | value | why |
|---|---|---|
| frame (`--frame`: body, bar, rail, edge) | **#18181a** | Zen's own frame measures #131313–#141414; Taylor found pure black too dark for the shadow. A step above reads as dark grey. Also `theme-color` and the manifest. |
| room (`--bg`) | **#2b2a2d** | Knuth's room as it always was, and the rail-layout mockup's. |
| name and status pills (`--pill`) | **#232326** | a shade up from the frame, with a white 8 % hairline, 12 px corners. |
| lit tile (`--tile`) | **#2e2e32** | Zen's lit square measures #2c2e2f. |
| room's rim | white 5 % hairline | the panel's edge against the frame. |
| menus and the frame's captions | rgba(27, 26, 30, .94), white 10 % hairline, blur 18 px | Plass's dark menu glass; the insert strips in the room keep their light glass. |
| save mark | green rgba(110, 165, 118, .9), red rgba(205, 100, 82, .95) | Plass's dot. |
| resting tile | 40 % | the old bar's resting ink (Plass's disabled tile is 25 %: open below). |

- **The rail: 48 px** = 32 px tiles + the frame's 8 px either side, so a
  tile is as far from the room as the window's edge is: one edge width
  everywhere. 18 px glyphs, 9 px tile radius, 3 px between tiles, 18 px
  hairlines. The first tile's top is level with the room's top edge, the
  view switch's bottom with its bottom edge.
- **The bar: 60 px** in a tab, the PWA and fullscreen; in Knuth.app the
  lights' band itself (`--topbar: env(titlebar-area-height, 60px)`). The
  pills are 42 px, so the frame shows 9 px under them. The File tile is
  36 px, 12 px past the lights' room; with none it is 6 px in, centred
  over the rail's tiles (the `env(titlebar-area-x, -6px)` fallback). The
  bar's right padding is 8 px (Plass's is 12) so the status pill's right
  edge lines up with the room's.
- **The room**: 8 px (`--edge`) from the window's right and bottom; the
  column 24 px under its top edge.
- **The column**: unchanged (52rem, 832 px, centred). The frame does take
  56 px of the window, so with the panel open the column reaches its full
  832 px from a window 1278 px wide (it was 1222); at 1100 it is 654 px
  (it was 710). At the floor (a 990 px window with the panel) it is
  544 px; the room scrolls sideways below that, as on main.

## Fixed in passing

**No blur in the built app** (Plass's bug, here too). The stylesheet
wrote `backdrop-filter` and then `-webkit-backdrop-filter`; the build's
minifier reads the pair as one property and keeps the last, so the
committed build held only the prefixed line (8 of 8), which Chromium does
not read: Knuth.app drew no blur under the toast, the menus, the
onboarding or the captions. The `-webkit-` lines are gone; the minifier
adds the prefix itself, so the build has both in each glass rule (the
File menu's included).

Also: renaming no longer loses its input if the document's state changes
while the name is being typed (an autosave landing, say): the repaint
leaves an open rename alone.

## Checks

On the merge (ux/zen with main's autosave record), all green:

- `npm test`: green. `npm run build:engine`, `npm run check:web`: green
  ("committed app matches its sources").
- `npm run test:browser`: 68 passed. `tests/browser/frame.spec.ts` checks
  the colours, the rounded room, the 8 px edge, the 48 px rail and 32 px
  tiles, the bar a drag region with its controls and the menus the
  page's, every id in its place (Get, Install and Update in the File
  menu), the column 832 px and centred with the panel shown and hidden,
  the panel tile's lit state, the File menu (under the tile, Plass's
  glass and width, its items and shortcuts, the rule hidden when none of
  the three applies, the keys, Recent in its place and back, the focus
  back to the cell on Escape, New window opening the page), renaming in
  the pill, the save mark's two colours and the unsaved new document, a
  110-character folder at 1100 and 780 px (the name whole, the mark in
  the pill, the folder cut at its head), `/Users/Shared` not shortened,
  source view keeping the frame with the tools resting at 40 % and a
  resting click doing nothing, a plain script's whole resting rail with
  two different glyphs top and foot, the onboarding over the room only,
  the toast on the room's axis, the fade at 360 px with the foot whole,
  sideways scrolling in the room alone, and the floor at 990 / 640 px.
  The app, grid and environment specs expect resting tiles and the
  mark's classes.
- `node ~/Projects/claerbout/smoke.mjs --config app/knuth.json browser`
  and `uv`: ok, with the autosave record's subjects ("knuth: session
  open", "knuth: cell run [1]"). The pinned v0.2.0's own smoke (`node
  node_modules/claerbout/smoke.mjs … browser`): ok, under the native
  title bar.
- In the checkout shell, through Playwright's `_electron` (the record's
  run): the overlay at x 100; the File tile at 112 and its menu at 112,
  58 px down (the tile's bottom, 48, plus 10); the menu holds New
  window, Open…, Recent documents, Save and Check for updates…, no Get
  or Install; Check for updates… answers "Running from a checkout:
  nothing to update"; the pill reads "wages.py", green, "~/Projects/
  week-3"; ⌘⇧E rests the eight cell tiles and leaves the switch awake.
- The hosted demo (the build served at a non-loopback hostname): File
  adds Get Knuth for your Mac ›, whose submenu has the download, the
  install line and the pip line; no manifest; ArrowLeft goes back to
  File on the Get item.

The first draft's measurements still hold (the bar 55 and 50 px at one
and two zoom steps with the window unchanged; fullscreen: no overlay,
the bar 60, the File tile 6 px in; the setup window's 60 px drag strip).

## What is still open

1. **Source and grid views keep the frame** (above), the reviewers
   agreeing ("the One Dark room inside the grey frame looks
   deliberate"). It was forced by the hidden title bar: with no bar the
   name would show nowhere, nothing would drag the window, and the
   lights would sit over the code. Keep it?
2. **The resting tiles: 40 % or Plass's 25 %, `aria-disabled` or
   `disabled`.** Knuth rests at the old bar's 40 % and keeps the tiles in
   the Tab order; Plass's are disabled at 25 % and Tab skips them. One
   should move so the two rails rest alike.
3. **The view switch's glyph.** Knuth's is now a page of lines; Plass's
   at the same spot (Plain text / Paper) is `<>`. The reviewers' other
   way: `<>` on both apps' switch, and a new code-cell glyph for the
   Code cell tile and the insert strips in the room.
4. **The hosted demo's way to the app** is File → Get Knuth for your Mac
   now, as Plass's Get Plass is; in the first draft it was a tile in the
   bar, a click from the front page. If the demo wants a visible door, a
   tile left of the status is one rule.
5. **An update the shell finds by itself** only relabels File's item
   to Install update (Plass's behaviour); the first draft's Update
   button announced it in the bar. If that is too quiet, both apps could
   toast once.
6. **The menu's focus goes back to the cell** when it closes; Plass's
   goes to the File tile. Knuth's way keeps typing where it was and keeps
   Escape from reaching the cell; Plass could take it.
7. **The folder in the name pill**: `~/…` for a document with a path, an
   attached folder's name in a tab; hidden under 760 px. At 1500 px the
   bar is otherwise empty between the pill and the status: should the
   pill stretch? If it does, its empty part (or the folder) must become a
   drag region, or the bar loses most of what moves the window.
8. **The column's inset**: the cards sit 16 px from the room's left edge
   and 24 px under its top; Plass keeps 24 all round. Optical only, and
   24 would take 8 px from the column.
9. **The onboarding card's 560 px minimum** now overflows the room below
   a window of about 664 px (before the frame, 608): the card scrolls
   sideways inside the overlay, its × off-screen at 520 px until
   scrolled. It was so before; the threshold moved.
10. **The session panel** stays where it was, inside the room at its
    right, with its toggle on the rail's foot. The panes branch replaces
    it and will likely move the toggle beside the status pill, which this
    draft already seats where the session pill goes: expect conflicts in
    `main.ts`'s templates, the `#panel` rules and the rail's foot.
11. **The shell**: the bar beside the lights needs claerbout tagged
    v0.2.1 (main has the option since adaadcb; it also carries the
    autosave record main now asks for) and the three apps bumped the same
    day; until then Knuth.app has a native title bar above the page's
    bar, which the `env()` fallbacks keep right. Landing the config keys
    early is safe: v0.2.0 ignores them and its smoke has no overlay check.
12. **A shared smoke step for the bar under zoom**: Plass checks it in
    its own `app/smoke.mjs`; here it was a one-off `_electron` run. A
    claerbout key (say `smoke.bar: "#toolbar"`) would let both apps run
    the same check.
13. **The `"//"` key in `app/knuth.json`**: the shell reads named keys
    only, so it is inert; it could live in `docs/APP.md` instead.
14. **The setup page** keeps its room grey (#2b2a2c) edge to edge; the
    frame colour there would be one line.
15. **The record's screenshots** are page captures without the lights
    (above).
16. Plass's open questions about the frame (its shade, the rail at 48 vs
    44) apply here too, and an answer there should move both.

## The bar's height, 2026-10-02 afternoon

Taylor, running the merged apps: the bars "seem taller than they were
originally", and the height they liked is the panes mockup's, "equal in
height to the width of the sidebar" (`session-panes-v2-peek-v2.html`: a
40 px bar over a 44 px rail, 28 px pills, 32 px tiles). Both bars had
been 60 px, the old toolbar's height, which as a solid dark band without a
title bar above it read heavier than the old glass did. Now: the bar is
44 px, the rail's width (a 32 px tile with 6 px either side; the room's
edge stays 8 px), the pills 30 px with 9 px corners, the bar's tiles
32 px, and the traffic lights at {x: 14, y: 15} so their band is the bar
(2·15 + 14 = 44). Plass takes the same numbers.
