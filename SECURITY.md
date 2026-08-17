# Security policy

## Supported versions

Knuth is currently pre-release. Security fixes are applied to the latest
commit on `main` and to the production app at `https://knuth.tayweid.io`.
Older commits, cached deployments, and legacy local agents are not supported.
This section will be replaced with a tagged-release support table when Knuth
publishes its first stable release.

## Reporting a vulnerability

Please do not disclose a suspected vulnerability in a public issue,
discussion, pull request, or social-media post.

Use GitHub's **Report a vulnerability** form on the repository's **Security
and quality → Advisories** page. This creates a private report visible to the
maintainer and supports coordinated work on a private fix. If that button is
unavailable, open a public issue containing no vulnerability details and ask
for a private contact channel.

Include, where possible:

- the affected commit, deployment, app version, and agent version;
- operating system and browser versions;
- a minimal reproduction using non-sensitive test data;
- the security impact and the boundary an attacker must cross;
- whether the issue reaches the localhost agent or a kernel process; and
- any suggested mitigation.

Never include a pairing capability, credential, private file, environment
value, or other secret in a report. Revoke a capability immediately with
`knuth agent rotate-token` if it may have been exposed.

`knuth app --hosted` places only a five-minute, single-use bootstrap token in
the URL fragment and removes it from the address bar as soon as the app loads.
The durable per-install capability is transferred over the authenticated
loopback channel and must never appear in a URL, log, issue, or screenshot.

The maintainer will make a best effort to acknowledge a report within seven
days, provide an initial assessment within fourteen days, and coordinate the
timing of any public disclosure. These targets may change with the severity
and complexity of the report. Knuth does not currently operate a bug-bounty
program.

## Security model and scope

Knuth's local agent intentionally executes Python selected by the user with
the permissions of that user. It is a local development tool, not a Python
sandbox. A report that only demonstrates that explicitly executed Python can
read files, start processes, access the network, or inspect the environment is
therefore out of scope.

Examples of issues that are in scope include:

- controlling the local agent without both an allowed origin and a valid
  pairing capability;
- cross-site WebSocket, session-isolation, or capability-handling failures;
- causing code to execute without the user's explicit run action;
- script execution or external requests from documents, outputs, figures, or
  other project-controlled content;
- unauthorized access to browser file or directory handles;
- unsafe path handling or unintended file modification by Knuth itself;
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
