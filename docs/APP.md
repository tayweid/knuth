# Knuth — the app

Design notes from a working session (2026-09-25), after building a
folder-local `Edit <course>.app` for the course sites and asking whether the
same shape fits Knuth. It does, with the differences below. This document
amends the "Who receives the double-click" and "First run" sections of
SAME_ORIGIN.md; everything else there stands.

## What changed since the launcher was rejected

SAME_ORIGIN.md weighed a native launcher against the launchd agent and chose
the agent, for one reason: a launcher that owned the `.py` association would
be a second "Knuth" in Applications and Spotlight beside the installed PWA.
Three things are different now.

- **Launching is trivial.** Before the same-origin rewrite, a launcher
  minted a pairing token, found which browser held the PWA, and delivered
  the token through a URL fragment that the app shim dropped. Now it is
  "make sure something listens on the port, then open a URL."
- **The audience widened.** The two-command Jupyter-shaped first run is
  right for researchers and a wall for students. `Edit <course>.app` exists
  because a form editor that needs a terminal is one nobody opens.
- **The v1 lesson was about Tauri, not about windows.** DESIGN.md records
  that the Tauri shell made v1 slow to develop. A few hundred lines of
  AppKit around a WKWebView carries none of that: no Rust toolchain, no
  bundler, no plugin surface. The engine serves the same page either way.

## Decisions

DECIDED: **Knuth ships as `Knuth.app`, installed like any other app.**
Download, drag to Applications, double-click. It is the one Knuth icon. The
PWA is retired as the way to get a window; the hosted page at
knuth.tayweid.io stays a read-only demo.

DECIDED: **Not Tauri.** The shell is Swift + AppKit + WKWebView, built with
`swiftc` from the command-line tools — no Xcode project. It owns exactly
three things: a window per document, the native open/save dialogs, and the
engine process's lifetime. Everything else is the served page.

DECIDED: **The project folder is the opened file's folder.** Double-click
`analysis.py` and the kernel starts in its directory; `pd.read_csv('data.csv')`
resolves there; `values.json` and `figs/` land there. No prompt, no
directory grant. This is the PLAN.md item "launched files should assume
their own folder," now possible because the engine, not the browser, receives
the path.

DECIDED: **`.py` is registered as an alternate handler, never the default.**
The app appears in Open With; the user promotes it in Get Info if they want.
Taking the association from VS Code on install would be the wrong first
impression.

DECIDED: **File I/O moves to the engine.** The page no longer holds browser
file handles when it has a path: open, save, rename, change-polling and the
folder contract go over the kernel socket by absolute path, and the kernel
writes `values.json`/`figs/` into its own cwd — the same code `knuth run`
uses. The File System Access path stays as the fallback for a plain browser
tab, so `knuth app` in a terminal still works everywhere, and Safari and
Firefox stop being second-class (they never had the handle API).

DECIDED: **One engine, a root per session.** The attach handshake carries the
session's root; the kernel (and its restarts) start there. Two documents in
two folders share one engine and one port. ROADMAP.md's "one root per engine
— per-session roots would need real paths the browser withholds" is
superseded: the shell has the real path.

DECIDED: **The shell owns the engine's lifetime.** `Knuth.app` starts
`knuth serve --parent <its pid>` as a child process when nothing owns the
port; the engine polls that pid and stops when it is gone, so a crash or a
force-quit — which runs no terminate handler — never leaves an orphan. If
an engine is already running — the launchd agent, or a terminal — it is
reused and left alone. No idle-exit timer in the engine: the thing that
started it stops it. The agent remains optional and unchanged.

DECIDED: **First launch installs the engine.** The shell looks for a Python
3.11+ that already has `knuth`; failing that, one that has `pandas` (the
kernel runs in the same interpreter as the engine, so it must be the Python
the user does science in — Anaconda, Homebrew, python.org, in that order of
likelihood); failing that, any Python 3.11+. Apple's `/usr/bin/python3` stub
is skipped unless the command-line tools are installed, because running it
pops a dialog. Into the chosen interpreter it runs the same pip line the
README documents, with an alert before (it needs the network and takes
half a minute) and after. Every later launch skips this. `knuth doctor`'s
build stamp is how the shell knows when to offer an upgrade.

