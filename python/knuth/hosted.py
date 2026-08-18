"""Start the engine and open the app it serves.

There is nothing to pair. The engine serves the page on its own port, so
"launch" is: make sure something is listening, then point a browser at it.
Everything this module used to do — finding the browser that installed a
PWA, delivering a token through a URL fragment, confirming that delivery
actually happened — existed only because the page came from somewhere else.
See SAME_ORIGIN.md.
"""

import asyncio
import socket
import subprocess
import sys
import time
import webbrowser

from . import agent, state
from .server import GRACE_SECONDS, build_stamp, main as serve_main

ASKED_KEY = "asked-about-login-agent"
BROWSER_KEY = "browser"

# The default browser is the right default, but it is not always where the
# app can be installed — installing a PWA is a browser feature and they do
# not all offer it. So the choice is settable, and remembered.
MACOS_BUNDLE_IDS = {
    "chrome": "com.google.Chrome",
    "arc": "company.thebrowser.browser",
    "edge": "com.microsoft.edgemac",
    "brave": "com.brave.Browser",
    "safari": "com.apple.Safari",
    "firefox": "org.mozilla.firefox",
}


def app_url(port):
    return f"http://127.0.0.1:{port}/"


def open_in(url, browser=None):
    """Open url in the named browser, or the system default. True if opened."""
    if browser and browser != "default":
        if sys.platform == "darwin":
            target = MACOS_BUNDLE_IDS.get(browser.lower())
            flag = "-b" if target else "-a"
            try:
                result = subprocess.run(
                    ["open", flag, target or browser, url],
                    capture_output=True,
                    timeout=10,
                )
            except (OSError, subprocess.SubprocessError):
                return False
            return result.returncode == 0
        try:
            return webbrowser.get(browser).open(url)
        except webbrowser.Error:
            return False
    return webbrowser.open(url)


def _port_is_taken(port):
    """Whether something already listens on the loopback port."""
    with socket.socket() as probe:
        return probe.connect_ex(("127.0.0.1", port)) == 0


def _restart_if_stale(port):
    """Restart a long-lived engine that is still serving pre-upgrade code.

    pip replaces files; it does not restart processes. An engine that has
    been up since before an upgrade keeps serving what it booted with, and
    the symptoms of that are baffling — in the worst case a page request
    reaching an engine that predates static serving entirely. Compare what
    it is running against what is on disk and fix it rather than report it.
    """
    from .doctor import _engine_status

    try:
        status = asyncio.run(_engine_status(port))
    except (RuntimeError, OSError):
        return False
    if not status:
        return False
    running = status.get("build")
    if not running or running == build_stamp():
        return False
    if agent.is_installed():
        return agent.restart() == 0
    print()
    print("The engine on this port started before the installed code changed,")
    print("so it is still serving the old version. Stop it (Ctrl-C in its")
    print("terminal) and run `knuth app` again.")
    return False


def _offer_login_agent(port):
    """Ask once whether to keep the engine running at login.

    Returns True when the agent now owns the engine, so the caller should not
    start a second one.

    Double-clicking a .py opens the app but cannot start the engine — a page
    cannot launch a program. The agent is what makes that work, so the only
    moment worth asking is the first time someone starts Knuth. Asking twice
    would be nagging; never asking leaves a broken double-click the user has
    no way to diagnose.
    """
    if sys.platform != "darwin" or state.get(ASKED_KEY):
        return False
    if agent.is_installed():
        state.set(ASKED_KEY, True)
        return False
    if not (sys.stdin and sys.stdin.isatty()):
        return False

    print()
    print("Keep Knuth running in the background, so double-clicking a .py file")
    print("opens it without starting Knuth first?")
    try:
        answer = input("[Y/n] ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        print()
        return False
    state.set(ASKED_KEY, True)
    if answer not in ("", "y", "yes"):
        print("Skipped. Run `knuth agent install` later if you change your mind.")
        return False
    if agent.install(port) != 0:
        return False
    # The agent is the engine now; this command has nothing left to serve.
    deadline = time.monotonic() + 10
    while not _port_is_taken(port) and time.monotonic() < deadline:
        time.sleep(0.1)
    return True


def run_hosted(port=5197, grace=GRACE_SECONDS, *, open_browser=True, browser=None):
    """Serve the app and keep the engine in the foreground.

    If an engine already owns the port, this just opens the app against it
    and returns; the running one keeps serving.
    """
    url = app_url(port)
    if browser:
        state.set(BROWSER_KEY, browser)
    chosen = browser or state.get(BROWSER_KEY)

    def show(url):
        if not open_browser:
            print(f"The app is at {url}")
        elif open_in(url, chosen):
            where = f" in {chosen}" if chosen and chosen != "default" else ""
            print(f"Opening {url}{where}")
        else:
            print(f"Could not open {chosen or 'a browser'} automatically. Open {url}")

    if _port_is_taken(port):
        if _restart_if_stale(port):
            print("The running engine was older than the installed one; restarted it.")
        else:
            print(f"Using the Knuth engine already running on port {port}.")
        show(url)
        return 0

    # Asked before anything is serving: input() must never block the event
    # loop, and an accepted agent takes this port for itself.
    if _offer_login_agent(port):
        show(url)
        return 0

    def ready():
        show(url)
        print("The Python engine is running locally. Press Ctrl-C to stop it.")

    try:
        serve_main(port, grace, on_ready=ready)
    except OSError as exc:
        print(f"Knuth could not bind the local engine on port {port}: {exc}")
        return 1
    return 0
