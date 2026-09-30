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
itself**, on the Mac, in daily use. Then `app/Sources` goes. (Retired
2026-09-30, Taylor: "i just want to clean up and use this one version":
`app/Sources`, `app/build.sh`, `app/Info.plist` and the page's WebKit
path are gone; git history has them.)

DECIDED: **The template grows in Knuth** (Taylor, 2026-09-29). The generic
shell lives in `app/shell/` (windows, the bridge, the `knuth://` scheme,
the engine's lifetime, uv setup) and everything Knuth-specific in one
config beside it (name, bundle id, icon, port, the engine command, file
types). It moves to its own repository when Plass is its second user,
not before: a fourth repository for one app would be ceremony.

DECIDED: **Which Pythons an app offers is its config's `pythons` list**
(2026-09-30, for Plass). `["uv", "browser"]` is Knuth's, and the choice
above. One entry is no choice: `["browser"]` starts on the bundled page
at once, with no setup page and no Choose Python… in the menu (Plass,
which has no Python); `["uv"]` installs on the first launch with the
setup page as its progress screen (ManimLive). A config with no Python
package names its page folder as `web`.

DECIDED: **The template has moved to its own repository** (2026-09-30,
Plass being its second user): `~/Projects/claerbout`, whose README is
the reference for the config keys and the protocol. Knuth depends on it
as the `claerbout` package, pinned to a tag's tarball
(`https://github.com/tayweid/claerbout/archive/refs/tags/v0.1.3.tar.gz`;
SHELL_STABILITY.md has why not the `github:` shorthand);
`app/` here holds only `knuth.json`, and `npm run app`, `app:build`,
`app:smoke` and `app:install-script` run the package's scripts on it. Two additions made
there for Plass: the shell answers Chromium's permission questions
itself (files by handle, fullscreen and clipboard writes for the app's
own pages, more by config, everything else refused), and an app whose
page keeps files by handle can ask for its document by drop (`openBy:
"drop"`, the page's `ready` notice) beside the `?open=` path.

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
that checks the sender's origin is the one the shell loaded into that
window (the engine's or `knuth://app`). Its
messages are today's `knuth` handler's: `open`, `saveAs`, `read`, `write`,
`stat`, `rename`, `remove`, `choose`, `status`, `error`, plus what Plass
and ManimLive will need (`fullscreen`, `keepAwake`, and an `openFile`
event; OPEN, none built: each is added when its first user arrives).
During the trial the page spoke both protocols, the Electron one and the
Swift shell's WebKit handler; since the Swift shell retired it speaks
only this one.

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

Steps 1-3 landed 2026-09-29, the same night as the plan; 4 and 6 on
2026-09-30; 5 is on hold.

1. **DONE — The protocol and the page adapter.** `src/shell.ts`:
   `window.claerbout` when present, else null; tested against fake
   hosts. `setup.js` speaks it on its own.
2. **DONE — The shell in `app/shell/`**, Knuth's config in
   `app/knuth.json`; `npm run app` runs it from the checkout.
3. **DONE — Mac packaging and install.** `app/package.mjs` (`npm run
   app:build` installs into Applications); the deploy packages both
   processors, installs through the install line and smoke-tests the
   result (`app/smoke.mjs`) before publishing.
4. **DONE — Mac trial**: the Electron build is the one in Applications
   from 2026-09-30 (the self-completing one since that morning, installed
   through the page's download). The basic stability items that followed
   are in SHELL_STABILITY.md.
5. **Windows**, on hold (Taylor, 2026-09-30). The engine's Mac-only corners first: `--parent` checks
   liveness with `os.kill(pid, 0)`, which is not a liveness test there;
   interrupt, if it leans on signals; paths. Then `install.ps1` and
   whichever test route the OPEN item settles. The shell already takes
   Windows' shapes (uv's zip, `Scripts\python.exe`, files by argv and
   `second-instance`, the menu in the window), untried.
6. **DONE — Retire the Swift shell** (2026-09-30). Move `app/shell/`
   out when Plass joins.

### What building it found (2026-09-29)

- **The framework must stay Electron's exact bytes**, or a sibling's
  cannot be cloned and Electron's release cannot be downloaded in its
  place. Two things change it. An asar: since Electron 41 the packager
  writes the asar's integrity digest into the framework binary and
  re-signs it, so the app ships its code as a plain folder (`asar:
  false`). Fuses: they are bits in the same binary, so none are flipped.
  The build records the binary's SHA-256 in Info.plist
  (`ClaerboutFrameworkSHA256`, beside `ClaerboutElectronVersion`), and
  the install line clones or downloads only a framework with that hash.
  This holds for Plass and ManimLive too; it is the suite's rule.
- **Signing.** The packager renames the helper apps, which invalidates
  their signatures; they and the outer bundle are signed ad-hoc as the
  app ships, without the framework, which keeps Electron's own
  signature. Only on arm64: Electron's x64 release is unsigned, and
  Intel Macs run it so. Electron's three small frameworks (Mantle,
  ReactiveObjC, Squirrel) ship with signatures that fail `codesign
  --verify --deep --strict`, and a browser download's Gatekeeper checks
  deeply: it called the app "damaged" with no Open Anyway (2026-09-30,
  Taylor's test through Zen). Re-signed ad-hoc like the helpers, the
  download gets the ordinary "Not Opened" with Open Anyway, as the Swift
  app did, and the build now verifies deep. (Electron's big framework
  fails the same check, but it is never in the download.) Once completed, the bundle no longer matches
  its seal (the framework is new to it); Apple silicon checks each
  program's own signature at launch, and every one is intact.
- **macOS 13.** Electron 44 needs Ventura or later; the Swift app ran
  on 12.
- **Sizes.** The zip is 2.8 MB. Electron's release is 124 MB, fetched
  once per version when no sibling has it (about 10 s here); an update
  clones from the app it replaces (under a second), and a second app on
  the same version costs about 6 MB. Installed, the app is 292 MB by
  Finder's count.
- **The app completes itself** (Taylor, 2026-09-29/30: "the check for
  electron on install instead of downloading the whole thing at once";
  Mac-like, what you download is the app; and "the flow should be the
  same no matter whether its the first start"). Every zip, the page's
  download button's too, is the app without the framework. Every launch
  is one flow: the bundle's executable is a small compiled launcher
  (`app/shell/launcher.swift`, Electron's own executable beside it as
  `Knuth Electron`) that looks for the framework; there, it `execv`s
  Electron before touching AppKit; not there, it shows a progress window,
  runs `complete.sh` (the same script the install line runs), and then
  `execv`s Electron, handing it the documents the launch was for as
  arguments (`main.js`, `filesIn`). Opened where it was downloaded (App
  Translocation, read-only), it asks to be moved to Applications first.
- **Why compiled.** A script launcher lost the document of a first
  launch: any AppKit process a launch starts (a progress window from
  `osascript`, even with no window, at any delay) makes macOS send the
  launch's "open document" event to the launcher, and a script cannot
  take it; `exec`ing `osascript` does not either (its program is not in
  the bundle), and a copy of Apple's `osascript` in the bundle is killed
  on launch. The launched process must be a program in `Contents/MacOS`
  that is itself the AppKit app, so it is Swift, built by `swiftc` in
  `app/package.mjs` (about 100 lines, one per processor).
- **The browser-download path under Gatekeeper**, verified by hand
  2026-09-30 (Taylor, through Zen): "Not Opened", Open Anyway, the
  move-to-Applications prompt when opened from Downloads, the app
  completing itself by download (6 s) after the move, and later launches
  with no further prompt although the bundle changed after approval.
- **No service worker inside a shell.** It kept the PWA's shell for a
  launch without an engine; in the app it could only serve a stale page,
  and under Playwright's debugger a registered worker wedged navigation.
- **Chromium's storage** (caches, localStorage) lives in `Chromium/`
  inside the app's folder, so `KNUTH_CONFIG_DIR` isolates the page's
  state as well as the engine's. The Swift app's WebKit storage does
  not carry over; nothing in it outlives a session that matters (the
  documents are files).

## What the shell does, exactly

1. On launch, start what was chosen: the engine on uv's Python, from the
   bundle, as a child; or nothing, for the built-in Python. With no
   choice yet, show the setup screen and hold any documents until it is
   answered.
2. Open a window per document at `http://127.0.0.1:5187/?open=<absolute
   path>` (or `knuth://app/?open=…` for the built-in Python). With no file (Dock click, ⌘N), open `/` — the page restores its
   last document, or shows a new one.
3. Bridge two dialogs. The page asks `{type: "open"}` or `{type: "saveAs",
   name}` over the shell protocol (src/shell.ts); the shell shows the
   native open or save panel and answers with the chosen absolute path.
   The page then does the actual open or save over the socket. With an
   engine, the shell reads a document only to open it (above) and never
   writes one.
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
  `app/Knuth.app.zip`, a universal binary, ad-hoc signed. (Since the
  Electron shell: `app/Knuth-<arch>.zip` without Electron's framework,
  which the install line completes, and `app/Knuth.app.zip`, the same
  arm64 app for the download button, which completes itself; see "What
  building it found".) The install line
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