DECIDED: **Built-in Python is an explicit choice, never a silent fallback.**
When no Python with the engine is found, the first-launch alert offers
"Use Built-in Python" beside "Install" and "Choose Python…". Choosing it
means Pyodide runs the cells in the window — the same backend as the hosted
preview (SAME_ORIGIN.md, "Pyodide in the preview") — and it is remembered,
so later launches never go looking for Python. The Knuth menu switches
either way. It is not silent because its limits are real and invisible
until hit: only the packages Pyodide ships or pure-Python packages from
PyPI (micropip installs those on import — SAME_ORIGIN.md, "Pyodide in the
preview"), nothing with compiled code beyond that set, a memory ceiling of
a few gigabytes, and no interrupt. Someone who chose it knows what they
chose.

DECIDED: **In built-in mode the shell is the file system.** There is no
engine, so nothing serves the page and nothing reads files. The shell
serves the staged page from its own bundle under `knuth://app/` — the
non-loopback origin is what makes the page pick the in-tab backend, with
no new switch — and answers the page's read/write/stat/rename/remove
requests over the same message handler the dialogs use, shaped like the
engine's replies so the one file manager serves both. The contract is
written by the page through those primitives (src/contract.ts, the twin of
contract.py), because a kernel in the tab has no folder. With an engine,
nothing changes: the engine does files and the kernel writes the contract.

DECIDED: **Pyodide comes from the CDN, for now.** First use of the built-in
Python needs the network and about 25 MB; WebKit caches it after that.
OPEN: bundle it into the app (about 60 MB more with numpy, pandas and
matplotlib) so the built-in Python works offline and deterministically. The
base URL is one constant in pyodide-kernel.ts.

DECIDED: **Windows and Linux keep `knuth app`.** The shell is a macOS
convenience over that command, not a new install path. A `.bat`/`.desktop`
equivalent is a later, separate piece.

## What the shell does, exactly

1. On launch, and on every `application(_:open:)`, ensure an engine: probe
   the port; if free, find Python (above), start `python -m knuth serve
   --port 5197` as a child, wait for `GET /` to answer.
2. Open a window per document at `http://127.0.0.1:5197/?open=<absolute
   path>`. With no file (Dock click, ⌘N), open `/` — the page restores its
   last document, or shows a new one.
3. Bridge two dialogs. The page posts `{type: "open"}` or `{type: "saveAs",
   name}` to the `knuth` message handler; the shell shows NSOpenPanel or
   NSSavePanel and calls back into the page with the chosen absolute path.
   The page then does the actual open or save over the socket. The shell
   never reads or writes a document.
4. Mirror the page's `<title>` into the window title. Close (⌘W) closes the
   window; the engine reaps that session after its grace period as it does
   for a closed tab.
5. On quit, terminate the child engine if the shell started it.

## Protocol additions (v2, additive)

- `attach{…, root?}` — absolute directory the session's kernel starts in.
  Missing or unusable: the engine's default root, as before.
- `restart{id, root?}` — a restart may move the session: opening a document
  in another folder is a new project.
- `open{id, path}` → `document{id, path, name, text, modified}` or
  `document{id, error}`. An `.ipynb` path converts (the one converter) and
  comes back `unsaved: true` with a sibling `.py` path.
- `save{id, path, text}` → `saved{id, path, modified}` or `saved{id, error}`.
  Atomic: staged beside the destination, then replaced.
- `stat{id, path}` → `stat{id, path, modified}` (`modified: null` when the
  file is gone). The page's change poll, by path.
- `rename{id, path, name}` → `renamed{id, path}`: a rename within the folder.
- `persist{id}` → `persisted{id, values, figures}`: the kernel writes the
  folder contract into its cwd and reports the count and figure names. The
  page no longer receives SVG bytes to write itself.

Paths must be absolute. Nothing else restricts them: the socket is
origin-checked and the engine runs as the user, so a path the page names is
one the user could already `open()` — the same boundary as running Python.

## Risks

- **Gatekeeper.** An unsigned app downloaded from the web is blocked on
  macOS 15 until Privacy & Security → Open Anyway; the right-click trick is
  gone. OPEN: sign and notarize with a Developer ID (99 USD/year, would
  cover Plass too) vs document the one-time click. Until decided, the
  landing page documents the click.
- **Which Python.** The heuristic above will be wrong for someone with two
  environments. `knuth doctor` reports which interpreter the engine runs in,
  and an "Engine Python…" chooser in the app menu is the escape hatch.
- **The terminal path must not rot.** Every step here keeps `knuth app`
  working in a browser tab with the handle-based file manager. The browser
  regression tests run against that path and stay.

## Migration

Steps 1–4 landed 2026-09-25, step 6 on 2026-09-26; step 5 remains.

1. **DONE — Engine: paths and roots.** Per-session root on attach and
   restart; `open`/`save`/`stat`/`rename` by path (files.py); `persist` in
   the kernel sharing `knuth run`'s contract writer (contract.py); `knuth
   app FILE.py`; `knuth serve --parent PID`. Unit tests over the real
   socket.
2. **DONE — Page: path mode.** The file manager runs by path when it has
   one and by handle otherwise; `?open=` on boot; the shell bridge for
   dialogs; artifacts persisted by the kernel; the change poll by stat.
3. **DONE — Shell.** `app/` in the repo: `Sources/main.swift`,
   `Info.plist`, `build.sh` producing `app/build/Knuth.app`, icon from the
   existing PNGs. `KNUTH_PORT` and `KNUTH_CONFIG_DIR` in the environment
   (`open --env`) point a development build at a test engine.
4. **DONE — First-run install** in the shell; the README's install section
   leads with the app and keeps the pip commands for Windows, Linux, and
   the terminal-inclined.
5. **Retire the PWA surface**: manifest, service worker, install offer,
   launch-queue consumer. The hosted demo keeps a manifest-free build.
6. **DONE — Built-in Python.** `AppSchemeHandler` serves the bundled page;
   `FileOps` answers file requests; the page routes its file hooks to the
   shell when it has a shell and no engine, and writes the contract itself
   through `src/contract.ts`; the first-launch alert and the Knuth menu
   offer the choice. Verified 2026-09-26 with `{"engine": "browser"}` in a
   test config dir: launched on an `.ipynb`, the page came from the bundle,
   Pyodide reported ready in six seconds, the notebook was read through the
   shell, converted in the tab, and the sibling `.py` written back through
   the shell — no engine started, no page errors. Not yet exercised live:
   a cell run writing values.json through the shell (the writer is unit
   tested against a fake file system), and the menu switch.

Verified by hand 2026-09-25 (development build against a test port, the
login agent left alone on 5197): double-click opens the document with its
folder as the kernel's cwd, receipts autosave through the engine, run-all
writes `values.json` and the manifest beside the file, an outside edit
reloads in place with the session kept, and `kill -9` of the shell takes
the engine down within the poll interval. Not yet exercised by automation:
the NSOpenPanel/NSSavePanel bridge and the first-run pip install.
