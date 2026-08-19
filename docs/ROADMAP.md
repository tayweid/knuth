# Knuth — roadmap

Written 2026-08-18, at the close of the same-origin phase. Two layers: the
**plan of record** is work intended to happen, roughly one phase out; the
**horizon** is a sketch, committed to nothing. Conventions as in DESIGN.md
and SAME_ORIGIN.md: DECIDED marks a decision of record, OPEN marks a
question that still needs one.

## Plan of record

### The workbench

- **Kernel working directory.** The app's kernel subprocess can't
  `read_csv('data.csv')` relative to the project folder, because the
  browser never learns real paths — only `knuth run` chdirs (runner.py).
  Likely a server-side project root (`knuth serve --root` or a path hint
  file); the engine being local makes this resolvable without the browser.
  Needed before the app and `knuth run` feel like one tool.

### Release gates (carried from HARDENING_PLAN.md, retired 2026-08-18)

- Serve the hosted demo through a host/proxy capable of production response
  headers — GitHub Pages cannot emit header-only directives such as
  `frame-ancestors`. The gate and header set are in RELEASE.md.
- Run the installed-PWA/launcher smoke checklist on macOS, Windows, and
  Linux, including the optional macOS launch agent.
- Publish GitHub release assets only after the cross-platform release
  commit is green.
- Commission an independent attack pass over the release candidate.

### Same-origin loose ends (SAME_ORIGIN.md)

- OPEN: a per-process token, minted at startup and echoed in `attach`, as
  defense in depth against a future origin-check bug. Cheap now that the
  server serving the page is the server holding the secret.
- The hosted demo is still technically installable (its manifest is
  unconditional), against the DECIDED demo-not-installable posture. Close
  the gap.
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

- **Pyodide, and the demo that executes.** The unmerged `pyodide` branch
  runs the real Python modules in the browser so the hosted demo executes
  for real, end to end. Before it is input to anything: CI coverage, and
  the CSP expressed once rather than twice (index.html and server.py).
  OPEN (branch, `2b27d68`): vendor Pyodide into the Pages deploy vs the
  CDN — vendoring removes the third-party dependency but would put ~25 MB
  of WebAssembly into every pip install until the demo build and the wheel
  build are separated.
- **Percent format, one implementation.** `percent.py` calls itself a port
  of `percent.ts` kept honest by corpus tests; the pyodide branch
  demonstrates the browser running the real Python modules, which could end
  the dual implementation outright rather than pinning it with parity
  fixtures.
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
- External-change reload, themes, export niceties.
