# Public release checklist

The web app is deployed independently from the Python package. A public
release is complete only when the hosted app, protocol version, and GitHub
release distributions have passed the same release-candidate tests.

## One-time maintainer setup

1. Protect `main` and require the deployment workflow to pass before merging.
2. Keep private vulnerability reporting enabled under repository security
   settings.
3. Do not add package-registry credentials. The release workflow uses the
   repository-scoped GitHub token only to attach built distributions to the
   matching GitHub release.

## Every release

1. Finish the smoke checklist in [DEPLOYMENT.md](../DEPLOYMENT.md) on the release
   commit, including macOS, Windows, and Linux.
2. Complete the stable-release response-header gate in `DEPLOYMENT.md`, or
   explicitly label the release as a prerelease while it remains on bare
   GitHub Pages.
3. Run the local gates:

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

4. Replace the development version in `python/pyproject.toml` with the intended
   release version, for example `2.0.0rc1` or `2.0.0`. Update the npm version
   and supported-version table in `SECURITY.md` to match.
5. Commit and push. Wait for the Pages deployment and verify the canonical
   domain before publishing the package.
6. Create a GitHub release whose tag is exactly `v` plus the Python package
   version. Publishing that release starts `.github/workflows/release.yml`.
   The workflow refuses development versions and mismatched tags.
7. Review the workflow result and confirm that its wheel and source archive are
   attached to the GitHub release.
8. In a clean environment, install the attached wheel and run:

   ```bash
   python -m pip install https://github.com/tayweid/knuth/releases/download/v2.0.0/knuth-2.0.0-py3-none-any.whl
   knuth app --hosted
   ```

9. Confirm the release assets, repository links, license, install command,
   automatic pairing, upgrade path, and vulnerability-reporting link. Also
   verify that the hosted onboarding command contains the commit deployed by
   the successful Pages workflow.

Treat published tags and release assets as immutable. If a release is bad,
publish a new version; never replace an existing distribution file.
