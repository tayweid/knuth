# Knuth Python engine

Knuth is a computation workbench: an installable web interface over a real,
local Python session. Documents use the plain Python percent format and remain
compatible with Python, VS Code, Spyder, PyCharm, and other tools.

Install and launch the hosted app:

```bash
python -m pip install knuth
knuth app --hosted
```

The launcher starts the engine on `127.0.0.1`, opens
[`knuth.tayweid.io`](https://knuth.tayweid.io), and transfers a short-lived,
single-use pairing token through the URL fragment. The durable per-install
capability never appears in the URL. Only the exact production origin and
explicitly configured development origins can connect.

Knuth intentionally executes Python selected by the user with that user’s
permissions. It is a local development tool, not a Python sandbox. See the
[repository](https://github.com/tayweid/knuth) for documentation, source,
security policy, and license.
