# Knuth — the engine serves the app

Design notes from a working session (2026-08-17), after a day spent debugging
pairing rather than using the workbench. Supersedes DEPLOYMENT.md where they
conflict: the hosted PWA stays as a demo, but the app you actually use is
served by the engine that runs your code.

## Why: the origin split is where the bugs live

The version that worked (`d9878ae`) had **zero** occurrences of `capability`,
`pairing`, or `origin` in `server.py`. The handshake was `attach{session}`.
Nothing could refuse you. Ten commits later that file has 47, and the engine
can turn a browser away six different ways — bad origin, protocol mismatch,
missing capability, expired pairing token, session cap, kernel start failure
— which surface as four messages, two of them indistinguishable from "it is
broken."

None of that complexity is about executing Python. All of it exists because
the page comes from `knuth.tayweid.io` and the engine listens on
`127.0.0.1`. A remote page cannot read a local file, so a secret has to hop
CLI → browser storage, and every hop is a failure. The three bugs found on
2026-08-17 were all hops:

- the launcher opened the PWA's app shim, which silently drops the URL
  fragment carrying the token (`abe5fcd`);
- it could not tell delivery had failed, because `open` exits 0 either way;
- one rejected socket deleted the shared capability, unpairing every window
  and every future double-click, recoverable only from a terminal.

Jupyter has the same token problem and a far easier version of it, because
Jupyter serves its own UI. That is the whole idea here.

DECIDED: the fix is not more hardening of the hop. It is deleting the hop.

## The shape

`knuth serve` binds `127.0.0.1:5197` and answers both protocols on that one
port:

- `GET /` → `index.html` from the installed package
- `GET /assets/*`, `/manifest.webmanifest`, `/sw.js`, `/icons/*` → package data
- WebSocket upgrade on the same port → today's kernel protocol, unchanged

The `websockets` library already supports this: `serve(process_request=...)`
returns an HTTP `Response` for non-upgrade requests and `None` to let the
handshake proceed (verified against websockets 17.0.1, the pinned version).
No aiohttp, no starlette, no second port. `websockets` remains the single
runtime dependency.

DECIDED: one port, one origin, one dependency. A second port would recreate
the split we are removing.

## Security: what actually protects the engine

The engine executes arbitrary Python, so the question is who may open the
socket. Three things answer it, and only one of them needs to exist:

1. **Bind to loopback.** Nothing off this machine can reach the port.
2. **Exact Origin check on the upgrade.** Browsers set `Origin` themselves
   and a page cannot forge it, so `evil.example` cannot open the kernel
   socket even though it can reach the port. This is the real defense
   against the realistic threat, and it survives unchanged.
3. **A shared secret.** Today this is the durable capability, and it is the
   entire source of our pain.

Once the page and the engine share an origin, the third item earns much less
than it costs. A malicious page can issue a no-cors `GET` at the engine but
cannot read the response, so it cannot lift a token the server hands out. A
non-browser local process *can* read it — but a process running as you can
run `python` directly, so the token protects nothing it could not already
have.

DECIDED: the durable, on-disk capability goes away. It exists only to be
carried across origins.

OPEN: whether to keep a per-process token, minted at startup, injected into
`index.html`, and echoed in `attach`. It buys defense in depth against a
future bug in the origin check, and it costs almost nothing now that the
server serving the page is the server holding the secret — no file, no
`localStorage`, no URL fragment, no delivery to confirm. The important
property either way: **a rejected client can always re-fetch what it needs
over the same origin**, so "unpaired forever" stops being a reachable state.

INVARIANT to hold: the HTTP surface is read-only static assets. Every
state-changing or code-executing path goes through the origin-checked
WebSocket. A cross-origin page can blindly issue GETs; it must never be able
to cause an effect with one.

## What this deletes

Files that exist mostly to move a secret between origins:

| File | Lines |
|---|---|
| `python/knuth/hosted.py` (delivery machinery) | 302 |
| `python/knuth/config.py` (capability file) | 128 |
| `python/tests/test_hosted.py` | 246 |
| `python/tests/test_config.py` | 58 |

Plus the pairing lines threaded through files that stay: `server.py` (50),
`src/kernel/kernel.ts` (56), `agent.py` (9), `onboarding.ts` (4).

A launcher still exists — something must start the engine and open a window
— but it becomes "start the server, open `http://127.0.0.1:5197`." No
bundle-id lookup, no delivery routes, no `pairing_status`, no confirmation
loop, no `PairingBroker`, no `#pair=` fragment, no storage listener, no
pairing retry, and no `unauthorized` / `pairing_expired` states in the UI.

Two of the six refusal paths survive: the session cap and kernel start
failure. Both should say what they are instead of both saying "Python engine
unavailable" — that is worth fixing regardless of this design.

