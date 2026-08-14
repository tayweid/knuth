# Knuth v2 — Development Plan

The design is in [DESIGN.md](./DESIGN.md); this is the build order. The v1
Tauri app is retired on the `v1-tauri` branch (its docs in `archive/v1/`);
the only v1 asset carried forward is `python/pymd_server`, the lineage for
the local kernel and the `knuth run` CLI.

Principle behind the ordering: build the spine first, in risk order. The
file format freezes everything downstream, the kernel carries the main
technical risk, and the folder contract (values.json + figs/) is the
demo that proves the two-app design. UI comes last because it's the most
visible work but the least likely to invalidate anything.

## Milestone 0 — Scaffold ✓

Vite + vanilla TS, mirroring Plass conventions (tsx-run tests, fixed dev
port 5198). No framework, no editor deps yet.

## Milestone 1 — File format (parse/serialize, round-trip) ✓

Implemented in `src/format/percent.ts`; corpus + tests in
`src/format/corpus/` and `src/format/round-trip.test.ts` (`npm test`).

The `.py` percent-format document model, as pure logic with no UI.

- Parser: `.py` text → cell list (program / scratch / text), tolerant of
  anything jupytext or VS Code emits.
- Serializer: cell list → `.py` text. **Round-trip must be byte-identical**
  on a corpus of test files (the `md-round.test.ts` pattern from Plass).
- Machine-managed output blocks under cells: parse, attach to their cell,
  reserialize exactly. Figures referenced by `figs/<name>.svg` path, never
  embedded.
- Decide and freeze the two open syntax questions (DESIGN.md Q3):
  - scratch-cell tag (`# %% scratch` or similar),
  - output-block delimiter comment syntax.
  Both must be inert under bare `python file.py` and invisible-but-harmless
  in other percent-format editors.

Done when: corpus round-trips byte-identically, including files written by
jupytext, and the syntax decisions are recorded in DESIGN.md.

## Milestone 2 — Kernel (decision, then session) ✓

Built as decided in KERNEL.md: `python/knuth/` (Session, kernel
subprocess, WebSocket server; `knuth serve`, default port 5197) and
`src/kernel/kernel.ts` (Kernel interface + SidecarKernel client).
End-to-end tests in `python/tests/test_kernel.py`; `src/main.ts` is a
temporary dev panel until Milestone 3.

Two candidate architectures, both behind the same small Kernel interface
(run cell, stream stdout, report result/error, interrupt, restart):

- **Local sidecar** (pymd_server lineage): real CPython over a localhost
  WebSocket. Full package ecosystem, native speed and memory, trivially
  reads/writes the project folder. Cost: users need Python installed and a
  server running; app must manage the process or ask the user to.
- **Pyodide in a Web Worker**: CPython in WASM, zero-install in the
  browser. Cost: ~2–4GB memory ceiling, only Pyodide-built packages,
  and the project folder must be mounted via the File System Access API
  (Chromium-only) — the riskiest assumption, especially writing figures
  through the mount.

**Decision checkpoint at the start of this milestone**: the tradeoff
write-up lives in [KERNEL.md](./KERNEL.md), recommending the local
sidecar for v1 (one engine shared with `knuth run`; Pyodide stays
available later behind the same Kernel interface as a zero-install
teaching mode).

Done when: a code string runs in a fresh session from the app, stdout
streams back, errors carry tracebacks, and Stop works.

## Milestone 3 — Document UI (linear execution) ✓

Built: `src/document-view.ts` (CodeMirror cells, markdown text cells,
staleness badges, streamed outputs written back as `#->` blocks, 40-line
truncation), `src/file-manager.ts` (File System Access open/save with
debounced autosave, fallbacks), PWA manifest registering Knuth as a `.py`
file handler with launch-queue handling, and the GitHub Pages deploy
workflow. Double-click-a-.py needs the deployed app installed once from
Chrome; manifest edits need an app uninstall/reinstall to propagate to
the OS (Plass lesson).

- Cell list rendering: CodeMirror 6 for code cells, plain-CSS markdown for
  text cells (no Plass layout port in v1 — DESIGN.md Q6, decided).
