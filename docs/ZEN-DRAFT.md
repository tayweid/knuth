# The Zen draft

Knuth in Zen's shape, on the branch `ux/zen`, the first draft
(2026-10-02): the same frame Plass has had on its main since this
morning (Plass's `docs/ZEN-DRAFT.md`, merge c5ed545), so the two apps read
as one system. A dark grey frame — the bar across the top beside the
traffic lights, a narrow rail of tools down the left, one 8 px edge round
the rest — holds the room, a rounded graphite panel where the document
sits. The document column itself is untouched ("the cell vertical column
is basically perfect"): it keeps its 52rem measure and centres in the
room. Taylor's own drafts of the shape are `docs/mockups/rail-layout.html`
and this morning's `docs/mockups/session-panes-v2-recommended.html`.

The record is `docs/zen-draft-1100.png` and `docs/zen-draft-1500.png`:
the shell from the checkout on `app/knuth.json`, at 1100 and 1500 px
wide, after a run on uv. They are page captures, so the traffic lights —
the window's own, drawn over the page — are not in them: their room is
the empty 100 px left of the File tile. (`screencapture` of the window
needs a screen-recording grant this session does not have; Plass's record
has the same gap.)

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
  Plass's File. Its row — New (a new window), Open… ⌘O, Recent ("Your
  documents") — drops 8 px below it on a click, in Plass's dark menu
  glass. It was a hover flyout laid over its own trigger inside the name
  pod; at the bar's left edge that would sit under the lights. It closes
  on an item, a click elsewhere, Escape (from inside it the focus goes
  back to the tile) or the focus leaving it; from the keyboard Enter,
  Space or ArrowDown opens it and the arrows walk the row. Recent's list
  opens under the tile.
- **The name pill** (`#doc-pod`) — Plass's address pill, 42 px: the
  document's name (`#file-name`: click to rename, the amber ● when
  unsaved, both unchanged) and, new, its folder (`#doc-folder`, a sibling
  so the name's text stays exact): the path's folder with home as `~` (the
  whole path in its title), or an attached folder's name in a tab, or
  nothing. The folder gives way first when the bar is short and is hidden
  under 760 px. The rail-layout mockup's path, in the pill.
- At the right (`.tb-end`): **Install** (the PWA, only when the browser
  offers it: a locally served tab), **Update** (Knuth.app, only when a
  newer build is out), **Get Knuth** (a bare tile with its caption, the
  hosted demo only; its menu drops below, right-aligned, now in the same
  dark glass) and the **kernel's status** (`#kernel-status`), a pill that
  matches the name pill, its right edge on the room's. It holds its
  words and nothing else (the smoke compares `uv` / `Pyodide` exactly);
  a click opens the onboarding while the kernel is not ready. This is
  where the panes design's session pill will grow.

The rest of the bar is empty: drag region.

**The rail** (`nav#rail`, 48 px; not a drag region, since it scrolls),
top to bottom, in the old bar's groups under a hairline:

- *Cells* (`#cells-pod`): Code cell, Scratch cell, Text cell.
- *Run* (`#run-pod`): Run stale, Run all, Stop, Restart session.
- Pinned at the foot, as Zen pins its bottom icons and Plass its
  Document settings: **Session panel** (`#toggle-panel`), lit while the
  panel shows (`aria-pressed`), and below it the **view switch**
  (`#view-toggle`, ⌘⇧E), which was the floating pill at the window's top
  right: the same id, glyph and Cells / Grid / Source captions, lit in
  source view.

The captions are the longer words of the mockup ("Code cell", "Restart
session", "Session panel"), beside the tile; the titles, ids and handlers
are unchanged. When the window is short the two groups scroll as one,
with a fade at the cut (at the 360 px minimum the groups need 252 px of
the 219 there are); the foot never scrolls.

**The room** (`#layout`): under the bar and right of the rail, 8 px from
the window's right and bottom, rounded 12 px. The column starts 24 px
under its top edge (the bar no longer floats over the cells) and centres
in what the session panel leaves; the panel (`#panel`, untouched beyond
its padding) sits at the room's right. Below the layout floor (640 px for
the document, 350 more with the panel) the room scrolls sideways, not the
page, so the bar and the rail stay put. The onboarding covers the room
only, rounded as it is, so the status that opens it and the rail stay
usable; the toast sits on the room's axis, 12 px above its bottom edge.

**Source and grid views** keep the frame. The room turns One Dark and
the editor (or the grid) runs edge to edge inside it; the rail keeps only
the view switch; the bar keeps the name, File, the I/O and the status —
under the hidden title bar it is the only place the document's name
shows. Before, these views hid the bar and painted the whole window One
Dark.

**Keyboard**: every shortcut is as it was (⌘S, ⌘O, ⌘⇧E, ⌘Z, ⌘↩, ⇧↩, ⌥↩,
⌘⇧↩, Esc then Y/S/M). Tab walks the bar, then the rail; a rail tile under
the fade scrolls clear of it.

**The shell** (`app/knuth.json`): `titleBarStyle: "hiddenInset"`, the
lights at `{x: 20, y: 23}` (a 60 px band, 2·23 + 14), and no
`followZoom`, on purpose (said in the config's `"//"` key, since JSON has
no comments): that is for a page laid out as a fixed-width paper
(Plass). Knuth's room is fluid — the column has a max-width and rewraps —
so a zoom step rewraps it inside the same window. The bar still follows
the lights' band under a zoom, through `env(titlebar-area-height)`.
**The setup page** gets the same bar from shell 0.2.1, so `setup.css`
gives it a drag strip the height of the band; its content is centred,
clear of the lights.

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
  (it was 710).

## Fixed in passing

**No blur in the built app** (Plass's bug, here too). The stylesheet
wrote `backdrop-filter` and then `-webkit-backdrop-filter`; the build's
minifier reads the pair as one property and keeps the last, so the
committed build held only the prefixed line (8 of 8), which Chromium does
not read: Knuth.app drew no blur under the toast, the menus, the
onboarding or the captions. The `-webkit-` lines are gone; the minifier
adds the prefix itself, so the build now has both in each of its six
glass rules. Measured in the shell: the File drop's `backdrop-filter` is
`blur(18px) saturate(1.4)`.

Also: the Get menu's tile no longer reopens the menu when clicked to
close it, and Escape closes Recent and Get.

## Checks

- `npm test`: green. `npm run build:engine`, `npm run check:web`: green.
- `npx playwright test`: 62 passed (51 before; three specs updated for
  source and grid views keeping the bar and for the File tile, and
  `tests/browser/frame.spec.ts` new: the colours, the rounded room, the
  8 px edge, the 48 px rail and 32 px tiles, the bar a drag region with
  its controls the page's, the File tile over the rail's column in a tab,
  every id in its place, the column 832 px and centred with the panel
  shown and hidden, the panel tile's lit state, the File drop's
  behaviour, renaming in the pill, source view keeping the frame, the
  onboarding over the room only with the status still clickable, the
  toast on the room's axis, the fade at 360 px with the foot whole, and
  sideways scrolling in the room alone).
- The hosted-demo case, at the machine's LAN address (not loopback):
  Pyodide, Get Knuth shown, no manifest, Install never offered.
- `node ~/Projects/claerbout/smoke.mjs --config app/knuth.json browser`
  and `uv`: ok (the checkout shell, so with the overlay check: visible,
  x 100, height 60). The pinned v0.2.0's own smoke (`node
  node_modules/claerbout/smoke.mjs … browser`): ok, under the native
  title bar.
- In the checkout shell, measured with Playwright's `_electron`: the
  overlay at x 100, 60 tall; the bar 0–60, the File tile at 112, the
  status pill's right edge and the room's both at 1092 (1100 wide), the
  rail 0–48, the first tile at {8, 60}, the room {48, 60, 1092, 752}, the
  view switch's bottom at 752. View → Zoom In once: the band 55 px and
  the bar 55, twice: 50 and 50, the window still 1500 × 900; fullscreen:
  no overlay, the bar 60, the File tile 6 px in. The setup window: a
  60 px drag strip, the content from 67 px down.

## What is still open

1. **Source and grid views keep the frame** (above). That was a design
   change forced by the hidden title bar: with no bar the name would show
   nowhere, nothing would drag the window, and the lights would sit over
   the code. The alternative is an empty drag strip in those views only —
   a second code path. Keep the frame?
2. **A plain file's rail is empty**: a markerless script offers no cell
   view, so even the switch is hidden, and the rail is 48 px of frame
   with nothing on it. Kept for one shape; collapsing it to the 8 px edge
   in that case is one rule.
3. **File opens on a click, not a hover** (Plass's File). Fine?
4. **The folder in the name pill**: `~/…` for a document with a path, an
   attached folder's name in a tab; hidden under 760 px. At 1500 px the
   bar is otherwise empty between the pill and the status: should the
   pill stretch?
5. **Recent and Get in the dark glass**, with Get's download button
   turned light. One system with Plass; the old light menus are a revert
   of two rules.
6. **The session panel** stays where it was, inside the room at its
   right, with its toggle on the rail's foot. The panes branch replaces
   it and will likely move the toggle beside the status pill, which this
   draft already seats where the session pill goes: expect conflicts in
   `main.ts`'s templates, the `#panel` rules and the rail's foot.
7. **The shell**: the bar beside the lights needs claerbout tagged
   v0.2.1 (main has the option since adaadcb) and the three apps bumped
   the same day; until then Knuth.app has a native title bar above the
   page's bar, which the `env()` fallbacks keep right. Landing the config
   keys early is safe: v0.2.0 ignores them and its smoke has no overlay
   check.
8. **A shared smoke step for the bar under zoom**: Plass checks it in its
   own `app/smoke.mjs`; here it was a one-off `_electron` run (above). A
   claerbout key (say `smoke.bar: "#toolbar"`) would let both apps run
   the same check.
9. **The `"//"` key in `app/knuth.json`**: the shell reads named keys
   only, so it is inert; it could live in `docs/APP.md` instead.
10. **The setup page** keeps its room grey (#2b2a2c) edge to edge; the
    frame colour there would be one line.
11. **The record's screenshots** are page captures without the lights
    (above).
12. Plass's open questions about the frame (its shade, the rail at 48 vs
    44) apply here too, and an answer there should move both.
