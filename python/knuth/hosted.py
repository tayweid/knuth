"""Start the engine and open the app it serves.

There is nothing to pair. The engine serves the page on its own port, so
"launch" is: make sure something is listening, then point a browser at it.
Everything this module used to do — finding the browser that installed a
PWA, delivering a token through a URL fragment, confirming that delivery
actually happened — existed only because the page came from somewhere else.
See SAME_ORIGIN.md.
"""

import socket
import sys
import time
import webbrowser

from . import agent, state
from .server import GRACE_SECONDS, main as serve_main

ASKED_KEY = "asked-about-login-agent"


def app_url(port):
    return f"http://127.0.0.1:{port}/"


def _port_is_taken(port):
    """Whether something already listens on the loopback port."""
    with socket.socket() as probe:
        return probe.connect_ex(("127.0.0.1", port)) == 0


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


def run_hosted(port=5197, grace=GRACE_SECONDS, *, open_browser=True):
    """Serve the app and keep the engine in the foreground.

    If an engine already owns the port, this just opens the app against it
    and returns; the running one keeps serving.
    """
    url = app_url(port)

    def show(url):
        if not open_browser:
            print(f"The app is at {url}")
        elif webbrowser.open(url):
            print(f"Opening {url}")
        else:
            print(f"Could not open a browser automatically. Open {url}")

    if _port_is_taken(port):
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
