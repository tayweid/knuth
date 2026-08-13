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

Named things persist automatically: assign a scalar and it mirrors to
`values.json`; assign a figure to a name and it lands in `figs/<name>.svg`.
`knuth run file.py` is the reproducibility check — fresh session, program
cells top to bottom, outputs rewritten as receipts, contract regenerated.
The full build of a paper is one line:

```bash
knuth run analysis.py && typst compile paper.typ
```

**Status: v2 rebuild in progress.** The design is in
[DESIGN.md](./DESIGN.md), the build order in [PLAN.md](./PLAN.md). The v1
Tauri app (WYSIWYG markdown with executable cells) lives on the
[`v1-tauri`](../../tree/v1-tauri) branch, its docs in `archive/v1/`.

## Install as an app (Chrome)

Knuth is a PWA registered as a handler for `.py` files: once the deployed
app is installed from Chrome (⋮ → Cast, save and share → Install), macOS
offers Knuth for double-clicked `.py` files, which arrive via the launch
queue. Manifest changes only propagate to the OS after an app
uninstall/reinstall. Deploy = push `main`: `.github/workflows/deploy.yml`
publishes to GitHub Pages. The kernel stays local either way — the page
connects to the kernel server on localhost, and reconnects automatically
if it comes and goes.

One-time kernel setup, so the server is simply always there:

```bash
.venv/bin/knuth agent install   # launchd service: starts at login, restarts on exit
.venv/bin/knuth agent status    # or uninstall
```

## Development

```bash
npm install
npm run dev    # Vite dev server on port 5198
npm test       # format round-trip tests

python3 -m venv .venv && .venv/bin/pip install -e python/
.venv/bin/knuth serve                        # kernel server on ws://127.0.0.1:5197
.venv/bin/python python/tests/test_kernel.py # kernel end-to-end tests
```

`python/` is the `knuth` package: the live session, the kernel
subprocess and WebSocket server behind `knuth serve`, and the future
home of `knuth run`.

## License

MIT
