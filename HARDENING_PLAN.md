# Knuth security and maintainability hardening plan

Status: proposed release plan, 2026-08-16

This plan hardens the existing local-sidecar design without changing Knuth's
core workflow: a public PWA edits `.py` cell documents and, after an explicit
user action, drives a persistent local CPython session. The work is ordered so
that behavior is captured in tests before security-sensitive boundaries move.

## Implementation progress

2026-08-16 — Phase 0 foundation:

- Converted all existing Python checks into seven discoverable pytest tests.
- Isolated the Matplotlib test configuration so a first-run cache warning does
  not make reproducibility receipts nondeterministic.
- Made frontend tests use a direct Node entry point that works in restricted
  environments without a temporary IPC listener.
- Added frontend build/test and Python 3.11/3.13 test gates ahead of deployment.
- Verified the frontend tests and build plus all seven Python tests locally.

Still required before Phase 0 is complete: malicious-content browser fixtures
for the renderer change and the installed-PWA/launch-agent manual smoke
checklist.

2026-08-16 — Browser baseline and first control-plane boundary:

- Added a Playwright/Chromium regression harness with a mocked versioned kernel
  handshake and normal static figure rendering.
- Upgraded Vite 5 to Vite 8 after the browser dependency audit exposed a
  high-severity development-server path-disclosure advisory and an esbuild
  cross-origin advisory. The updated dependency graph audits cleanly.
- Added protocol version fields and explicit incompatible-version handling,
  with a documented one-release legacy-v1 compatibility path to avoid breaking
  an installed older agent during rollout.
- Added exact WebSocket origin enforcement during the HTTP upgrade, before any
  kernel can be created. Current GitHub Pages and fixed local-development
  origins are allowed; hostile and missing origins are covered by integration
  tests.
- Verified that the updated local app still connects to the currently running
  legacy-v1 agent in a real browser.

The real-browser baseline is now present. Phase 0 still needs malicious SVG
fixtures immediately before the renderer change and the complete installed-PWA
manual checklist. Phase 1 still needs capability pairing; origin checks alone
do not fully protect a release hosted on a shared GitHub Pages origin.

## Release security model

Knuth is a local development tool, not a Python sandbox. Code the user
explicitly runs is trusted and intentionally has the permissions of the user
running the sidecar. Sandboxing that code by default would break native Python
packages, large local data, and normal filesystem workflows that motivated the
sidecar design.

The release must nevertheless enforce these invariants:

1. Only a paired Knuth app from an explicitly allowed origin can create or
   control a kernel session.
2. No value returned by Python or read from a project folder is interpreted as
   application HTML or JavaScript.
3. Unauthenticated, malformed, or excessive input cannot create processes or
   exhaust the machine without a tight bound.
4. The app and sidecar agree on a versioned protocol and fail closed when they
   are incompatible.
5. A clean reproducibility run either writes complete, deterministic artifacts
   or reports a failure without corrupting the last good contract.

### Assets to protect

- The sidecar's arbitrary-code-execution capability.
- The user's files, credentials, environment, and local network access.
- Browser-held file and directory handles.
- The integrity of `.py` receipts, `values.json`, and generated figures.
- CPU, memory, process count, disk, and browser responsiveness.

### Untrusted inputs

- Every web origin other than the canonical Knuth release and explicit local
  development origins.
- Every WebSocket message until origin and capability checks succeed.
- Document text, stored output receipts, SVG files, and values returned by the
  kernel, even when they came from a folder the user selected.
- Dependency updates and mismatched app/sidecar versions.

Session IDs are routing identifiers, not credentials. Binding the server to
`127.0.0.1` is necessary but not sufficient: arbitrary websites can attempt
cross-site WebSocket connections to loopback services.

## Release blockers

The public release is blocked on the following work:

- Authenticate and authorize the browser-to-sidecar connection before a
  kernel process is created.
- Remove direct insertion of SVG strings with `innerHTML`.
- Add bounded resource and message handling at the protocol boundary.
- Put Python, browser, and security regression tests in CI.
- Add protocol version negotiation so an auto-updated PWA cannot silently
  drive an incompatible installed sidecar.

## Phase 0: freeze current behavior behind tests

Do this first. Security changes to session creation and rendering are likely to
touch the most stateful parts of the product.

1. Convert the executable Python assertion scripts to discoverable `pytest`
   tests and define a `test` optional dependency group.
