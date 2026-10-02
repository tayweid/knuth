# Knuth — roadmap

Written 2026-08-18, at the close of the same-origin phase. Two layers: the
**plan of record** is work intended to happen, roughly one phase out; the
**horizon** is a sketch, committed to nothing. Conventions as in DESIGN.md
and SAME_ORIGIN.md: DECIDED marks a decision of record, OPEN marks a
question that still needs one.

## Plan of record

### The workbench

- **Kernel working directory** — SHIPPED 2026-08-23: `knuth serve
  --root PATH` / `knuth app FOLDER` start every kernel (attach and
  restart) in the project root; no root means the old behavior. One
  root per engine — per-session roots would need real paths the
  browser withholds by design. AMENDED 2026-09-25 (APP.md): roots are
  per session now, carried on attach and restart, because the app
  shell has the real path.

- **The document's environment** — BUILT 2026-09-26, design and
  decisions in ENVIRONMENT.md: a PEP 723 header in the document is the
  truth, uv builds the environment in its store on a uv-managed Python,
  the kernel and `knuth run` execute there, an import installs and pins.
  Engine side complete; page side (send `document`, show `environment`
  and `dependency`, splice `header`) and bundling uv in Knuth.app are the
  open follow-ups listed there.

- **Knuth.app** — IN PROGRESS 2026-09-25, design and decisions in
  APP.md: a native window around the served page, `.py` files opened in
  their own folder, file I/O through the engine by path, the PWA retired
  as the way to a window. First Swift + WKWebView; since 2026-09-29 the
  Claerbout shell (Electron, the `claerbout` package), with Windows for next semester
  still to do.

- **Floating session panes** — PLANNED 2026-09-27 (Taylor). The side
  panel's three parts (variables, figures, the data viewer; panel.ts)
  become three rounded boxes floating off the document's right edge,
  mostly tucked out of sight by default. When one changes (a new
  variable, a new figure) it grows and eases partway into view, then
  settles back. A click brings it fully out and it stays out; a click
  back in a cell tucks it away again. On a wider window the boxes show
  as much as the right margin allows, so a wide screen sees them whole
  without a click. The panel button then cycles three modes: **hidden**,
  **floating** (the default, as above), and **docked** (the full panel
  beside the document, as today), offered only when the window is wide
  enough for it. OPEN: how far "partway" is, how long a change keeps a
  box forward, and whether the mode is remembered per window or once.

- **Autosave: a git track of every edit** — PLANNED 2026-09-27, spec in
  AUTOSAVE.md (Claerbout-wide, Plass and Knuth alike). Every project
  keeps a full, never-pruned git record of its work, start to finish:
  a commit on every cell run and every minute when anything changed,
  written with git plumbing to one autosave branch per repository so
  the person's own branch and staging area are never touched; messages
  name the app and the trigger (`knuth: cell run [4]`). Large data goes
  in an ignored `untracked/`, kept inside the track by a hashed
  manifest. The autosave branch is pushed regularly, since the remote
  is what pins the times. For Knuth this lands mostly for free: the
  receipts and the uv header are already in the file, so each run is a
  diffable change, and values.json and figs/ ride along. OPEN, per the
  spec: outside edits and gaps, preregistration as the first commit, a
  remote the person can push to but not rewrite, the replay viewer,
  and where the shared module lives (a Claerbout package both apps
  call).

- **Commented scratch bodies** — SHIPPED 2026-08-23, prefix amended to
  `#| ` (DESIGN.md: lossless where `# `+escape collides). Both parsers
  and the corpus moved together; the editor decodes for display and
  encodes on sync; `knuth run` canonicalizes legacy bodies the way it
  canonicalizes CRLF.

### Release gates (carried from HARDENING_PLAN.md, retired 2026-08-18)

- Serve the hosted demo through a host/proxy capable of production response
  headers — GitHub Pages cannot emit header-only directives such as
  `frame-ancestors`. The gate and header set are in RELEASE.md.
- Run the installed-PWA/launcher smoke checklist on macOS, Windows, and
  Linux, including the optional macOS launch agent. Restore the
  windows-latest CI leg at the same time (dropped 2026-08-20 — single
  developer, no Windows machine; its checkout-newline failure mode is
  already fixed by .gitattributes).
- Publish GitHub release assets only after the cross-platform release
  commit is green.
- Commission an independent attack pass over the release candidate.

### Same-origin loose ends (SAME_ORIGIN.md)

- OPEN: a per-process token, minted at startup and echoed in `attach`, as
  defense in depth against a future origin-check bug. Cheap now that the
  server serving the page is the server holding the secret.
