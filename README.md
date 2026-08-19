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
