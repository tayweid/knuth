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

The production PWA is served from `https://knuth.tayweid.io`. Secure custom
domain and agent-pairing setup is documented in [DEPLOYMENT.md](./DEPLOYMENT.md).

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
[DESIGN.md](./DESIGN.md), the build history in [PLAN.md](./PLAN.md). The v1
Tauri app (WYSIWYG markdown with executable cells) lives on the
[`v1-tauri`](../../tree/v1-tauri) branch, its docs in `archive/v1/`.

## Install and launch

Open [knuth.tayweid.io](https://knuth.tayweid.io). The page offers PWA
installation and shows the commands for the current operating system when it
cannot reach a compatible local engine.

macOS and Linux:

```bash
python3 -m pip install --upgrade knuth
knuth app --hosted
```

Windows:

```powershell
py -m pip install --upgrade knuth
knuth app --hosted
```

The second command starts the Python engine on localhost, opens the hosted
app, and securely pairs that browser. Keep the terminal open while using
Knuth; `Ctrl-C` stops the foreground engine. If the console entry point is not
on `PATH`, use `python3 -m knuth app --hosted` on macOS/Linux or
`py -m knuth app --hosted` on Windows.

PWA installation is optional. In Chromium browsers it also registers Knuth as
a handler for `.py` files. The Python engine remains local whether Knuth runs
in a browser tab or an installed window.

### Optional macOS background agent

The cross-platform foreground command is the default. macOS users who want an
engine that starts at login can additionally use:

```bash
knuth agent install
knuth agent status
knuth agent restart
knuth agent uninstall
```

`knuth agent pair` displays the durable capability for manual recovery, and
`knuth agent rotate-token` revokes all paired browsers.

If the page and engine do not connect, run `knuth doctor`. It reports the
installed version, Python executable, redacted capability-file health, local
port state, protocol version, and live-session count without printing the
capability or document contents.

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

`python/` is the published `knuth` package: the hosted launcher, live session,
kernel subprocess, WebSocket server, background-agent helper, and the
reproducibility runner behind `knuth run`.

## Security

Please report vulnerabilities privately rather than opening a public issue.
The supported-version policy, threat-model boundary, and reporting process are
in [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE) © 2026 Taylor J Weidman