- Open/save real `.py` files through the round-trip layer.
- Linear execution: program cells top-to-bottom; editing a cell marks all
  cells below stale (badge + one-click "run stale"). No DAG.
- Outputs render under their cell and are written into the file as output
  blocks on save.
- Scratch cells v1: shared namespace + never-persists rule (DESIGN.md Q4,
  decided). The one-way ChainMap namespace is a later upgrade.

Done when: open, edit, run, save a `.py` cell document end to end.

## Milestone 4 — The contract (auto-persistence) ✓

Built. The kernel produces artifacts (`Session.artifacts()`: JSON-safe
namespace mirror + named figures as SVG text); the app materializes them
into an attached project folder ("Folder…" in the toolbar) after each
clean program-cell run — the browser cannot hand the kernel a real path,
so contract writes happen client-side through the directory handle, which
also works unchanged for a future Pyodide backend. Acceptance demo passed:
values.json + figs/fig.svg + stock `typst compile`, value change picked up
on recompile with neither app in the loop.

- After each program-cell run, mirror the namespace per DESIGN.md rules:
  - scalars / small serializables → `values.json` (regenerated, never
    appended; deleted names disappear),
  - named figure objects → `figs/<name>.svg`, rewritten each run,
  - `_underscore` names private; DataFrames session-only.
- Acceptance test is the two-app demo: a project folder with a `paper.typ`
  using `#json("values.json")` and a referenced figure — edit code in
  Knuth, run, stock `typst compile` picks up both changes. Plass never in
  the loop.

Done when: that demo works.

## Milestone 5 — `knuth run` (CLI) ✓

Built: `python/knuth/percent.py` (port of the TS format layer, corpus
round-trip parity enforced in tests) + `python/knuth/runner.py`. Fresh
session, program cells only, top to bottom in the document's folder (so
relative data reads work here), first error stops the run with a nonzero
exit. Output blocks rewritten as receipts — memory addresses in reprs
normalized to `0x…` so a re-run is byte-stable — and on a clean run the
contract regenerates (on failure the previous values.json is kept: the
contract always reflects the last complete run). Verified:
`knuth run analysis.py && typst compile paper.typ` end to end.

## Milestone 6 — Session panes ✓

Built: the RStudio-quality half of the architecture — panes looking into
the live session, not the document. `src/panel.ts` renders the variable
explorer (name, type, shape, preview; refreshed after every run, restart,
and reconnect) and the data viewer: click a DataFrame/Series/2-D ndarray
to open a windowed table view (100 rows per fetch, 200-column cap, sticky
headers, "More" paging — the full object never leaves the kernel;
`Session.table()` serves string-rendered windows over the `table`
protocol message). Toggle with the toolbar "Session" button; state
persists in localStorage.

## Later (tracked, not scheduled)

- Editable DataFrames in the data viewer (Taylor, 2026-08-13): edits must
  preserve reproducibility by materializing as code appended to a cell
  (e.g. `df.loc[3, 'wage'] = 12.5`) rather than mutating silently — the
  viewer becomes a code generator, the document stays the truth.
- ~~Figure receipts~~ built (2026-08-14): output blocks carry
  `figs/<name>.svg` lines for the canonical name of each figure a cell's
  run touched (direct Figure bindings beat artist references — one file
  per figure); the app resolves receipts from the project folder on open,
  `knuth run` writes identical byte-stable lines. Unnamed figures still
  display-only.

- Scratch cells in a one-way ChainMap namespace (structural enforcement of
  the no-hidden-state rule).
- Cell-level DAG for staleness precision; possibly opt-in reactive rerun.
- The kernel not chosen in Milestone 2, behind the same interface.
- Tables in the folder contract (DESIGN.md Q1 — parked).
- Kernel working directory: sidecar code can't `read_csv('data.csv')`
  relative to the project folder, because the browser never learns real
  paths. Likely a server-side project root (`knuth serve --root` or a
  path hint file) — needed before `knuth run` feels complete.
- Plass line-breaker port for text-cell typography (Q6 revisit).
- External-change reload, themes, export niceties.
