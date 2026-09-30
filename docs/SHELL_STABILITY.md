# The Claerbout shell — stabilizing it before it spreads

Written 2026-09-30, from a review of the Electron shell as it landed
(APP.md, "Electron, one shell for Claerbout", and the self-completing
branch), and revised the same day against the code and Taylor's scope.
Conventions as in DESIGN.md: DECIDED marks a decision of record, OPEN a
question that still needs one.

DECIDED (Taylor, 2026-09-30): **Basic Mac stability only, now.** No
Windows work, not even as a side effect. The Swift shell retires now,
not on a date. The template's seams (Phase 2) and the signing spike wait
until Plass or students need them.

Two sections. **Now** is what is being implemented, in order. **Deferred**
is the rest of the review, kept so the reasoning is not redone, with the
trigger that reopens each item. Done items are marked as they land.

## Now

### 1. An interrupted completion must not brick the app

DONE 2026-09-30 (`complete.sh`: `.incoming`, hash, rename). Tested by
killing a completion mid-copy: only `.incoming` was left, the binary
was not in place, and the next run completed.

**Problem.** `complete.sh` writes the framework straight into place
(`cp -Rc` and `ditto` into `$target`), and `launcher.swift` decides the
app is complete when the framework's main binary exists. A first launch
that is quit, killed, or put to sleep mid-copy leaves the binary without
its libraries or resources; every later launch execs a broken Electron,
and nothing ever repairs it.

**Change.** Complete into `Contents/Frameworks/.Electron
Framework.framework.incoming`, check the binary's hash there, then
rename it into place: one atomic step from "no framework" to "the whole
framework". The launcher's existence test is then sufficient. A stale
`.incoming` from an earlier interruption is removed before starting.
Test: kill `complete.sh` mid-copy, launch again, and see it complete.

### 2. A window keeps the shell it opened with

DONE 2026-09-30 (`main.js`: `origins`, set by `load()` whenever the
shell loads a page into a window). Tested: a uv window, Choose Python…
→ Pyodide, and the old window's Save As… still answered.

**Problem.** `trusted()` (main.js) accepts the engine's origin only while
the global `mode` is `uv`. After Knuth menu → Choose Python… switches to
Pyodide, windows already open on the engine have their dialog and file
requests refused, silently, with a log line.

**Change.** Record each window's origin when it is opened (`documents`
already maps window → document; widen it to `{document, origin}`), and
trust a request when the sender's origin is that window's. `mode` then
decides only what a new window loads. Test: open a uv window, choose
Pyodide, Save As… in the old window still shows the panel.

### 3. The install line replaces the app atomically, and not underneath a running one

DONE 2026-09-30 (`public/install`, and the running check in
`package.mjs --install` too). A directory cannot be renamed over a
non-empty one, so the swap is still remove-then-rename, but both are on
one volume and the gap is a rename's. The running check matches the
bundle path with or without `/private`, which macOS drops from paths it
reports. Tested: fresh, update, sibling, a failed Electron download
(nothing left behind), and refusal while the app was open.

**Problem, atomicity.** `public/install` unzips and completes the app in
a temp folder, then `rm -rf` the old app and `mv` the new one in.
Between the two there is no app; if the move fails there is none
afterwards. The sibling clone is also judged against the temp folder's
volume, not the destination's: with TMPDIR on another volume the clone
is skipped, or made and then materialized as a full copy by the move.

**Problem, a running app.** The install line deletes the bundle of a
Knuth that is running. Every renderer or helper Electron starts after
that reads from a bundle that is gone.

**Change.** Unzip into `<App>.app.incoming` beside the destination,
complete it there (the sibling search then sees the right volume, and
the app being replaced stays the first candidate), and rename
`.incoming` over the old app. This is what `package.mjs --install`
already does; the two share the last step exactly. Before replacing,
detect a running Knuth from that bundle and ask to quit it first
(`pgrep -f` on the bundle's executable path; refuse with a clear line
when not interactive). The deploy's install-line smoke test covers the
atomic path.

### 4. Retire the Swift shell now

DONE 2026-09-30. Also gone: the `openFile` event from `src/shell.ts`'s
types (never built; see the protocol-promises item under Phase 2).

