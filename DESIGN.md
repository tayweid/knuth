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
in PLAN.md/SPEC.md where they conflict: the Tauri-era pyrmd tried to be the
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
- **Text cells** — markdown narration between code. Nice-to-have: reuse
  Plass's line-breaker/measurement port (extract `src/layout/port` into a
  shared package) for good text; take none of Plass's paragraph/page
  machinery.

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
    each run. Unnamed figures display but do not persist ("if it's given a
    name, it's saved as that name").
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

## File format: `.py`, percent format, outputs inside

- The document is a plain `.py` file in the **percent format** — `# %%`
  cell delimiters, `# %% [markdown]` text cells with `# `-prefixed prose —
  the convention jupytext/VS Code/Spyder/PyCharm already speak, so pyrmd
  files open as cell documents everywhere, and `python file.py` runs as-is.
- Scratch cells: `# %% scratch` — DECIDED: the exact token `scratch`
  after the marker; any other suffix (titles, `tags=[...]`) stays a
  program cell, so jupytext-written files parse unchanged.
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
- Kernel pluggable: **Pyodide in a Web Worker** by default (real CPython in
  WASM; numpy/pandas/matplotlib/scipy as prebuilt wheels;
  `pyodide.mountNativeFS()` mounts the project-folder handle so
  `pd.read_csv('data.csv')` reads the real file; interrupt buffer for
  Stop). **Local sidecar** (the existing pymd-server lineage) over
  localhost WebSocket for native-scale work — WASM caps at ~2–4GB memory
  and can't install compiled packages outside Pyodide's build set.

## Open questions

1. Tables in the contract — dataframe → csv that Plass could import/
   reference, or manual? Parked (follows from "no .typ emission").
2. Scratch cells under bare `python file.py` — they execute (they're real
   code) and may error against ephemeral state. Does plain-python parity
   matter enough to guard, or is `pyrmd run` the canonical runner?
3. DECIDED — see "File format": scratch tag is the exact token
   `# %% scratch`; outputs are trailing `#-> ` comment runs, no
   delimiters.
4. Scratch namespace v1: separate ChainMap-style namespace from day one,
   or shared namespace + never-persists rule first?
5. When the DAG lands: staleness precision only, or opt-in reactive
   auto-rerun per cell?
6. How much of Plass's layout port is worth sharing for text cells vs
   plain CSS text.