2. Run the TypeScript format tests, TypeScript build, Python unit tests, and
   WebSocket integration tests in CI. Test at least the oldest and newest
   supported Python versions and the pinned Node version.
3. Add an end-to-end behavior matrix for:
   - first connection and kernel readiness;
   - streaming stdout and stderr;
   - interrupt and restart;
   - reload/resume within the grace period;
   - duplicated-tab session forking;
   - namespace, table, figure, and artifact requests;
   - file open, save, autosave, session restore, and folder attachment.
4. Add browser tests for figure display from both a live kernel and a stored
   `figs/<name>.svg` receipt. Playwright is preferable because DOM/XSS behavior
   cannot be validated reliably in a lightweight DOM emulator.
5. Make test environments deterministic. In particular, create and use a
   writable Matplotlib configuration/cache directory before importing
   Matplotlib. The current runner idempotence test can capture a first-run
   Matplotlib cache warning in the first receipt and not the second; this is the
   byte-stability failure observed during review.
6. Record a short manual smoke-test checklist for the installed PWA and macOS
   launch agent. Keep this checklist until those paths are automated.

Acceptance: all documented test commands use one conventional entry point per
language, CI runs them on every change, and the current working user workflow
passes unchanged.

## Phase 1: secure the localhost control plane

This is the highest-priority implementation phase.

### 1.1 Exact origin enforcement

- Pass an exact production-origin allowlist to `websockets.serve`; reject an
  absent/`null` origin and every unlisted origin during the HTTP upgrade.
- Allow development origins only when the agent is installed or started in an
  explicit development mode. Do not ship a wildcard, broad regular expression,
  or automatic reflection of the request origin.
- Make additional origins an explicit local configuration choice and display
  them in `knuth agent status`.
- Unit-test the production origin, both local development spellings if
  supported, an attacker origin, a lookalike origin, and a missing origin.

Origin checks operate at origin granularity, not URL-path granularity. A
project hosted at `https://USER.github.io/knuth/` shares browser storage and
authority with every other page at `https://USER.github.io`. Before release,
host Knuth on a dedicated canonical origin and configure only that origin in
production.

### 1.2 Pairing capability

Use a second, independent authorization layer rather than relying only on
`Origin`:

- Generate a cryptographically random 256-bit agent capability during install.
- Store it in the platform-appropriate application-support directory with
  owner-only permissions. Never put it in the launchd plist, command line,
  process listing, URL, logs, repository, or app bundle.
- Provide an explicit one-time pairing flow that transfers the capability to
  the dedicated Knuth origin and stores it in origin-scoped browser storage.
  Favor a simple, inspectable first release over a clever automatic exchange.
- Add commands to inspect pairing status and rotate/revoke the capability.
- Compare credentials in constant time. Validate the attach envelope before
  looking up a session, and do not start a subprocess until authorization has
  succeeded.
- Keep session IDs separate from the capability and continue rotating/forking
  them as the app does now.

The pairing UX should be prototyped in a small ADR before implementation. Its
acceptance tests matter more than the exact UI: missing, incorrect, expired, or
rotated credentials must fail without spawning a kernel; a paired app must
retain seamless reload/resume behavior.

### 1.3 Version the handshake

Change `attach`/`attached` to include a protocol version and app/sidecar release
versions. Reject unsupported versions with a specific close code and a useful
UI message. Do not attempt best-effort forwarding between unknown versions.
Document a small compatibility policy, such as one current protocol with an
explicit migration window when it next changes.

### 1.4 Bound the exposed service

Define named, tested constants with conservative but usable defaults for:

- handshake timeout and maximum inbound frame size;
- maximum live sessions and maximum kernels being started concurrently;
- new-session rate;
- maximum queued commands per session;
- maximum stream bytes, result bytes, SVG bytes, table cells, and artifact
  response bytes per request.

The existing table row and column limits are a good pattern. Choose generous
limits, expose intentional overrides through local configuration, and return a
specific truncation or limit error rather than silently disconnecting wherever
possible. Output limits must exist in the kernel/server as well as the UI:
`DocumentView` currently retains the complete streamed string even though it
only displays and persists a truncated form.

Acceptance: a hostile origin, wrong capability, connection flood, oversized
message, malformed JSON value, infinite print loop, and excessive new-session
attempts have bounded effects. Normal large analyses and figures still pass the
behavior matrix.

## Phase 2: make the browser rendering boundary inert

