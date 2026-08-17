# Kernel decision — where does Python actually run?

Milestone 2 opens with this choice. Both options sit behind the same small
Kernel interface (run cell, stream stdout/stderr, return result or
traceback, interrupt, restart, namespace snapshot), so the one not chosen
stays buildable later without rework. This doc is the tradeoff record.

## The two architectures, in plain terms

### A. Local sidecar — a real Python process on your machine

A small Python program (the `python/pymd_server` lineage) runs on your
computer; the browser app talks to it over a localhost WebSocket. This is
the architecture of every serious tool in this space: Jupyter, RStudio,
and VS Code notebooks are all a UI in front of a real interpreter process.

**What you get**
- Real CPython: every package pip can install, including compiled ones
  (geopandas, arch, linearmodels, anything). No compatibility list.
- Native speed and native memory — a 1.3GB CSV is fine if the machine has
  the RAM. No artificial ceiling.
- The project folder is just a folder: `pd.read_csv('data.csv')` and
  writing `figs/plot.svg` work with no browser permission layer.
- One engine for everything: `knuth run` (the headless reproducibility
  check) has to be real Python anyway, since it runs in pipelines next to
  `typst compile`. With a sidecar, the app and the CLI share the same
  session code — build it once.
- Clean process semantics: interrupt is a real signal, restart is killing
  and relaunching a process.

**What it costs**
- Requires Python plus our package on the machine. First run is
  the GitHub install command shown by the hosted app, and the app has to
  find/launch/manage the process — version mismatches and port conflicts are
  our support burden.
- "Open a web page" is not enough; someone without Python installed can't
  use it. Fine for us; a real barrier if Knuth ever wants to onboard a
  student in one click.

### B. Pyodide — Python compiled into the browser

CPython compiled to WebAssembly, downloaded by the page (~15MB plus
wheels) and run in a Web Worker inside the tab. Nothing is installed.

**What you get**
- Zero install. Open the page, run code. Same everywhere, can't break or
  be broken by anything else on the machine, perfectly sandboxed. For
  teaching (no Anaconda-install office hours) this is the killer feature.
- numpy, pandas, matplotlib, scipy, statsmodels, scikit-learn all exist
  as prebuilt WASM wheels, plus any pure-Python package.

**What it costs**
- Memory ceiling: WASM caps out around 2–4GB total. Mid-size econ data is
  fine; a full IPUMS extract is not.
- Package wall: anything compiled that isn't in Pyodide's build set simply
  doesn't exist (much of geopandas' stack, most exotic econometrics
  packages). The wall is invisible until you hit it.
- Slower — typically 2–5x on numeric work.
- The project folder must be mounted through the File System Access API:
  Chromium-only, permission-prompted, and write-through of `figs/` and
  `values.json` relies on sync semantics that need a spike to trust.
- Interrupting running code requires SharedArrayBuffer, which requires
  cross-origin-isolation headers — hosting complexity for a core feature.
- `knuth run` still needs real Python regardless, so Pyodide-first means
  building and maintaining two execution paths from day one.

## DECIDED (2026-08-13): local sidecar for v1

Knuth's stated identity (DESIGN.md) is the computation half of a
reproducibility workflow: native-scale work, real project folders, and a
CLI that regenerates artifacts in a pipeline. Every one of those points at
the sidecar, and the CLI needs real Python no matter what — sidecar-first
means one engine serves both the app and `knuth run`, while Pyodide-first
means two engines forever. The install cost lands on us (who have Python)
rather than on strangers, and `uv` has made the install story genuinely
good.

Pyodide's one decisive advantage — zero-install for students — is real,
and it's the reason the Kernel interface stays pluggable. If Knuth grows a
teaching mode, Pyodide arrives later as an additive backend behind the
same interface, not an architectural rewrite. Deferring it costs nothing.

## What Milestone 2 builds (sidecar)

- `python/`: session object (persistent namespace, exec per cell,
  stdout/stderr capture, tracebacks), WebSocket server speaking a small
  JSON protocol, interrupt via signal, restart via process replacement.
- `src/kernel/`: the Kernel interface and its WebSocket client.
- Protocol messages (v2): the initial `attach` requires the exact protocol
  version plus either the durable capability or a single-use pairing token.
  A trusted CLI may request that token with an authenticated
  `create_pairing` handshake. After attachment, `run{id, code}` →
  `stream{id, text, which}`* → `done{id, result?}` | `error{id, traceback}`.
  `restart`, `namespace`, `artifacts`, `table`, and `figure` also carry a
  request ID echoed by their response; `interrupt` is intentionally one-way.
  Every inbound request and outbound browser event is shape-validated. An
  unexpected subprocess exit fails pending work, removes the dead session,
  and allows the next connection to start cleanly.

Done when: from the app, a code string runs in a fresh session, stdout
streams back live, errors carry tracebacks, and Stop actually stops a
running loop.