- DONE 2026-10-01: the hosted demo is no longer installable — the
  manifest link is added by the page only when served from loopback and
  not inside Knuth.app (SAME_ORIGIN.md, step 3).
- OPEN: the dev-loop vite WebSocket proxy — implement it so dev and
  production exercise the same code path, or strike the section.
- DECIDED (`d6659d0`): built assets stay committed and freshness-gated;
  revisit a CI-built release wheel at the first tagged release.

### Test debt (audited 2026-08-18)

The Python engine is pinned by outcome-based tests over real subprocesses
and sockets. The browser side is thinner:

- The Playwright harness's mocked socket never answers `restart`,
  `interrupt`, `table`, `artifacts`, or `incompatible`, so a server-side
  reshape of those events would ship unnoticed. Extend the mock to exercise
  each once.
- `document-view.ts`: staleness propagation, cell-kind conversion, and
  delete-undo-restore have no tests, and need a DOM harness that does not
  exist yet.
- `test_doctor.py` asserts on a mocked `websockets.connect` call rather
  than a real server's answer; rewrite it against a live `serve()` the way
  test_kernel.py works throughout.

### Deferred refactors (audited 2026-08-18, left alone deliberately)

- `kernel.ts` keeps five parallel waiter-map pipelines (namespace,
  artifacts, table, figure, restart); a generic request helper would remove
  the forgot-one-call-site risk when adding an RPC verb, but touches every
  request method for differing failure shapes — do it alongside the next
  protocol change, not as tidying.
- The 40-line output-truncation policy is implemented twice on purpose
  (document-view.ts and runner.py, matching docstrings, DESIGN.md). Two
  small mirrored functions; unify only if the policy grows again.

## Horizon (sketch, committed to nothing)

- **Pyodide, and the demo that executes.** The `pyodide` branch (rebased
  onto the app work 2026-09-26) runs the real Python modules in the
  browser so the hosted demo executes for real, end to end. Before it is
  input to anything: CI coverage, and the CSP expressed once rather than
  twice (index.html and web.py). OPEN: vendor Pyodide into the Pages
  deploy vs the CDN — vendoring removes the third-party dependency but
  would put ~25 MB of WebAssembly into every pip install until the demo
  build and the wheel build are separated. SHIPPED 2026-09-26 as
  Knuth.app's built-in Python too (APP.md): the shell serves the page
  and does the file I/O itself, and the page writes the contract.
- **Percent format, one implementation.** `percent.py` calls itself a port
  of `percent.ts` kept honest by corpus tests; the pyodide branch
  demonstrates the browser running the real Python modules, which could end
  the dual implementation outright rather than pinning it with parity
  fixtures.
- **Code hints** — STARTED 2026-09-27. The kernel answers `complete{code,
  offset}` against the live session with Jedi (what IPython, Jupyter and
  Spyder use), falling back to the standard library's rlcompleter;
  `knuth/complete.py`, shared by the Pyodide kernel, which loads Pyodide's
  own Jedi on first use. The engine installs Jedi once into
  `tools/` beside its preferences — never into a document's environment,
  so it never reaches a header — and the completer appends that folder to
  the path when it first needs it. The editor uses CodeMirror's
  `@codemirror/autocomplete`: offered after a "." or two typed letters and
  on Ctrl-Space. Next: signature help inside a call's parentheses, and a
  docstring panel beside the list (Jedi has both).
- Editable DataFrames in the data viewer: edits materialize as code
  appended to a cell (`df.loc[3, 'wage'] = 12.5`) rather than mutating
  silently — the viewer becomes a code generator, the document stays the
  truth.
- Scratch cells in a one-way ChainMap namespace (structural enforcement of
  the no-hidden-state rule).
- Cell-level DAG for staleness precision; possibly opt-in reactive rerun.
- The kernel not chosen in Milestone 2 (Pyodide), behind the same Kernel
  interface, as the zero-install teaching mode.
- Tables in the folder contract (DESIGN.md Q1 — parked).
- Plass line-breaker port for text-cell typography (DESIGN.md Q6 revisit).
- Themes, export niceties. (External-change reload shipped 2026-08-22.)
- **Knuth in Zen's shape** — a static draft, 2026-09-30, at
  `docs/mockups/rail-layout.html`: a near-black frame, a top bar carrying
  the traffic lights and the document's name where Zen keeps the address,
  a flat rail of large rounded icon buttons on the left, the document as
  an inset rounded panel. Colors and glyphs inside the panel are Knuth's
  own; the frame's are Zen's. Open it in a browser. OPEN: whether this is
  the app's shape (the shell's `titleBarStyle: 'hiddenInset'` is what the
  top bar assumes), and what the rail holds.
