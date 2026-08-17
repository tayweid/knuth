# Public release checklist

The web app is deployed independently from the Python package. A public
release is complete only when the hosted app, protocol version, and PyPI wheel
have passed the same release-candidate tests.

## One-time maintainer setup

1. Create a PyPI account with two-factor authentication.
2. At <https://pypi.org/manage/account/publishing/>, register a pending trusted
   publisher with:

   - PyPI project name: `knuth`
   - GitHub owner: `tayweid`
   - Repository: `knuth`
   - Workflow: `release.yml`
   - Environment: `pypi`

3. In GitHub, create an environment named `pypi` and require your approval for
   deployments from it. Do not create or store a long-lived PyPI API token.
4. Protect `main` and require the deployment workflow to pass before merging.
5. Keep private vulnerability reporting enabled under repository security
   settings.

## Every release

1. Finish the smoke checklist in [DEPLOYMENT.md](./DEPLOYMENT.md) on the release
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
7. Approve the `pypi` environment only after reviewing the build job and its
   pinned workflow actions. PyPI will publish provenance attestations through
   Trusted Publishing.
8. In a clean environment, run:

   ```bash
   python -m pip install knuth
   knuth app --hosted
   ```

9. Confirm the package page, repository links, license, install command,
   automatic pairing, upgrade path, and vulnerability-reporting link.

PyPI releases are immutable. If a release is bad, publish a new version; never
attempt to replace an existing distribution file.
