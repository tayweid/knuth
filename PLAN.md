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

## Milestone 3 — Document UI (linear execution)

The visible workbench, against the frozen format and working kernel.

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

## Milestone 4 — The contract (auto-persistence)

The Claerbout payoff: Knuth's session feeds a Typst paper with no glue.

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

## Milestone 5 — `knuth run` (CLI)

The reproducibility check and canonical artifact producer (bare
`python file.py` parity is explicitly not guarded — DESIGN.md Q2, decided).

- Fresh session, program cells only, top to bottom.
- Regenerates `values.json` and `figs/`, rewrites output blocks in the
  file. Nonzero exit on error.
- Lives with the Python side (pymd_server lineage) so it works headless:
  `knuth run analysis.py && typst compile paper.typ` is the full pipeline.

## Milestone 6 — Session panes

The RStudio-quality half of the architecture: panes looking into the live
session, not the document.

- Variable explorer: names, types, shapes from the session namespace.
- Data viewer: click a DataFrame for a real table view.

## Later (tracked, not scheduled)

- Scratch cells in a one-way ChainMap namespace (structural enforcement of
  the no-hidden-state rule).
- Cell-level DAG for staleness precision; possibly opt-in reactive rerun.
- The kernel not chosen in Milestone 2, behind the same interface.
- Tables in the folder contract (DESIGN.md Q1 — parked).
- Plass line-breaker port for text-cell typography (Q6 revisit).
- External-change reload, themes, export niceties.
