# Knuth

> Part of the **Claerbout suite** with [Plass](https://github.com/tayweid/plass):
> Plass owns the paper, Knuth owns the computation. The contract between
> them is plain files in the project folder — `values.json` and
> `figs/<name>.svg` — that a stock `typst compile` reads with neither app
> in the loop.

Knuth is a computation workbench: a cell-document editor over a live
Python session. Documents are plain `.py` files in the percent format
(`# %%` cells), so they open as cell documents in VS Code, Spyder, and
PyCharm, run under bare `python`, and diff cleanly in git — with outputs
stored in the file as machine-managed comment blocks, so results change
alongside code in the history.

The app is served by the local Python engine on its own port, so the page
and the kernel socket share one origin and no credential ever travels
([SAME_ORIGIN.md](./docs/SAME_ORIGIN.md)). A read-only demo is hosted at
`https://knuth.tayweid.io`.

The session is separate from the document, with panes looking into it
(the RStudio architecture): a variable explorer shows the live namespace,
and clicking a DataFrame opens a real windowed table view.

Named things persist automatically: assign a scalar and it mirrors to
`values.json`; assign a figure to a name and it lands in `figs/<name>.svg`.
`knuth run file.py` is the reproducibility check — fresh session, program
cells top to bottom, outputs rewritten as receipts, contract regenerated.
The full build of a paper is one line:

```bash
knuth run analysis.py && typst compile paper.typ
```

**Status: v2 public-release candidate.** The design is in
[DESIGN.md](./docs/DESIGN.md), the build history in [PLAN.md](./docs/PLAN.md). The v1
Tauri app (WYSIWYG markdown with executable cells) is retired at the
`v1-tauri` tag in git history, its docs at that tag's root.

## Install and launch

### Knuth.app (macOS)

The app is a native window around the same local engine (design in
[APP.md](./docs/APP.md)). It is one file in this repository,
[`app/Knuth.app.zip`](https://github.com/tayweid/knuth/raw/main/app/Knuth.app.zip). Two ways in:

- **Download it**, unzip, drag `Knuth.app` to Applications. The app is not signed with an Apple Developer ID, so the
  first launch of a browser download is refused until you allow it once:
  System Settings → Privacy & Security → scroll to the message about
  Knuth → **Open Anyway**. Every later launch is ordinary.
- **Or install it from the terminal**, which never sees that prompt (only
  browser downloads are quarantined):

```bash
curl -fsSL -o /tmp/Knuth.app.zip https://github.com/tayweid/knuth/raw/main/app/Knuth.app.zip && rm -rf /Applications/Knuth.app && ditto -x -k /tmp/Knuth.app.zip /Applications
```

`app/build.sh` rebuilds the app and that zip from a checkout, with the
command-line tools alone and no Xcode project.

Open it. The first launch asks one question, in the window: install
Python? Knuth runs Python through [uv](https://docs.astral.sh/uv/), and
only uv — the package manager built for reproducible work. Say yes and
the app downloads uv, uv installs a Python that belongs to Knuth (about
60 MB, once), and nothing already on the Mac is used or changed. Say not
now and Python runs inside the window through Pyodide, loaded from the
web, with the common packages and no reproducibility. The status pill
always says which one is running, and Knuth menu → Choose Python… asks
again.

Double-clicking a `.py` (or choosing Knuth in Open With) opens it in its
own folder: the kernel starts there, and `values.json` and `figs/` land
there. The app starts its engine when it opens and stops it when it
quits.

### The terminal (every platform)

macOS and Linux:

```bash
python3 -m pip install --upgrade --force-reinstall "knuth @ https://github.com/tayweid/knuth/archive/refs/heads/main.zip#subdirectory=python"
knuth app
```

Windows:

```powershell
py -m pip install --upgrade --force-reinstall "knuth @ https://github.com/tayweid/knuth/archive/refs/heads/main.zip#subdirectory=python"
knuth app
```

The second command starts the Python engine on `127.0.0.1:5197`, which
serves the app itself and opens it in the default browser — nothing to pair,
no token to carry. Keep the terminal open while using Knuth; `Ctrl-C` stops
the foreground engine. If the console entry point is not on `PATH`, use
`python3 -m knuth app` on macOS/Linux or `py -m knuth app` on Windows. The
demo page at [knuth.tayweid.io](https://knuth.tayweid.io) shows these
commands pinned to the exact deployed commit; the `main` URL above follows
the latest repository version.

Installing the app as a PWA (from the local origin) is optional. In Chromium
browsers it also registers Knuth as a handler for `.py` files. The Python
engine remains local whether Knuth runs in a browser tab or an installed
window.

### Optional macOS background agent

The cross-platform foreground command is the default. macOS users who want an
engine that starts at login can additionally use:

```bash
knuth agent install
knuth agent status
knuth agent restart
knuth agent uninstall
```

If the page and engine do not connect, run `knuth doctor`. It reports the
installed version, Python executable, engine version, protocol version,
build stamp, and live-session count — never code, output, or document
contents.

## Working in a project

Start the engine in your project so relative reads work in the app —
`pd.read_csv('data.csv')` resolves against the folder every kernel
starts in:

```bash
knuth app ~/analysis        # or: knuth serve --root ~/analysis
```

Scratch cells are stored commented (`#| ` lines), so running the file
with plain `python` executes only the program cells; the app shows and
edits them as ordinary code.

### The document's environment

A document carries its own environment in a standard header at the top
of the file ([ENVIRONMENT.md](./docs/ENVIRONMENT.md)), and Knuth builds
it with [uv](https://docs.astral.sh/uv/):

```python
# /// script
# requires-python = ">=3.13"
# dependencies = [
#     "pandas==2.3.2",
# ]
#
# [tool.uv]
# exclude-newer = "2026-09-26T00:00:00Z"
# ///
```

New documents get an empty header. When a cell imports a package the
document does not have, Knuth adds it at its newest version and pins
that exact version in the header, then runs the cell again. A package
already on the Mac goes in without a word; one that needs a download
asks first (**Download with uv**). The date
stamp holds everything underneath, so the same file resolves the same
way years later. Nothing lands in the project folder: the environment
lives in uv's store, on a Python uv manages, whatever else is on the
machine. `knuth run` reproduces in that environment and never installs.
The header is comments, so the file still opens anywhere:

```bash
uv run analysis.py                       # build the environment and run it
knuth env analysis.py                    # print its interpreter (for VS Code, Spyder)
uv add --script analysis.py --bounds exact statsmodels
```

Without uv, or without a header, a document runs on the Python the
engine was installed into, as before.

## Migrating from Jupyter

```bash
knuth import notebooks/*.ipynb
```

Each notebook becomes a sibling percent-format `.py` — one-way, and never
overwriting an existing file. Outputs are dropped (`knuth run` regenerates
them as receipts), and magic or shell-escape lines, which are not Python,
arrive commented out.

The app speaks the same conversion: Open accepts a `.ipynb`, the engine
converts it, and the document arrives as an unsaved `.py` — saving writes
the `.py`; the notebook itself is never touched.

## Development

```bash
npm install
npm run dev    # Vite dev server on port 5198
npm test       # format round-trip tests
npx playwright install chromium # one-time browser test setup
npm run test:browser             # real-browser regression tests

python3 -m venv .venv && .venv/bin/pip install -e 'python[test]'
.venv/bin/knuth serve --origin http://127.0.0.1:5198 # explicit Vite origin
.venv/bin/python -m pytest python/tests              # Python unit + end-to-end tests
```

The installed sidecar accepts WebSocket upgrades only from Knuth's exact
release origin. Development and custom deployments opt into each additional
origin explicitly with one or more `knuth serve --origin
https://exact.example` arguments.

`python/` is the distributed `knuth` package: the hosted launcher, live session,
kernel subprocess, WebSocket server, background-agent helper, and the
reproducibility runner behind `knuth run`.

## Security

Please report vulnerabilities privately rather than opening a public issue.
The supported-version policy, threat-model boundary, and reporting process are
in [SECURITY.md](./docs/SECURITY.md).

## License

[MIT](./LICENSE) © 2026 Taylor J Weidman
