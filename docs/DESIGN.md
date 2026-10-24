# Knuth — the workbench (formerly pyrmd)

## Naming (decided)

- **The suite is Claerbout** — for Jon Claerbout, who coined reproducible
  research: the article is advertising; the scholarship is the complete
  environment that regenerates it. Only the suite can make that promise,
  so the suite carries his name. (Never clipped — "Claerbout" whole.)
- **This app is Knuth** (pyrmd retires as a name) — literate programming
  is his invention, and the .py-as-prose+code+outputs format below is WEB
  reborn with a live session. Computation-first, built documents so the
  computation could be published right.
- **The typesetter stays Plass** — line breaking with Knuth (1981),
  thesis on optimal pagination, fonts at PARC. The document man.
- The pair inside the suite: advisor and student, computation and page,
  co-authors again — the folder contract is the collaboration.

Design notes from a working session (2026-08-12). Supersedes the direction
in the v1 PLAN.md/SPEC.md (at the `v1-tauri` tag) where they conflict: the Tauri-era pyrmd tried to be the
whole workflow in one app; this design splits the workflow across two apps
and makes pyrmd the computation half.

## The two-app world

- **Plass** owns the paper: typeset prose that *references* results and
  computes nothing.
- **pyrmd** owns the computation: an exploration engine and a
  reproducibility program. The prose-first ambition of pyrmd v1 moved to
  Plass; pyrmd's text cells are lab-notebook narration, not paper prose.
- **The contract between them is files in the project folder**, in formats
  Typst reads natively — no pyrmd-specific or Plass-specific glue:
  - `values.json` — Plass's live-value node is sugar over
    `#json("values.json").name`; a stock `typst compile` picks up fresh
    values with no Plass in the loop.
  - `figs/<name>.svg` — referenced by relative path (Plass already polls
    referenced figures for changes).
  - DECIDED: pyrmd does NOT emit `.typ` fragments. Code does its thing,
    Typst does its thing; the contract stays plain data so any consumer
    works. (Tables are the open casualty of this — see Open questions.)
- Jupyter's remaining role: kernel ecosystem occasionally needed. The
  RStudio quality students point at — see outputs, see variables — is an
  architecture, not a feature: **the session is separate from the
  document**, with panes looking into the session. pyrmd adopts that
  architecture.

## Document model: three cell kinds

- **Program cells** — the reproducibility program. Run top-to-bottom in a
  clean session; the only cells that write shared state and persist
  artifacts.
- **Scratch cells** — exploration. Own namespace with one-way visibility:
  reads fall through to the session namespace when a name isn't defined
  locally; writes stay local. Never persist, never export; deletable
  without consequence. Replaces the console — scratch work lives in
  context, next to what it probes. Known leak, accepted: reads are by
  reference, so in-place mutation of a shared object does touch program
  state ("scratch can look; mutation is on you"). Secondary feature — v1
  may run scratch in the shared namespace with only the never-persists
  rule enforced.
  - The discipline rule that kills hidden state: program cells must not
    depend on names defined only in scratch. (With one-way namespaces this
    is structural; enforce/warn explicitly if v1 shares the namespace.)
- **Text cells** — markdown narration between code. DECIDED 2026-08-23:
  always-editable WYSIWYG via ProseMirror, built from Plass's prose
  machinery trimmed into `src/prose/` (schema, md round-trip with the
  math sentinel, input rules, KaTeX-only math views — each file headers
  its provenance; the Typst oracle and paragraph/page machinery stayed
  home, as originally decided). The file stores plain markdown prose;
  the PM view serializes only on real doc changes, so the round-trip is
  byte-stable (pinned by the md-round suite, both display-math forms).
  Vendored copies may drift from Plass; extract a shared package only
  if that ever hurts. The line-breaker port for justified prose remains
  the horizon nice-to-have.
  On the page (2026-10-21, Taylor: "no space between them, it should
  look like one cell, but there should still be a create cell button
  between them"; "a bar on the left instead of above and below"): text
  cells one after another read as one text, a paragraph's break (0.6em,
  11 px) between them with the inserter in it, a heading that starts one
  keeping its space above, by CSS `:has()` selectors alone, so inserts,
  deletes, moves and kind changes join and part them with no
  bookkeeping. Which cell is which shows as a 3 px bar down the cell's
  left side: grey under the pointer, blue with a soft glow inside it, and
  with a faint wash over the cell in command mode in place of the code
  cells' ring. The old 28 px ticks above and below are gone.