## Packaging and version skew

The built frontend ships inside the wheel as package data (`knuth/web/`).
`npm run build` output is copied there by the release workflow, which already
exists for release assets (`c15562c`). Users install a wheel; nobody needs
Node to run Knuth.

The happy consequence: **app and engine ship as one artifact and cannot
disagree.** `PROTOCOL_VERSION` stays as a cheap assertion but should never
fire again, and the "Update the local engine" wall becomes unreachable in
normal use. Today the hosted app and a stale local engine skew routinely.

OPEN: whether built assets are committed to the repo or produced only in CI
and attached to a release. CI-only keeps the diffs clean; committed keeps
`pip install` from a bare GitHub archive working, which is what the install
command does today.

## The dev loop

Neither pip nor Pages belongs in the inner loop:

- `pip install -e python` — the engine runs from source; a restart picks up
  edits.
- `npm run dev` — vite at `127.0.0.1:5198` with HMR, unchanged.

To keep dev same-origin too, vite proxies the WebSocket to the engine, so the
dev page talks to `127.0.0.1:5198` for everything. That deletes
`DEVELOPMENT_ORIGINS` and, more importantly, means dev and production
exercise the same code path instead of dev being the one place cross-origin
still happens.

Measured for reference, so the shipping choice is made on numbers: a pip
install from a GitHub archive is **1.8s cold, 1.4s warm** (845 KB, pure
Python, one dependency). A Pages deploy is minutes. pip is faster per update;
Pages is hands-off and reaches every machine at once. Neither matters during
development.

## The PWA still works — measured, not assumed

A spike on 2026-08-17 installed a PWA from `http://127.0.0.1:5199` and
double-clicked a file registered through `file_handlers`:

| Question | Result |
|---|---|
| Installable from a localhost origin | yes — `standalone=true` |
| `file_handlers` registers with macOS | yes — double-click launched the app |
| File delivered via `launchQueue` | yes — name and size received |
| Contents readable | yes |
| **All of the above with the server stopped** | **yes** |

The last row matters most. The service worker serves the shell and the file
handle comes from the OS, not the server, so a double-click opens the app and
shows the file even when the engine is not running. The window can then say
"start the engine" — the behavior we have today, without the origin split.

Consequences to design around:

- **The port is the app's identity.** `http://127.0.0.1:5197` *is* the
  installed app. A port collision does not degrade it; it makes it a
  different app that needs reinstalling. The engine should own 5197 firmly
  and fail loudly rather than silently drifting to another port.
- **`.py` is contested.** Only one installed app can be the default handler.
  If the hosted build stays installable, it competes with the local one for
  every double-click.

DECIDED: the hosted build stays as a **demo** — readable, runnable against
nothing, not installable. One installable app, served locally.

## Migration

Each step is shippable on its own; the app keeps working throughout.

1. **Serve assets from the engine.** `process_request` + package data. The
   app still pairs exactly as it does today. Verifies the serving path in
   isolation.
2. **Same-origin handshake.** Origin check only (plus the optional injected
   token). Delete `PairingBroker`, `pairing_status`, `config.py`, the
   delivery machinery, and the pairing states in `kernel.ts` and
   `onboarding.ts`.
3. **Package the frontend** into the wheel; update the install command; drop
   the Pages build to demo-only.
4. **Install locally as a PWA**, confirm `.py` handlers and the offline
   shell against the real app rather than the spike.
5. **Message the two remaining refusals** properly — session cap and kernel
   start failure stop sharing a screen.

## Risks

- **Stale service worker after an upgrade.** `pip install --upgrade` changes
  the assets under a cache the browser controls. The worker is already
  network-first, which mostly handles it; the cache name should include the
  package version so an upgrade cannot be served an old shell offline.
- **The engine must own its port.** Covered above; needs a real error path,
  not a fallback port.
- **Losing the zero-install story.** Anyone wanting to try Knuth now installs
  Python first. The hosted demo softens this but does not replace it. This is
  the genuine cost of the design and it should be taken deliberately.
- **One more thing to get right at release time**: the wheel now carries a
  frontend build. A release that forgets to rebuild ships a stale UI with a
  current engine — the skew we just eliminated, reintroduced through the
  build. The release workflow must build assets, not copy whatever is in the
  working tree.

## Open questions

- Keep a per-process token, or origin check alone? (See Security.)
- Built assets committed, or CI-only release artifacts? (See Packaging.)
- Does the launchd agent survive? It solves "engine not running when you
  double-click a file," which the offline shell now handles gracefully but
  does not fix. Serving assets from the agent makes it more useful, not less.
- What happens to `knuth agent pair` and `rotate-token` — both are pairing
  verbs with nothing left to pair.
