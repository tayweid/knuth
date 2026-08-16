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

## No-downtime app and agent cutover

The app and agent changes are deliberately compatible with the currently
running legacy agent. Follow this order after the custom domain serves the
updated build:

1. Finish or save any live computation. The final agent restart clears its
   in-memory Python session.
2. Open `https://knuth.tayweid.io/` in Chrome and install it as a PWA.
3. Run `.venv/bin/knuth agent pair` in the repository. Copy the displayed
   capability.
4. In the new PWA, click the **kernel** status label and paste the capability.
   The legacy agent ignores the additional credential, so the app remains
   usable before cutover.
5. Run `.venv/bin/knuth agent restart`. The restarted server now enforces the
   dedicated origin, protocol version, and capability.
6. Reload the new PWA. Confirm the status returns to **kernel**, run a harmless
   cell, restart the kernel from the toolbar, and confirm the session pane and
   a figure still work.
7. Remove the old `tayweid.github.io/knuth/` PWA installation once the new one
   handles `.py` files correctly.

If pairing fails, run `.venv/bin/knuth agent pair` again and replace the value
by clicking the kernel status. `knuth agent rotate-token` revokes all paired
browsers and restarts an installed launch agent.

## Release checks

```bash
npm ci
npm audit --audit-level=high
npm test
npm run test:browser
npm run build
.venv/bin/python -m pytest python/tests
```

GitHub Actions runs the same frontend, browser, build, and Python gates before
publishing the Pages artifact.
