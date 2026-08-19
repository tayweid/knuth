# Public release checklist

The app ships inside the Python package: the engine serves the built
frontend from `python/knuth/web/` on its own port
([SAME_ORIGIN.md](./SAME_ORIGIN.md)), so app and engine release as one
artifact and cannot skew. GitHub Pages separately hosts a read-only demo at
`https://knuth.tayweid.io`. A public release is complete only when the
wheel, protocol version, and GitHub release distributions have passed the
same release-candidate tests.

## One-time maintainer setup

1. Protect `main` and require the deployment workflow to pass before merging.
2. Keep private vulnerability reporting enabled under repository security
   settings.
3. Do not add package-registry credentials. The release workflow uses the
   repository-scoped GitHub token only to attach built distributions to the
   matching GitHub release.

### One-time GitHub Pages and DNS setup (the hosted demo)

Do these in order. GitHub recommends attaching the domain to the repository
before publishing its DNS record, which prevents another Pages repository
from claiming an unbound subdomain.

1. Optionally but preferably verify `tayweid.io` under GitHub account
   **Settings → Pages → Add a domain** and retain GitHub's TXT record in DNS.
2. In the `knuth` repository, open **Settings → Pages** and set **Custom
   domain** to `knuth.tayweid.io`.
3. At the DNS provider for `tayweid.io`, create a `CNAME` record with name
   `knuth` and target `tayweid.github.io` — no protocol, path, or `/knuth`
   suffix, and no wildcard record.
4. Wait for the Pages DNS check and TLS certificate, then enable **Enforce
   HTTPS** in the repository's Pages settings.
5. Confirm that `https://tayweid.github.io/knuth/` redirects to
   `https://knuth.tayweid.io/` and that the latter loads over HTTPS.

## Every release

1. Run the local gates on the release commit:

   ```bash
   npm ci
   npm audit --audit-level=high
   npm run check:web
   npm test
   npm run test:browser
   npm run build
   .venv/bin/python -m pytest python/tests
   .venv/bin/python -m pip install pip-audit==2.10.1
   .venv/bin/python -m pip_audit -r python/requirements-audit.txt
   ```

   GitHub Actions runs the same freshness, frontend, browser, build, and
   Python gates (including a wheel install smoke test) before publishing the
   Pages artifact.

2. Run the release smoke test on the release commit:

   1. Build and install the wheel in a clean Python 3.11+ virtual
      environment.
   2. Run `knuth app`. Confirm it starts the engine, opens
      `http://127.0.0.1:5197`, and reaches **kernel** — no pairing, no
      token, nothing to configure.
   3. Run a harmless cell, interrupt a loop, restart the kernel, reload
      within the grace period, and confirm the session pane and a figure
      still work.
   4. Stop the engine and confirm the app reports it plainly; start it
      again and confirm the app reconnects on its own.
   5. Repeat the launch and interrupt checks on macOS, Windows, and Linux.
   6. Install the PWA from the local origin, launch it independently,
      double-click a `.py` file, and repeat the stop/start cycle.
   7. On macOS, separately verify `knuth agent install`, `status`,
      `restart`, and `uninstall`.

3. Replace the development version in `python/pyproject.toml` with the
   intended release version, for example `2.0.0rc1` or `2.0.0`. Update the
   npm version and the supported-version table in
   [SECURITY.md](./SECURITY.md) to match.
4. Commit and push. Wait for the Pages deployment and verify the demo
   domain before publishing the package.
5. Create a GitHub release whose tag is exactly `v` plus the Python package
   version. Publishing that release starts `.github/workflows/release.yml`.
   The workflow refuses development versions and mismatched tags.
6. Review the workflow result and confirm that its wheel and source archive
   are attached to the GitHub release.
7. In a clean environment, install the attached wheel and run:

   ```bash
   python -m pip install https://github.com/tayweid/knuth/releases/download/v2.0.0/knuth-2.0.0-py3-none-any.whl
   knuth app
   ```

8. Confirm the release assets, repository links, license, install command,
   upgrade path, and vulnerability-reporting link. Also verify that the
   hosted demo's onboarding command contains the commit deployed by the
   successful Pages workflow.

Treat published tags and release assets as immutable. If a release is bad,
publish a new version; never replace an existing distribution file.

## Stable-release response-header gate (the hosted demo)

GitHub Pages does not provide repository-configurable HTTP response headers.
The demo therefore enforces what it can through a meta CSP (`index.html`)
and refuses to initialize inside a frame at runtime. Before calling a
release stable, serve the same static `dist/` artifact from, or proxy it
through, a provider that can add at least:

```text
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' blob: data:; connect-src 'self' blob:; manifest-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
X-Content-Type-Options: nosniff
```

(`frame-ancestors` is header-only, which is exactly why the meta CSP cannot
carry it.) Keep the public URL exactly `https://knuth.tayweid.io`; changing
the origin also changes browser storage. Verify the deployed headers with
`curl -I https://knuth.tayweid.io/` and rerun the browser suite through the
final host.