- **Moving cells** (2026-10-21, Taylor: "knuth needs a drag and drop for
  rearanging cells … make it look pretty"). Every cell but cell zero has
  a grip, six dots in the margin left of its row, shown under the
  pointer. Dragged by it (pointer events, not HTML drag and drop, so no
  browser ghost image), the cell fades where it is, a small label of it
  (its kind and first line) rides with the pointer, a blue line with
  round ends marks the gap it will land in, and the doc scrolls when the
  pointer nears its top or bottom. Letting go moves it (`moveCell`): the
  editors move with their DOM, undo histories kept; the blank separator
  lines are kept right; a moved code cell stales every code cell from
  the higher of where it left and where it landed, as an edit there
  would, and a text or scratch cell's move stales nothing; the cell
  glows a moment where it landed, and ⌘Z puts it back. Esc, or letting
  go over its own place, leaves it.
- **Export to Markdown for Plass** (2026-10-21, Taylor: "a knuth export
  to markdown or pdf to create a plass like document, but without the
  code being visible … r studio has something like this with
  rmarkdown"). The bar's Export tile (Plass's download glyph) writes the
  document as a reader sees it, in the Pandoc Markdown Plass opens
  (plass/docs/MARKDOWN-FORMAT.md), so Plass makes the PDF: the text cells
  as written, a first `# Title` as the front matter's title, each code
  cell's figures embedded as SVG data URLs (one file, nothing to grant or
  keep beside it), and a code cell that ends by showing a table by name
  as a pipe table of its first 30 rows from the session; no code, no
  printed output, no scratch cells, no cell zero (export.ts). It is
  written beside the document as `<name>.md`, as knit writes beside the
  .Rmd, by whichever way the document is written (the engine by path, the
  granted folder; a download with neither: FileManager.writeBeside), and
  never over a file that is there unless the toast's Replace says so,
  since the export is meant to be edited on in Plass. Checked by opening
  an export in Plass and making its PDF.
- **Figures are cropped to what they draw** (2026-10-21): every figure's
  SVG (under a cell, a named figure, figs/<name>.svg, an export) is saved
  with `bbox_inches="tight"`, as Jupyter's inline figures are, so an axis
  label or title matplotlib lays outside the figure's own box — a short
  figure's x label above all — is kept rather than cut off at the edge
  (`_figure_svg`, session.py; both engines run it). The export check
  found the clipped label.
- **A figure's file changes only when its drawing does** (2026-10-24).
  A dissertation chapter ported to Knuth showed all seven of its figs/
  files as changed after a rerun that drew nothing new: matplotlib writes
  the time into every SVG (`<dc:date>`) and hashes its ids (clip paths,
  markers, hatches, images) with a new random salt per render. `_figure_svg` saves with no
  date and one fixed salt (`FIGURE_SALT`, never to change), so an id is a
  hash of what it names and a rerun leaves an unchanged figure's file
  byte-identical, as receipts are with their addresses stripped. One
  salt for every figure is safe because each is its own document
  wherever it is shown (an image under a cell, a file in Plass's PDF), so
  ids never meet across figures. A gap left to matplotlib: before 3.10 it
  hashes a non-rectangular clip (a polar plot's, a custom clip path) with
  the clip path's memory address, so such figures still change on every
  run with an older matplotlib, Pyodide's 3.8.4 included.

## Execution model

- **v1: linear, no DAG.** Program cells run in document order. Editing a
  cell marks all cells below it stale (badge + one-click "run stale").
  Honest without dependency analysis.
- **Later: cell-level DAG** as an upgrade to staleness precision (ast-based
  def/use analysis), possibly with opt-in reactive auto-rerun. Changes
  nothing about the file format or document model, so deferring is free.
- **`pyrmd run file.py`** — the reproducibility check and the artifact
  producer: fresh session, program cells only, top to bottom, regenerates
  all persisted artifacts. The full pipeline is
  `pyrmd run analysis.py && typst compile paper.typ`.

## Session and auto-persistence

- The variable explorer and data viewer are views onto the live session
  namespace (names, types, dataframe shapes; click a dataframe for a real
  table view).
- **No export markers.** Named things persist automatically:
  - Top-level assignment in a program cell → shared state.
  - `_underscore` names are private: session-only, never persisted (the
    one convention that keeps values.json from filling with loop temps).
  - Scalars / small serializables (int, float, str, bool, small
    lists/dicts) → mirrored to `values.json`.
  - A figure object assigned to a name → `figs/<name>.svg`, rewritten on
    each run (byte-identical while the drawing is unchanged). Unnamed
    figures display but do not persist ("if it's given a name, it's saved
    as that name").
  - DataFrames: session-only (viewer material; too big for the contract).
  - `values.json` is REGENERATED on each clean run, never appended — it
    mirrors the program namespace exactly; deleted variables disappear.
- DECIDED (M4): the kernel *produces* artifacts; the app *materializes*
  them. The browser can never hand the sidecar a real path (File System
  Access API exposes no paths), so contract writes go through the app's
  project-folder directory handle — an architecture that also works
  unchanged for a Pyodide backend. Consequence: the kernel's cwd is not
  the project folder in sidecar mode; relative data reads are an open
  problem (see PLAN.md Later).

## Other files: text, and delimited grids

- Any text file opens (`src/plain-file.ts` names the set, which the
  manifest's `file_handlers` and the Mac app's document types repeat); a
  non-`.py` file is pinned to the plain source editor, never the cell
  workbench, even when its text happens to contain `# %%` lines. Files
  the editor has a grammar for get highlighting, fold arrows, and indent
  guides: markdown (`.md`, `.qmd`, `.rmd`) read the Quarto way, a YAML
  front matter over prose with `{python}`/`{yaml}` fences highlighted in
  their own language; YAML; and everything in CodeMirror's catalog
  (`@codemirror/language-data`: Rust, Go, C, JavaScript, TypeScript, R,
  Julia, shell, SQL, … about 140), each grammar a chunk of its own,
  fetched the first time a file needs it. A plain file is indented the
  way it already is (tabs, four spaces or two). The rest are numbered,
  wrapped text.
- DECIDED (2026-10-16): **Knuth is an editor for any code, the way
  Sublime is.** The Mac app claims every name on that list (APP.md's
  alternate-handler rule holds: it appears in Open With and is made the
  default only by the user, in Finder's Get Info › Open with › Change
  All…).
- DECIDED (2026-09-08): a `.csv`/`.tsv` opens as a **grid** of its cells,
  each editable in place, with the source editor a toggle away (the same
  ⌘⇧E / corner pill that flips `.py` files between cells and source).
  A viewer with a pen, not a spreadsheet: no formulas, sorting, resizing,
  or column operations, and no header row — every row is a row. Rows come
  from Enter past the last one and go by Backspace on an empty one; that
  is all the structure it edits.
- The unit of editing is the **line** (`src/format/csv.ts`): a cell edit
  rebuilds the one row it belongs to from that row's own raw fields, so
  a one-cell change is a one-line diff and the file's conventions —
  quoting style, CRLF, a BOM — survive untouched everywhere else. A
  changed field is quoted only when it must be (delimiter, quote, or
  newline inside) or when it was quoted before. Large files stay in the
  grid, showing 1,000 rows per page with Previous/Next controls. Keyboard
  navigation crosses pages, and the source toggle remains available.
- Grid undo/redo (⌘Z / ⇧⌘Z, or Ctrl on other platforms) stores exact
  changed lines for cell edits and row additions/deletions. An active
  cell edit is one undo step. History survives paging and view toggles;
  raw source edits, opening another document, or reloading clear it.
- DECIDED (2026-10-16): an **Excel workbook** (`.xlsx`, `.xlsm`) opens
  as a **read-only grid**, one sheet at a time, its other sheets as tabs
  under the table. The engine reads it (`python/knuth/workbook.py`,
  openpyxl, an engine requirement) and hands the page the sheet as CSV
  text under the workbook's own path, so it is the same grid a `.csv`
  opens in, without the pen: nothing types, and there is no source view
  (that text is Knuth's reading of the workbook, not a source). Knuth
  never writes a workbook — the page never marks one dirty, and the
  engine refuses to save over one. ⌘S (File › Save as CSV…) writes the
  sheet on screen as a CSV where the save panel says, and that CSV is
  the document from then on. A cell shows what Excel last computed (a
  formula's cached result), the value rather than its number format
  (0.5, not 50%), dates as ISO, and TRUE/FALSE; hidden sheets are left
  out. A sheet larger than 8 MB as text arrives cut short and says so,
  and is not saved from the grid. Excel files go through the engine
  alone: Python in the window (Pyodide) cannot open one, since the shell
  reads files as text. The old binary `.xls` is not read.

## File format: `.py`, percent format, outputs inside

- The document is a plain `.py` file in the **percent format** — `# %%`
  cell delimiters, `# %% [markdown]` text cells with `# `-prefixed prose —
  the convention jupytext/VS Code/Spyder/PyCharm already speak, so pyrmd
  files open as cell documents everywhere, and `python file.py` runs as-is.
- Scratch cells: `# %% scratch` — DECIDED: the exact token `scratch`
  after the marker; any other suffix (titles, `tags=[...]`) stays a
  program cell, so jupytext-written files parse unchanged.
  - DECIDED (2026-08-21, prefix amended 2026-08-23): scratch **bodies
    are stored commented out**, so bare `python file.py` never executes
    scratch — the whole file's plain-python behavior is exactly its
    program cells. The prefix is **`#| `** (the Quarto/nbdev
    executable-comment convention), not the `# ` + escape scheme first
    sketched: `#|` can never match the cell marker, so encoding is
    lossless with no escapes at all, where `# `-prefixing collides
    (`'%%x'` and `'# %%x'` both escape to `# # %%x`, and code CAN start
    with `%%` inside multi-line strings). The app uncomments for display
    and editing; `#-> ` receipts stay as-is; decode passes unprefixed
    lines through, so legacy bare-code scratch parses fine and
    `knuth run` canonicalizes it the way it canonicalizes CRLF.
- **Outputs are stored inside the `.py`** as machine-managed comment blocks
  under their cell (text reprs, stdout). Figures are NOT embedded — they
  already live as `figs/<name>.svg` via auto-persistence, so the output
  block references the path. Everything stays diffable plain text, and git
  diffs show results changing alongside code — reproducibility receipts in
  the history.
- DECIDED (output syntax): every output line is a comment prefixed
  `#-> ` (bare `#->` for blanks); the block is the trailing run of such
  lines in its cell. No start/end delimiters — self-delimiting, so
  nothing can collide with `# %%` scanners, and results diff line by
  line. `#->` lines are machine-owned: rewritten or removed on each run.
  Memory addresses in reprs are normalized to `0x…` before storing —
  receipts must be byte-stable across identical runs, and
  `<object at 0x104f2b3d0>` churn would poison every diff.
- DECIDED (2026-08-19): line endings. The parsers read a document's bytes
  as-is — a CRLF file has cells in both implementations, pinned by the
  corpus — but everything Knuth writes is LF. `knuth run` canonicalizes a
  CRLF file wholesale to LF the first time it rewrites receipts, rather
  than maintaining CRLF forever alongside LF receipt lines: one
  line-ending diff on the first run, byte-stable ever after.
- Complex outputs follow one rule: the output block stores the *text
  face* of a result — what a terminal would show. DataFrames appear as
  pandas' own truncated text repr (full data lives in the session,
  viewed in the data pane, never in the file); figures appear as their
  `figs/<name>.svg` path reference; long stdout gets capped at 40 stored
  lines, ending with a `… (+N more lines)` marker (decided, M3). Paper-grade
  artifacts always travel through the folder contract, never through
  output blocks.

## Platform

- Web app like Plass (the Tauri shell is what made v1 slow to develop; the
  editor stack was always web tech). Vite + HMR development cycle.
- Kernel pluggable behind one small interface. DECIDED (2026-08-13, see
  KERNEL.md): **local sidecar** — real CPython over a localhost WebSocket,
  one engine shared by the app and `knuth run`. Pyodide (CPython in WASM,
  zero-install) stays buildable later behind the same interface as a
  teaching mode; its memory ceiling, package wall, and second-engine cost
  are the tradeoff record in KERNEL.md. This paragraph originally recorded
  the opposite default and was corrected after the decision.

## Open questions

1. Tables in the contract — dataframe → csv that Plass could import/
   reference, or manual? Parked (follows from "no .typ emission").
2. DECIDED (2026-08-21) — see "File format": scratch bodies are stored
   commented out, so they are inert under bare `python file.py`.
   Implementation is on the roadmap.
3. DECIDED — see "File format": scratch tag is the exact token
   `# %% scratch`; outputs are trailing `#-> ` comment runs, no
   delimiters.
4. Scratch namespace v1: separate ChainMap-style namespace from day one,
   or shared namespace + never-persists rule first?
5. When the DAG lands: staleness precision only, or opt-in reactive
   auto-rerun per cell?
6. How much of Plass's layout port is worth sharing for text cells vs
   plain CSS text.
