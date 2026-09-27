# Knuth — the document's environment

Design notes from a working session (2026-09-26). The question was package
management: how a document says which Python and which packages it needs,
so that opening it anywhere runs the same software without a setup step.
Conventions as in DESIGN.md: DECIDED marks a decision of record, OPEN marks
a question that still needs one.

## The claim this serves

README promises `knuth run analysis.py && typst compile paper.typ` as the
whole build of a paper. That is only true if the machine running it has
the packages the analysis was written against. Until now the document said
nothing about them: it ran on whatever Python the engine was installed
into. The Claerbout claim — the folder regenerates itself with neither app
in the loop — needs the environment to be part of the document.

## Decisions

DECIDED: **The document carries its environment, in a PEP 723 inline
metadata header.** A `# /// script` comment block at the top of the `.py`,
above the first `# %%`, names the Python version range and the packages:

```python
# /// script
# requires-python = ">=3.13"
# dependencies = [
#     "pandas==2.3.2",
#     "matplotlib==3.10.6",
# ]
#
# [tool.uv]
# exclude-newer = "2026-09-26T00:00:00Z"
# ///

# %% [markdown]
# # Analysis
```

This is a Python packaging standard (PEP 723, "inline script metadata"),
not a Knuth or uv format. uv, pipx, hatch, and pdm all read it. PyCharm
reads it. It is comments, so bare `python analysis.py` still runs when the
packages happen to be present. Emailing the one file emails its
environment.

Rejected: a `pyproject.toml` and `.venv` per folder. It is the other
standard uv handles, and VS Code finds the `.venv` on its own, but the unit
of reproducibility becomes the folder, and a folder of project files is
what "just email the .py" was meant to avoid. Knuth reads a `pyproject.toml`
if the user made one (see "Resolution order") but never writes one.

DECIDED: **No lock file.** A lock records the exact versions the resolver
chose for every package, including the ones underneath (pandas pulls in
numpy, dateutil, pytz, tzdata). It is a second file beside the document,
which breaks "one file". Instead:

- Packages the document imports are **pinned exactly** in the header,
  `pandas==2.3.2`, written by uv with `--bounds exact`.
- Everything underneath is held by the **date stamp**, `exclude-newer` in
  the header's `[tool.uv]` table: the resolver ignores anything published
  after that date, so the numpy it picks in 2031 is the numpy it picked on
  the stamp date. Other tools ignore the `[tool.uv]` table, which the
  standard permits. The stamp is written once, when Knuth creates the
  header; it is the user's to move.

Pinning every transitive package into the header was considered and
rejected: it is a lock file living in the header, forty lines for a scipy
stack, and it stops the header reading as "what this document uses".

DECIDED: **Environments live in uv's central store**, not beside the file.
uv keys a script's environment on the script and keeps it under
`~/.cache/uv/environments-v2/`. Nothing appears in the project folder, two
documents in one folder never fight over a `.venv`, and package files are
hard-linked from uv's cache so fifty environments cost about one copy. The
price is that the environment is invisible to `ls` and to VS Code; the
engine reports its path (the `environment` event) and `uv python find
--script analysis.py` prints it in a terminal.

DECIDED: **uv is the runner, and Knuth uses only uv-managed Pythons.**
Knuth sets `UV_PYTHON_PREFERENCE=only-managed` when it invokes uv, so a
document's `requires-python` is satisfied by a standalone build uv
downloads into `~/.local/share/uv/python`, never by Anaconda, Homebrew, or
python.org Python found on the machine. Every Knuth on every machine then
runs the same interpreter build, and a `brew upgrade` cannot break a
document. Anaconda and the rest are untouched and keep working for
everything else. A terminal user running `uv run analysis.py` gets uv's
own default, which may pick a system Python that fits the range; packages
are pinned either way, and interpreter builds rarely differ in ways that
matter. The first document on a machine pays a Python download (30–50 MB,
observed at three minutes on a slow link); later documents share it.

Knuth finds uv at `$KNUTH_UV`, then beside its own interpreter, then on
`PATH`. Knuth.app should bundle the binary and set `KNUTH_UV` in the
engine's environment (APP.md follow-up): a single static file, permissive
license, and once it is there uv can provision Python too, which retires
the Anaconda/Homebrew/python.org hunt in the shell.

