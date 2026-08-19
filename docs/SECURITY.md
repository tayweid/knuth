# Security policy

## Supported versions

Knuth is currently pre-release. Security fixes are applied to the latest
commit on `main`. The app in actual use is served by the local engine at
`http://127.0.0.1:5197`; the hosted page at `https://knuth.tayweid.io` is a
demo. Older commits, cached deployments, and legacy local engines are not
supported. This section will be replaced with a tagged-release support table
when Knuth publishes its first stable release.

## Reporting a vulnerability

Please do not disclose a suspected vulnerability in a public issue,
discussion, pull request, or social-media post.

Use GitHub's **Report a vulnerability** form on the repository's **Security
and quality → Advisories** page. This creates a private report visible to the
maintainer and supports coordinated work on a private fix. If that button is
unavailable, open a public issue containing no vulnerability details and ask
for a private contact channel.

Include, where possible:

- the affected commit, app version, and engine version;
- operating system and browser versions;
- a minimal reproduction using non-sensitive test data;
- the security impact and the boundary an attacker must cross;
- whether the issue reaches the localhost engine or a kernel process; and
- any suggested mitigation.

Never include a private file, environment value, or other secret in a
report. The current design holds no secret to leak — no pairing capability
or token exists; the engine authorizes browsers by exact `Origin` on a
loopback socket (see [SAME_ORIGIN.md](./SAME_ORIGIN.md)).

The maintainer will make a best effort to acknowledge a report within seven
days, provide an initial assessment within fourteen days, and coordinate the
timing of any public disclosure. These targets may change with the severity
and complexity of the report. Knuth does not currently operate a bug-bounty
program.

## Security model and scope

Knuth's local engine intentionally executes Python selected by the user with
the permissions of that user. It is a local development tool, not a Python
sandbox. A report that only demonstrates that explicitly executed Python can
read files, start processes, access the network, or inspect the environment is
therefore out of scope.

What protects the engine ([SAME_ORIGIN.md](./SAME_ORIGIN.md)): it binds to
`127.0.0.1` and serves the app itself, and the WebSocket upgrade requires an
exactly allowed `Origin`, which a page cannot forge. There is no capability
file and no pairing token; nothing secret travels to a browser. The HTTP
surface is read-only static assets — every state-changing or code-executing
path goes through the origin-checked WebSocket.

Invariants a release must hold:

1. Only a page from an explicitly allowed origin can create or control a
   kernel session.
2. No value returned by Python or read from a project folder is interpreted
   as application HTML or JavaScript.
3. Malformed or excessive input cannot create processes or exhaust the
   machine without a tight bound.
4. The app and engine agree on a versioned protocol and fail closed when
   they are incompatible.
5. A clean reproducibility run either writes complete, deterministic
   artifacts or reports a failure without corrupting the last good contract.

### Assets to protect

- The engine's arbitrary-code-execution capability.
- The user's files, credentials, environment, and local network access.
- Browser-held file and directory handles.
- The integrity of `.py` receipts, `values.json`, and generated figures.
- CPU, memory, process count, disk, and browser responsiveness.

### Untrusted inputs

- Every web origin other than the engine's own and explicitly configured
  development origins.
- Every WebSocket message until the origin check succeeds.
- Document text, stored output receipts, SVG files, and values returned by
  the kernel, even when they came from a folder the user selected.
- Dependency updates and mismatched app/engine versions.

Session IDs are routing identifiers, not credentials. Binding the server to
`127.0.0.1` is necessary but not sufficient: arbitrary websites can attempt
cross-site WebSocket connections to loopback services — the exact-Origin
check on the upgrade is the control.

Examples of issues that are in scope include:

- controlling the local engine from a disallowed origin;
- cross-site WebSocket or session-isolation failures;
- causing code to execute without the user's explicit run action;
- script execution or external requests from documents, outputs, figures, or
  other project-controlled content;
- unauthorized access to browser file or directory handles;
- unsafe path handling or unintended file modification by Knuth itself,
  including escaping the packaged-asset directory over HTTP;
- resource exhaustion reachable before trusted Python execution; and
- dependency, build, deployment, or update-chain compromise.

## Safe testing

Test only against systems and data you own or are authorized to use. Avoid
privacy violations, service disruption, destructive actions, persistence, and
access to data beyond what is necessary to demonstrate the issue. Stop and
report promptly if sensitive data is encountered. Good-faith research that
follows this policy will not be intentionally pursued as an attack on the
project.

After a report is validated, remediation and disclosure will be coordinated
through a private GitHub security advisory. A CVE and public advisory may be
issued when appropriate.