SVG strings currently reach `innerHTML` in the document and session figure
views. Stored figure receipts are hydrated immediately when a folder opens, so
opening a project can currently turn project-controlled SVG into live DOM even
before Python is run.

1. Centralize figure rendering in one small component.
2. Prefer rendering sanitized SVG through a Blob URL in an `<img>` element.
   SVG used as an image is not part of the application's DOM. Revoke old Blob
   URLs when figures are replaced or views are destroyed.
3. Sanitize before creating the Blob as defense in depth. Preserve the static
   Matplotlib subset while removing scripts, event attributes,
   `foreignObject`, JavaScript URLs, and non-local external references.
4. Do not introduce a custom ad hoc sanitizer. Use a maintained sanitizer with
   an SVG profile, pinned through the package lock, and wrap it with Knuth's
   stricter external-reference policy.
5. Inventory every `innerHTML` assignment. Constant application-owned icon and
   toolbar templates may remain temporarily, but mark them as trusted and keep
   all data-derived content on `textContent`/DOM APIs.
6. Add browser exploit fixtures containing `<script>`, event attributes,
   `foreignObject`, `javascript:` links, external images, CSS URLs, and malformed
   SVG. Assert that no script runs, no unexpected network request occurs, and
   ordinary Matplotlib SVGs remain visually correct.

### Browser security policy

Deploy from hosting that can set response headers on the dedicated origin.
Start Content Security Policy in report-only mode, fix violations, then enforce
it. The target policy should have `default-src 'none'`, scripts and fonts from
self, figures from self/blob as needed, exact loopback WebSocket destinations,
`object-src 'none'`, `base-uri 'none'`, and `frame-ancestors 'none'`. CodeMirror
may require a narrowly documented style exception. Also set a no-referrer
policy and a restrictive Permissions Policy.

Do not call a `<meta>` CSP on shared GitHub Pages an equivalent final control;
some important directives are header-only, and the dedicated origin is part of
the authorization design.

Acceptance: all malicious SVG fixtures are inert under an enforced CSP, normal
figures render in both panes and after reload, and browser file/folder features
continue to work.

## Phase 3: make the protocol explicit and resilient

1. Define the protocol once as documented request/response schemas. Validate
   message shape, command, field type, range, and string length on both sides.
   JSON arrays, primitives, unknown commands, missing IDs, and invalid numeric
   values must produce a bounded protocol error rather than an exception.
2. Add correlation IDs to namespace, artifacts, table, figure, and restart
   requests. The current FIFO waiter arrays can resolve the wrong promise when
   requests overlap or responses arrive after a reconnect.
3. Replace `any` in the TypeScript dispatcher with validated discriminated
   unions. Treat every server event as untrusted until parsed.
4. Define state transitions for connecting, authenticating, ready, busy,
   restarting, disconnected, incompatible, and closed. Ensure a stale socket's
   close event cannot tear down a newer connection or create a reconnect storm.
5. Detect unexpected kernel death. Fail pending work, terminate or reap the
   session, tell the client why, and permit an explicit clean restart.
6. Cancel and await pump/reap tasks during restart and shutdown so expected task
   cancellation does not become an unobserved exception.
7. Add structured operational logging for connection decisions, protocol
   version, session counts, limit events, kernel lifecycle, and errors. Never log
   capabilities, full code, output, environment values, or document contents.

Acceptance: concurrency, reconnect races, malformed messages, kernel crashes,
and version mismatch have deterministic tested outcomes, with no unresolved
client promises or orphaned kernels.

## Phase 4: make artifacts deterministic and durable

1. Fix the Matplotlib configuration/cache behavior identified in Phase 0 and
   test first-run and already-warm environments separately.
2. Write runner outputs atomically: create a temporary file in the target
   directory, flush/close it, then replace the destination. Apply this to the
   rewritten document, `values.json`, and SVGs. Preserve the rule that a failed
   analysis leaves the previous complete contract intact.
3. Remove stale generated figures without deleting user-owned files. Maintain a
   small manifest of figure paths Knuth generated during the last successful
   run, delete only previously owned entries missing from the new set, and
   update the manifest last.
4. Apply the same ownership semantics to browser materialization and the CLI
   runner. Add migration behavior for projects that predate the manifest.
5. Validate generated artifact names as single safe filename components even
   though they currently originate from Python identifiers. Test Unicode,
   separators, dot names, collisions, case-insensitive filesystems, and very
   long names.