DECIDED: **Knuth writes the header only through uv, except to create it.**
A new document (first save to a path that does not exist, and `knuth
import` of a notebook) gets an empty header: `requires-python` at the
engine's minor version, `dependencies = []`, and today's stamp. Every later
change goes through `uv add --script`, so the formatting is exactly what a
terminal user gets from the same command and two writers never disagree.
Built-in Python (Pyodide in the window, APP.md) reads the header and
installs what it declares, but never writes it: a second writer was
considered and dropped the same day (APP.md records the decision) — it is
the try-it mode, not the one carrying the reproducibility claim, and a
document authored there gets pinned the first time it runs under the
engine. The percent parser keeps the header in the document preamble,
byte for byte, and output receipts can never land above it.

DECIDED: **Installs are asked for, never silent** (Taylor, 2026-09-27,
superseding "Import installs"). When a cell fails with `No module named
X`, the page shows a toast with **Install with uv**; clicking it sends
`install{id, module}` and the engine runs `uv add --script <doc> --bounds
exact <distribution>` then `uv sync --script <doc>`, so the header gains
the exact pin and the environment gains the package, and the cell runs
again. It used to happen on every run of a managed document before the
cell ran, which was invisible: a document without a header never
installed, and nothing said why. A small table maps import names to
distribution names where they differ (`sklearn` → `scikit-learn`, `PIL` →
`pillow`, `cv2` → `opencv-python`, …); everything else is assumed to share
its name. A name uv cannot resolve is reported on the toast. If the document is already
pinned to a version, that is the version installed, and `import pandas`
gets it. To want a different one, edit the pin.

`knuth run` never installs. It is the reproducibility check; a missing
package there means the header is incomplete, and the honest answer is a
failure.

DECIDED: **Existing documents are untouched until asked.** A document with
no header runs on the engine's own Python. The first "Install with uv"
gives it a header (`knuth.env.with_header`), adds the package, and answers
`installed{restart: true}`; the page then restarts the session into the
new environment and reruns the stale cells. An unsaved document
installs without being saved (Taylor, 2026-09-27): uv reads a header from
a file, so the engine keeps a copy of the page's text for that session
under the app's state folder (`unsaved/<session>.py`), installs against
it, and sends the header back with no path, for the page to splice into
its own text. Saving later carries the header into the real file, and the
restart for the new path rebuilds the same environment from uv's cache.

DECIDED: **uv chooses the Python, by its own default** (Taylor,
2026-09-27). A header floats (`requires-python = ">=3.13"`) and uv runs a
document on the newest Python it has already installed that satisfies
it, downloading one only when none does. Knuth adds no rule of its own.
Running every document on Knuth's own Python instead was built and
reverted the same day: it saved package downloads when a newer Python
arrived, at the cost of a second rule beside uv's.

DECIDED: **Every session runs in a uv environment from the start, and
nothing restarts it but a restart** (Taylor, 2026-09-27). Installing used
to restart the session whenever the document had no environment yet (an
unsaved document, a file without a header), and saving restarted it too;
pip in a notebook does neither. Now a document with a header gets its own
environment, and any other session gets a scratch one under the state
folder (`unsaved/<session>.py`, a fresh header), so "Install with uv"
always lands in the environment the kernel is already running in: the
cell runs again with every variable intact. The header comes back as a
`header` event naming the scratch file; the page splices it into the
document as an edit and autosave carries it to the real file. Saving or
renaming sends `chdir` so relative paths follow the file, without a
restart; the session moves to the document's own environment at the next
restart, rebuilt from uv's cache. `KNUTH_ENVIRONMENTS=off` turns scratch
environments off for the tests that predate them.

DECIDED: **What a cell imports is listed, right after it runs.** A package
that arrives with another (pandas with seaborn) imports without failing,
so no toast ever offered it and the header never named it: the document
depended on it silently. After a clean run the kernel lists every
imported, installed, non-standard-library package the header lacks,
pinned to the version installed, with `uv add --offline` — bookkeeping,
no download (`knuth.env.declare_imports`).

DECIDED: **The header folds to one line** in cell view, "Packages:
seaborn 0.13.2 · pandas 2.3.1", and opens on a click. Source view shows
it as text, as always.

## Resolution order

For a document the engine is asked to run:

1. A PEP 723 header in the document → its own environment, via uv.
2. No header → the engine's own interpreter, as before.

