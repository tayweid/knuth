# Secure GitHub Pages deployment

Knuth's canonical production origin is `https://knuth.tayweid.io`. GitHub
Pages still hosts the static app from this repository; the custom hostname
gives its browser storage and localhost-kernel authority an origin that is not
shared with other `tayweid.github.io` projects.

## One-time GitHub and DNS setup

Do these in order. GitHub recommends attaching the domain to the repository
before publishing its DNS record, which prevents another Pages repository from
claiming an unbound subdomain.

1. Optionally but preferably verify `tayweid.io` under GitHub account
   **Settings → Pages → Add a domain** and retain GitHub's TXT record in DNS.
2. In the `knuth` repository, open **Settings → Pages** and set **Custom
   domain** to `knuth.tayweid.io`.
3. At the DNS provider for `tayweid.io`, create this record:

   ```text
   Type:   CNAME
   Name:   knuth
   Target: tayweid.github.io
   ```

   The target has no protocol, path, or `/knuth` suffix. Do not use a wildcard
   DNS record.
4. Wait for the Pages DNS check and TLS certificate. DNS can take up to 24
   hours to propagate, although it is often much faster.
5. Enable **Enforce HTTPS** in the repository's Pages settings.
6. Confirm that `https://tayweid.github.io/knuth/` redirects to
   `https://knuth.tayweid.io/` and that the latter loads over HTTPS.

References:

- [Managing a custom domain for GitHub Pages](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site)
- [Verifying a GitHub Pages custom domain](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/verifying-your-custom-domain-for-github-pages)
- [Securing a GitHub Pages site with HTTPS](https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https)

## Hosted-launcher release smoke test

Run this checklist against every release candidate after the custom domain
serves the updated build:

1. Build and install the wheel in a clean Python 3.11+ virtual environment.
2. Open `https://knuth.tayweid.io/` with no engine running. Confirm the
   onboarding card selects the correct operating system and its PWA install
   action appears when the browser offers installation.
3. Run `knuth app --hosted`. Confirm it opens the canonical domain, removes the
   `#pair=…` fragment immediately, reaches **kernel**, and does not print or
   persist either pairing secret.
4. Run a harmless cell, interrupt a loop, restart the kernel, reload within
   the grace period, and confirm the session pane and a figure still work.
5. Close the foreground command and confirm the app reports the unavailable
   engine, then rerun it and confirm automatic reconnection.
6. Repeat the launcher and interrupt checks on macOS, Windows, and Linux.
7. Install the PWA, launch it independently, and repeat the stop/start cycle.
8. On macOS, separately verify `knuth agent install`, `status`, `restart`,
   automatic pairing through `knuth app --hosted`, and `uninstall`.

If automatic pairing fails, run `knuth agent pair` and use the app's manual
Pair action. `knuth agent rotate-token` revokes all paired browsers and
restarts an installed macOS launch agent.

## Release checks

```bash
npm ci
npm audit --audit-level=high
npm test
npm run test:browser
npm run build
.venv/bin/python -m pytest python/tests
.venv/bin/python -m pip install pip-audit==2.10.1
.venv/bin/python -m pip_audit -r python/requirements-audit.txt
```

GitHub Actions runs the same frontend, browser, build, and Python gates before
publishing the Pages artifact.

## Stable-release response-header gate

GitHub Pages does not provide repository-configurable HTTP response headers.
Knuth therefore enforces the directives GitHub Pages can support through a
meta CSP and refuses to initialize inside a frame at runtime. Before calling a
release stable, serve the same static `dist/` artifact from, or proxy it
through, a provider that can add at least:

```text
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' blob: data:; connect-src 'self' blob: ws://127.0.0.1:5197; manifest-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
X-Content-Type-Options: nosniff
```

Keep the public URL exactly `https://knuth.tayweid.io`; changing the origin
also changes browser storage and the sidecar authorization boundary. Verify
the deployed headers with `curl -I https://knuth.tayweid.io/` and rerun the
browser suite through the final host.
