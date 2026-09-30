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
(The shell's material is superseded by "Electron, one shell for Claerbout"
below; still not Tauri, and still only the served page beyond those jobs.)

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
Opening is the exception in Knuth.app (2026-09-27): the shell reads the
document itself, because the engine answers a session only once uv has
built its environment, and a document whose packages must download sat
blank for minutes, then fell back to an empty "Knuth.py". Saving stays
with the engine, which gives a new file its header.

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
equivalent is a later, separate piece. (Superseded for Windows by the
Electron section below: Knuth.app goes to Windows for next semester.)

## One Python, chosen once (2026-09-27)

The decisions above about finding a Python on the Mac, installing the
engine into it, and reusing an engine already on port 5197 are superseded
by this section. They made it unclear which Python was running: the app
could be talking to miniconda, to an engine started that morning, or to
the window. Taylor's call, after using it:

DECIDED: **The app never uses a Python that is already on the Mac.** Not
Anaconda, not Homebrew, not python.org. There is no discovery, no
"install into your Python", no interpreter chooser.

DECIDED: **Knuth runs Python through uv, and only uv.** It is the package
manager built for reproducible work (ENVIRONMENT.md), and the only one
Knuth uses. The alternative is not another package manager; it is running
on the web.

DECIDED: **The first launch asks one question, in the window: install
Python?** The bundled `setup.html` explains uv in two sentences and
offers two answers. "Install Python with uv": the app downloads uv's
release for this processor from Astral's GitHub into its own folder, uv
installs a Python it manages itself (`UV_PYTHON_PREFERENCE=only-managed`),
and the engine starts on it; each step is reported on that same screen.
"Not now — run on the web": Python runs in the window through Pyodide,
loaded from the web each time; nothing is ever installed for it. Knuth
menu → Choose Python… asks again.

DECIDED: **Any uv will do** (Taylor, 2026-09-27). uv is the same tool
wherever it came from, so the app uses the uv already on the Mac —
Homebrew's, uv's own installer's, anywhere on the usual paths — and only
when there is none downloads Astral's release into `~/.local/bin/uv`,
where uv's own installer puts it. There is then one uv on the Mac, usable
from the terminal as well. (A private copy in the app's folder was built
first and dropped: it bought a pinned uv version at the cost of a second,
invisible uv.)

DECIDED: **Neither ships in the download.** The zip carries the window
and the knuth package (2.3 MB). uv is about 18 MB and its Python about
40 MB, fetched once when chosen.

DECIDED: **The engine is the one in the bundle.** `Contents/Resources/
python/knuth` is the package, the page inside it; the engine runs it
with `PYTHONPATH`, on the Python uv installed, with `websockets` as the
only thing installed beside it. The app and its engine are therefore
always the same version, and a stale engine from a login agent or a
pip install cannot be what the window is talking to.

DECIDED: **The app's engine has its own port, 5187** (the next free one
if taken), apart from a terminal's `knuth app` on 5197. The app never
adopts an engine it did not start.

DECIDED: **The status pill names the Python**: "uv" or "Pyodide", or
plain "Python" for an engine someone started from a terminal on a Python
of their own. There is no "built-in Python": the earlier name for the
Pyodide option suggested a Python shipped in the app, and there is none. The path and the reason are in its tooltip.

Everything else the app installs lives in `~/Library/Application Support/
Knuth` (`engine/`, `preferences.json`); removing that folder
returns the app to its first launch. uv's own Pythons and cache are in
uv's usual places and shared with any other use of uv.

Verified 2026-09-27 on a clean config folder: chose uv on the setup
screen, uv unpacked, Python 3.13.15 installed by uv, engine up on the
bundled package, a cell reporting that Python rather than the Mac's
miniconda 3.13.9, the pill reading "uv", and the engine gone when
the app was killed. The uv download itself was exercised against a local
archive; the real address is the release asset for the processor.

## Electron, one shell for Claerbout (2026-09-29)