OPEN: a `pyproject.toml` in the document's folder or an ancestor, with no
header in the document, should probably win over the engine's Python
(`uv run --project`). Not built; the header is the route we are betting
on, and the project route is one line away if someone needs it.

## How it works

**Kernel start.** The page sends the document's absolute path on `attach`
and on `restart` (`document`, beside `root`). The server runs `uv sync
--script <doc>`, which creates or updates the environment and is a
millisecond no-op when nothing changed, then `uv python find --script
<doc>` for its interpreter, and starts `python -m knuth.kernel` on that
interpreter instead of its own (`KernelProcess.start`). Sync and find run
in a worker thread so the event loop keeps serving other windows.

**The kernel code reaches the document's interpreter without being
installed there.** `knuth.kernel` and everything it imports (`session`,
`contract`, `artifacts`, `limits`) use only the standard library. The
server points `PYTHONPATH` at a shim directory containing a `knuth`
package whose `__init__` sets `__path__` to the real package, so the
document's environment sees exactly one extra package, Knuth's own, and
nothing else from the engine's site-packages. Knuth therefore never
appears in the header, which is what "the folder regenerates without the
app" requires. A test imports the kernel modules with the engine's
third-party packages hidden, so this stays true.

**Installing** is the server's job, on the page's `install` request: it
emits `dependency` (installing, then installed with the pinned version, or
failed with uv's reason), the rewritten `header` for the page to splice,
and `installed{ok, restart}`. The kernel, in a managed environment (it
knows its document from `KNUTH_DOCUMENT`), invalidates the import caches
at the start of every run, so a package installed into its environment
imports without a restart.

**`knuth run`** resolves the document's environment the same way and, if
it is not already running on that interpreter, re-executes itself there
with the same shim, guarded by `KNUTH_IN_ENVIRONMENT` against loops. A
header with no uv on the machine is reported and the run proceeds on the
engine's Python, since the alternative is refusing to run a file that
plain `python` would run.

**New documents.** `files.save_document` to a path that does not exist,
with text that has no header, prepends one and returns its lines in the
`saved` reply. `knuth import` does the same for the `.py` it writes.

## Protocol (additive; version stays 2)

Requests:

- `attach{…, root?, document?}`, `restart{id, root?, document?}` —
  `document` is the absolute path of the open `.py`; anything invalid means
  no managed environment.

Events:

- `environment{document, state, python, managed, reason?}` — `state` is
  `syncing` (sent before the kernel starts when uv has work; on a first
  attach this precedes `attached`), `ready` (kernel is on the document's
  interpreter), or `fallback` (engine's Python; `reason` says why). Once
  per kernel start, and again on resume so a reloaded tab knows.
- `dependency{id, state, module, distribution, version?, error?}` —
  during a `run`; `state` is `installing`, `installed`, or `failed`. Not a
  `stream`, so it never becomes an output receipt.
- `header{id, path, lines, modified}` — during a `run`, after an install
  rewrote the header on disk. `lines` is the whole block; the page replaces
  its own block (or inserts at the top) and adopts `modified`.
- `saved{…, header?}` — the lines of a header the save created.

Pure functions the browser kernel can share (`knuth.env`, standard library
only): `find_header(text)`, `header_lines(text)`, `parse_header(text)`.

## In a terminal, or any other editor

- `uv run analysis.py` builds the environment from the header and runs the
  file. `uv add --script analysis.py --bounds exact pandas` adds a pin.
- `uv python find --script analysis.py` prints the interpreter, which is
  what VS Code or Spyder needs to be pointed at. PyCharm reads the header
  itself. `knuth env analysis.py` does the same through Knuth's uv.
- `python analysis.py` runs if that Python has the packages. The header is
  comments.
- `uv export --script analysis.py --format pylock.toml` hands a standard
  lock file to anyone who wants pip and hashes.

## Follow-ups

- Knuth.app bundles uv and sets `KNUTH_UV` (APP.md).
- Page: send `document`; show `environment`, `dependency`, and `header`
  events; splice headers; offer to pin a headerless document. Restart on
  document change, not only folder change.
- DONE 2026-09-26: the browser kernel feeds `parse_header(...)["dependencies"]`
  to micropip, so one header serves both backends (read-only there).
- OPEN: a first-launch `uv python install` in the app, so the first
  document does not pay the download at its first run.
