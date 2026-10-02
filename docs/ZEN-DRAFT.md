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