6. Expand the shared TypeScript/Python golden corpus with newline variants,
   Unicode, malformed markers, output-like source lines, empty documents, and
   randomized parse/serialize round trips.

Acceptance: repeated clean runs are byte-stable in fresh environments, a
simulated interruption never leaves a partial destination file, deleted figure
variables remove only Knuth-owned stale SVGs, and TS/Python format behavior
remains identical.

## Phase 5: dependency, CI, and release hygiene

1. Keep `package-lock.json` authoritative with `npm ci`. Add scheduled audit and
   update automation, with review rather than automatic deployment of major or
   security-sensitive changes.
2. Define supported Python versions and development/test constraints. Keep the
   library's runtime dependency range compatible, but test its lower bound and
   current release and maintain a reproducible contributor/CI lock or
   constraints file.
3. Put NumPy, pandas, and Matplotlib in explicit optional feature/test groups so
   the advertised figure and table workflows are reproducible to install.
4. Add dependency vulnerability scanning for both ecosystems. Pin GitHub
   Actions by immutable commit SHA and review updates through automation.
5. Add lightweight formatting, linting, and static checks: TypeScript linting;
   Python formatting/linting; and gradual Python type checking at the protocol
   and process-management boundaries first.
6. Split pure format tests, unit tests, browser tests, and sidecar integration
   tests in CI so failures are attributable. Run launchd installation tests on
   macOS before release, even if most tests remain on Linux.
7. Add `SECURITY.md` with the trust model, supported versions, disclosure
   channel, response expectations, and the warning that explicitly run Python
   has the user's full permissions. Add a real license file and reconcile stale
   architecture claims across README, DESIGN, KERNEL, and PLAN.
8. Add `knuth doctor` or equivalent diagnostics for app origin, agent version,
   protocol version, pairing state, port conflict, config permissions, Python
   executable, and log location. Redact secrets by construction.

Acceptance: a clean checkout has one documented setup/test path, release builds
are reproducible, dependency changes are visible and reviewed, and a user can
diagnose an app/agent mismatch without inspecting source or logs manually.

## Phase 6: optional defense in depth

These are valuable but should not distract from the release blockers:

- Offer a clearly labeled restricted kernel profile for teaching or reviewing
  untrusted notebooks. It may limit imports, filesystem roots, subprocesses,
  network access, CPU, and memory, but it must be an OS-level isolation design;
  attempting to secure Python by filtering syntax or builtins is not adequate.
- Consider per-install asymmetric pairing keys instead of a bearer capability
  if the simpler pairing flow becomes difficult to rotate or protect.
- Commission an independent security review of the release candidate, focused
  on cross-site loopback access, pairing, CSP/SVG behavior, resource exhaustion,
  launch-agent permissions, and update/version behavior.

## Recommended pull-request sequence

Keep changes small enough to bisect and validate:

1. Test normalization, deterministic Matplotlib environment, and CI coverage.
2. Protocol types/version field with no behavior change.
3. Exact origin rejection and its attack tests.
4. Capability generation, pairing, rotation, and pre-spawn authentication.
5. Session/message/output limits and bounded UI streaming.
6. Central inert SVG renderer and malicious-SVG browser tests.
7. Enforced security headers on the dedicated release origin.
8. Correlation IDs, schema validation, reconnect and kernel-death handling.
9. Atomic artifact writes and generated-artifact ownership manifest.
10. Dependency/release hygiene, diagnostics, and public security documentation.

Each pull request must run the Phase 0 behavior matrix. Avoid combining the
pairing change, renderer change, and protocol refactor in one release: those are
independent security boundaries and should be independently reviewable and
reversible.

## Public-release gate

A public release is ready only when all of these are true:

- An attacker-controlled web origin cannot authenticate, spawn a kernel,
  attach to a session, or influence an existing session.
- Missing, wrong, and rotated credentials fail before process creation.
- Project- and kernel-controlled SVG is inert and CSP is enforced.
- Resource-exhaustion tests demonstrate explicit bounds.
- App/sidecar version mismatch fails closed with a useful recovery path.
- Python, TypeScript, browser, and integration suites are mandatory and green.
- Clean-run artifacts are deterministic, atomic per file, and stale generated
  figures are removed safely.
- The dedicated production origin, agent configuration permissions, security
  documentation, disclosure path, and manual release checklist have been
  reviewed.
- An independent reviewer has attempted the cross-site WebSocket and malicious
  SVG attacks against the release candidate.
