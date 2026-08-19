# Knuth Python engine

Knuth is a computation workbench: an installable web interface over a real,
local Python session. Documents use the plain Python percent format and remain
compatible with Python, VS Code, Spyder, PyCharm, and other tools.

Install and launch:

```bash
python -m pip install --force-reinstall "knuth @ https://github.com/tayweid/knuth/archive/refs/heads/main.zip#subdirectory=python"
knuth app
```

The launcher starts the engine on `127.0.0.1`, which serves the app itself
and opens it in the browser — the page and the kernel socket share one
origin, so no credential ever travels and there is nothing to pair. Only the
engine's own origin and explicitly configured development origins can open
the kernel socket.

Knuth intentionally executes Python selected by the user with that user’s
permissions. It is a local development tool, not a Python sandbox. See the
[repository](https://github.com/tayweid/knuth) for documentation, source,
security policy, and license.