**Problem.** `app/Sources/main.swift` and `app/build.sh` are no longer
built by the deploy, so they are untested code, and the page carries a
second protocol (`src/shell.ts`, the WebKit branch) to serve them.

**Change.** Delete `app/Sources`, `app/build.sh`, `app/Info.plist`, the
WebKit branch of `src/shell.ts` and its test, and the "both shells" text
in APP.md (the Swift shell's material is then history, recorded in git).
`src/shell.ts` keeps only `window.claerbout`; a plain browser tab still
gets null.

## Deferred

Kept from the review, with corrections from checking against the code.
None is scheduled; each names what reopens it.

### 5. The engine follows the shell by a pipe — reopened by Windows

`knuth serve --parent PID` polls `os.kill(pid, 0)`. On the Mac that is a
working liveness test; on Windows `os.kill` with any signal but the two
console events calls TerminateProcess, so the engine's first check would
kill the app. Windows is out of scope, and the Mac poll works, so this
waits.

When it is done: spawn the engine with stdin piped and never write to
it; the engine exits on EOF. Not `asyncio.to_thread(sys.stdin.read)`:
that parks a default-executor thread on a blocking read, and
`asyncio.run`'s shutdown waits for it when the engine is stopped by
SIGTERM with stdin still open. A daemon `threading.Thread` that calls
`loop.call_soon_threadsafe` on EOF, with a test that SIGTERM still exits
promptly. Keep `--parent` for one release as the fallback for a
terminal-started engine.

### 6. Signing and notarization — reopened by students, or by any signed release

APP.md says a Developer ID and notarization "can slot in later". The
likely failure is concrete: notarization needs the hardened runtime,
whose library validation refuses a framework not signed by the same
team, and Electron's framework is only ad-hoc signed. The probable
answer is for CI to sign Electron's framework once with the Developer
ID and publish that signed framework as the one Claerbout apps download,
in place of Electron's GitHub release; identical bytes across apps keep
cloning working. A spike should test exactly that. OPEN until then.

### 7. An update path for the download button — reopened with item 6

The install line updates in place; the download button re-downloads and
meets Gatekeeper again each release. Smallest form: the installed
version beside the download on the page, and Check for Updates… in the
Knuth menu opening the site. Right form: the app completes and swaps in
a new framework-less zip itself, which is the install line's step run by
the app on itself. Decide with the signing answer, since a self-updating
app and notarization interact.

### 8. The framework check covers the whole framework — low priority

`complete.sh` compares one file, the framework's main binary; its
libraries and resources are copied unchecked from a sibling. A sibling
in Applications already runs as the user, so this is a completeness gap,
not an exposure. `codesign --verify` is not the cheap answer: Electron's
stock framework fails even the non-deep check (tried 2026-09-30). The
answer is a manifest of the framework's files with their SHA-256,
written by `package.mjs` into Resources and checked by the completer.

### Phase 2 — the template's seams, reopened when Plass joins

- **Which Pythons an app offers is config.** The setup screen, `choose`,
  `becomeReady`, `Installer` and the remembered preference encode
  Knuth's two answers. `app.json` gains `"pythons": ["uv", "browser"]`;
  with one entry the setup page never asks (`["browser"]` for Plass,
  `["uv"]` for ManimLive), and Choose Python… appears only with two.
- **The tooling takes a config.** `package.mjs --config`, `smoke.mjs`
  reading the name, prefix and selectors from it, and `public/install`
  generated from a template rather than hard-wired to Knuth's names.
- **The Electron pin lives with the shell.** `app/shell/package.json`
  declares `electron` and `@electron/packager`; when the shell moves to
  its own repository each app depends on a tag. Rule for bumps: one tag,
  three pull requests the same day, so the window in which a second
  install pays the full download stays short.
- **The protocol promises.** APP.md lists `fullscreen`, `keepAwake` and
  an `openFile` event; none exist in `answer()`, and a second instance
  opens a new window rather than emitting `openFile`. Documentation only
  when Plass starts: move them to an OPEN item and add each with its
  first user. Plass's first experiment (its ROADMAP: does Chromium's
  File System Access API simply work in the window?) decides how much of
  the file protocol Plass needs.