The suite's direction was decided in ManimLive (`maniml/docs/app_plan.md`,
"Claerbout: Electron for all three apps"): one Electron shell template,
built three times into Knuth.app, Plass.app and ManimLive.app, each with its
own name, icon, menus, file types and install line, each app's engine
serving its page. Chromium everywhere is Plass's reference engine and
ManimLive's (V8, the WebGPU it is developed on); Knuth is indifferent to the
engine and goes first because of its audience: Windows students next
semester, as an optional alternative to Google Colab. Everything above
about what the shell does (uv only, one Python chosen once, port 5187, the
engine as a child, the shell as the file system for Pyodide, `.py` as an
alternate handler) stands; only the material changes.

DECIDED: **The Swift shell stays until the Electron one has proved
itself**, on the Mac, in daily use. Then `app/Sources` goes.

DECIDED: **The template grows in Knuth** (Taylor, 2026-09-29). The generic
shell lives in `app/shell/` (windows, the bridge, the `knuth://` scheme,
the engine's lifetime, uv setup) and everything Knuth-specific in one
config beside it (name, bundle id, icon, port, the engine command, file
types). It moves to its own repository when Plass is its second user,
not before: a fourth repository for one app would be ceremony.

DECIDED: **Packaged with `@electron/packager`** (Taylor, 2026-09-29),
not by hand in the manner of the Swift `build.sh`. The packager does the
part that is fiddly by hand: renaming the executable and the four helper
apps together, the Info.plist (document types with `LSHandlerRank`
Alternate), the icon. It runs in the deploy on a GitHub Mac as `build.sh`
does now; development runs Electron from `node_modules` with no build
step, the page loading from the engine or Vite's dev server as it does
now, with Chrome's DevTools.

DECIDED: **One page-to-shell protocol.** The preload exposes
`window.claerbout.request({type, …}) → Promise` through `contextBridge`
(context isolation and the sandbox on), answered by one `ipcMain.handle`
that checks the sender's origin is the app's engine or `knuth://app`. Its
messages are today's `knuth` handler's: `open`, `saveAs`, `read`, `write`,
`stat`, `rename`, `remove`, `choose`, `status`, `error`, plus what Plass
and ManimLive will need (`fullscreen`, `keepAwake`, and an `openFile`
event). During the trial the page speaks both: one small adapter sends to
`window.claerbout` when it exists and to `window.webkit.messageHandlers.knuth`
otherwise, so the Swift and Electron apps run from the same page.

The Swift shell's jobs, in Electron: a `BrowserWindow` per document (the
title follows the page's by default); `protocol.handle` on a privileged
`knuth` scheme for the bundled page (still a non-loopback origin, so the
page still picks Pyodide by itself); `child_process.spawn` of `knuth serve
--parent <pid>`; Finder opens by `open-file` (registered before `ready`),
Windows opens by `requestSingleInstanceLock` and `second-instance`'s argv;
navigation kept in the window (`will-navigate`, `setWindowOpenHandler`,
`shell.openExternal` for everything else); the Knuth menu from a template.
uv's discovery and download move to JavaScript; on Windows uv's release is
a zip holding `uv.exe`.

DECIDED: **Chromium once on the Mac, by APFS clones from a sibling app.**
The zip leaves `Electron Framework.framework` out (286 of Electron's
288 MB), so it stays a few megabytes, one per processor since Electron's
programs are per architecture. The install line looks for an installed
Claerbout app on the same Electron version (the framework's
`Resources/Info.plist`, `CFBundleVersion`) and clones its framework in
(`cp -c`: no space used, a standard Electron app, the sandbox on);
with none, it downloads Electron's release for that version from GitHub
(130 MB) and checks the published SHASUMS256. Then it re-signs the bundle
ad-hoc. Exact versions only; another volume downloads. Clones share only
when versions match exactly, so the template pins one Electron version and
the three apps move together. Windows keeps a copy per app.

DECIDED: **Windows installs like the Mac.** A PowerShell line in uv's
shape (`irm https://knuth.tayweid.io/install.ps1 | iex`) unpacks into
`%LOCALAPPDATA%\Programs\Knuth`, adds a Start menu entry and registers
Open With under HKCU: no administrator, no installer program.

OPEN: **How Windows is tested.** There is no Windows machine and the
windows-latest CI leg was dropped (ROADMAP.md). Playwright drives Electron
(`_electron.launch`), so a windows-latest job can smoke-test the real app;
by-hand checks need a Windows VM (UTM). One of the two before students.

OPEN: **The students' first answer.** On the setup screen "run on the
web" (Pyodide) needs no install; for a Colab alternative it may be the
right first answer on Windows, with uv as the upgrade.

### Order

1. **The protocol and the page adapter.** Testable without Electron.
2. **The shell in `app/shell/`**, Knuth's config beside it, run from
   `node_modules`; parity with the Swift shell's jobs above.
3. **Mac packaging and install.** The deploy's app job runs the packager
   and zips each architecture without the framework; `public/install`
   gains the clone-or-download step.
4. **Mac trial** beside the Swift app, on a spare port and config folder,
   through the by-hand checks recorded above.
5. **Windows.** The engine's Mac-only corners first: `--parent` checks
   liveness with `os.kill(pid, 0)`, which is not a liveness test there;
   interrupt, if it leans on signals; paths. Then `install.ps1` and
   whichever test route the OPEN item settles.
6. **Retire the Swift shell**; move `app/shell/` out when Plass joins.

## What the shell does, exactly

1. On launch, start what was chosen: the engine on uv's Python, from the
   bundle, as a child; or nothing, for the built-in Python. With no
   choice yet, show the setup screen and hold any documents until it is
   answered.
2. Open a window per document at `http://127.0.0.1:5187/?open=<absolute
   path>` (or `knuth://app/?open=…` for the built-in Python). With no file (Dock click, ⌘N), open `/` — the page restores its
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

Per-document environments (docs/ENVIRONMENT.md, engine side on the
`document-environments` branch) add, page side landed 2026-09-26:
`attach{…, document?}` and `restart{…, document?}` carry the open
document's absolute path, sent on every attach and restart, and a changed
path restarts even within the same folder (save as, rename), since the
environment is per document. The engine answers with `environment`
(syncing / ready / fallback with a reason: the status pill and a toast for
a document that declares packages but fell back), `dependency` (a package
being installed for a cell: toasts, never receipts), and `header` (the
PEP 723 block the engine rewrote on disk: spliced into the page's
preamble, keeping unsaved edits, and its mtime adopted so the change poll
does not reload over it); a `saved` reply may carry the `header` a new
file was given. The in-tab Python reads the same header for micropip
(`knuth.env.parse_header`, loaded into the tab), so one header names the
packages in both modes. DECIDED 2026-09-26 (Taylor): the tab does not
write headers. Pinning what micropip installed back into the header was
built, made to match uv's format through `knuth.env.add_pin`, and then
dropped the same day: nobody uses the built-in Python for reproducible
science, and a second header writer is complexity without a user. A
document that needs to reproduce is opened over the engine, where uv
owns the header. The splice for the engine's `header` events moves only
the preamble (`setPreamble`), so a header arriving mid-run never
rebuilds the cell that is running.

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
  gone. DECIDED 2026-09-26 (Taylor): ship unsigned and document the
  one-time click — apps from outside the App Store ask for this all the
  time — and offer the terminal route beside it, which never sees the
  prompt because only browser downloads are quarantined. The download was
  first a file committed to the repository by `app/build.sh`. DECIDED
  2026-09-28 (Taylor: one distribution system for all his apps, the one
  Plass uses): nothing binary is committed. Every push to main deploys the
  site and builds the app on a GitHub Mac from that same deploy — the site
  job's verified `dist` is the page, the checkout supplies the knuth
  package and the shell — and publishes it beside the site as
  `app/Knuth.app.zip`, a universal binary, ad-hoc signed. The install line
  is `curl -fsSL https://knuth.tayweid.io/install | bash` (`public/install`),
  which unzips it into Applications; running it again updates. A failed
  app build never holds the site: the deploy republishes the live zip.
  This is the standard finished-app shape, so signing with a Developer ID
  and notarization can slot into the app job later.
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
