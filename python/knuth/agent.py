"""Background service management: `knuth agent install` registers the
kernel server as a macOS launchd user agent — started at login, restarted
if it dies — so the app always finds a kernel without a terminal in sight.

The plist points at the current interpreter (sys.executable), so it
survives shell PATH changes but must be reinstalled if the venv moves.
"""

import os
import plistlib
import subprocess
import sys
from pathlib import Path

LABEL = "com.claerbout.knuth"
PLIST = Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"
LOG = Path.home() / "Library" / "Logs" / "knuth.log"


def _domain():
    return f"gui/{os.getuid()}"


def _launchctl(*args):
    return subprocess.run(["launchctl", *args], capture_output=True, text=True)


def install(port):
    if sys.platform != "darwin":
        print("knuth agent currently supports macOS (launchd) only")
        return 1
    uninstall(quiet=True)
    PLIST.parent.mkdir(parents=True, exist_ok=True)
    plist = {
        "Label": LABEL,
        "ProgramArguments": [sys.executable, "-m", "knuth", "serve", "--port", str(port)],
        "RunAtLoad": True,
        "KeepAlive": True,
        "StandardOutPath": str(LOG),
        "StandardErrorPath": str(LOG),
    }
    with open(PLIST, "wb") as f:
        plistlib.dump(plist, f)
    result = _launchctl("bootstrap", _domain(), str(PLIST))
    if result.returncode != 0:
        print(f"launchctl bootstrap failed: {result.stderr.strip()}")
        return 1
    # bootstrap registers the job; RunAtLoad only fires at login. Start now.
    _launchctl("kickstart", f"{_domain()}/{LABEL}")
    print(f"Installed {LABEL}: kernel server on ws://127.0.0.1:{port}")
    print(f"Runs at login, restarts on exit. Log: {LOG}")
    return 0


def uninstall(quiet=False):
    _launchctl("bootout", f"{_domain()}/{LABEL}")
    existed = PLIST.exists()
    PLIST.unlink(missing_ok=True)
    if not quiet:
        print(f"Removed {LABEL}" if existed else f"{LABEL} was not installed")
    return 0


def status():
    result = _launchctl("print", f"{_domain()}/{LABEL}")
    if result.returncode != 0:
        print(f"{LABEL}: not installed (knuth agent install)")
        return 1
    state = next(
        (line.strip() for line in result.stdout.splitlines() if "state =" in line),
        "state unknown",
    )
    print(f"{LABEL}: installed, {state}. Log: {LOG}")
    return 0
