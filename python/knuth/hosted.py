"""Start the engine and open the app it serves.

There is nothing to pair. The engine serves the page on its own port, so
"launch" is: make sure something is listening, then point a browser at it.
Everything this module used to do — finding the browser that installed a
PWA, delivering a token through a URL fragment, confirming that delivery
actually happened — existed only because the page came from somewhere else.
See SAME_ORIGIN.md.
"""

import socket
import webbrowser

from .server import GRACE_SECONDS, main as serve_main


def app_url(port):
    return f"http://127.0.0.1:{port}/"


def _port_is_taken(port):
    """Whether something already listens on the loopback port."""
    with socket.socket() as probe:
        return probe.connect_ex(("127.0.0.1", port)) == 0


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

    def ready():
        show(url)
        print("The Python engine is running locally. Press Ctrl-C to stop it.")

    try:
        serve_main(port, grace, on_ready=ready)
    except OSError as exc:
        print(f"Knuth could not bind the local engine on port {port}: {exc}")
        return 1
    return 0
