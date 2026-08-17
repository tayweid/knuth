"""Cross-platform foreground launcher for Knuth's hosted PWA.

Pairing travels in a URL fragment, so the launcher's whole job is getting
that URL in front of the right browser. Two things make that harder than it
looks, and both are handled here rather than assumed away:

* The capability the browser stores is per browser profile. An app installed
  in Chrome learns nothing from a link opened in the system default browser,
  so the browser that installed the PWA is tried first.
* A launcher cannot tell from an exit code whether a browser accepted a URL.
  Opening a Chromium PWA's app shim, for instance, succeeds loudly and then
  loads the manifest start_url, silently dropping the fragment. So delivery
  is confirmed against the engine's own pairing state before this command
  claims success, and falls back to manual pairing when it cannot be shown.
"""

import asyncio
import json
import plistlib
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path

import websockets

from .config import load_or_create_capability
from .server import (
    DEFAULT_ALLOWED_ORIGINS,
    GRACE_SECONDS,
    PROTOCOL_VERSION,
    PairingBroker,
    main as serve_main,
)


HOSTED_APP_ORIGIN = DEFAULT_ALLOWED_ORIGINS[0]
HOSTED_APP_URL = f"{HOSTED_APP_ORIGIN}/"
PAIRING_REQUEST_TIMEOUT = 2
# How long a browser gets to load the app and spend the pairing token before
# the launcher treats that route as failed and tries the next one.
DELIVERY_TIMEOUT_SECONDS = 10
DELIVERY_POLL_SECONDS = 0.5

# A Chromium PWA launches through a small app shim whose Info.plist names the
# browser that installed it. The shim itself cannot carry a URL, and resolving
# it by name is ambiguous once a stale copy sits in the Trash — so the shim is
# read for its browser's bundle id and that browser is opened instead.
APP_SHIM_NAME = "Knuth.app"
APP_SHIM_DIRECTORIES = (
    Path.home() / "Applications" / "Chrome Apps.localized",
    Path.home() / "Applications" / "Chrome Apps",
    Path("/Applications/Chrome Apps.localized"),
    Path("/Applications/Chrome Apps"),
)


class RunningEngineError(RuntimeError):
    """The control port answered, but not as a compatible Knuth engine."""


def _launch_url(token):
    # token_urlsafe emits only unreserved URL characters. Keeping the token in
    # the fragment prevents it from reaching GitHub Pages or HTTP access logs.
    return f"{HOSTED_APP_URL}#pair={token}"


def _installed_app_browser():
    """Bundle id of the browser hosting the installed Knuth app, or None."""
    if sys.platform != "darwin":
        return None
    for directory in APP_SHIM_DIRECTORIES:
        plist = directory / APP_SHIM_NAME / "Contents" / "Info.plist"
        try:
            with open(plist, "rb") as handle:
                info = plistlib.load(handle)
        except (OSError, ValueError):
            continue
        bundle_id = info.get("CrBundleIdentifier")
        if isinstance(bundle_id, str) and bundle_id:
            return bundle_id
    return None


def _open_with_bundle_id(bundle_id, url):
    """Open a URL in one specific macOS application."""
    try:
        result = subprocess.run(
            ["open", "-b", bundle_id, url],
            capture_output=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


def _delivery_routes():
    """Ordered (description, opener) ways to show the pairing URL."""
    routes = []
    bundle_id = _installed_app_browser()
    if bundle_id:
        routes.append((
            f"the browser hosting the installed Knuth app ({bundle_id})",
            lambda url: _open_with_bundle_id(bundle_id, url),
        ))
    routes.append(("the default browser", webbrowser.open))
    return routes


def _confirm_delivery(is_pending):
    """True once the browser spends the token, False on timeout, None if unknowable."""
    if is_pending is None:
        return None
    deadline = time.monotonic() + DELIVERY_TIMEOUT_SECONDS
    while True:
        state = is_pending()
        if state is None:
            return None
        if not state:
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(DELIVERY_POLL_SECONDS)


def _open_hosted_app(token, open_browser, is_pending=None):
    """Deliver the pairing URL, returning whether pairing was confirmed."""
    if open_browser:
        url = _launch_url(token)
        for description, opener in _delivery_routes():
            try:
                launched = opener(url)
            except Exception:
                # A browser that refuses to start must not take the engine
                # down with it; the next route (or manual pairing) follows.
                launched = False
            if not launched:
                continue
            confirmed = _confirm_delivery(is_pending)
            if confirmed:
                print("Paired the browser with the local engine.")
                return True
            if confirmed is None:
                # An engine too old to report pairing state. Opening more
                # windows on a guess would be worse than stopping here.
                return False
            print(f"Opened {description}, but it did not complete pairing.")
        print("No browser accepted the pairing link.")
    print(f"Open {HOSTED_APP_URL} and use its manual Pair action.")
    print("Run `knuth agent pair` to display the pairing capability.")
    return False


def _deliver_in_background(token, open_browser, is_pending):
    """Run delivery on a thread and return it (the caller must not block)."""
    thread = threading.Thread(
        target=_open_hosted_app,
        args=(token, open_browser),
        kwargs={"is_pending": is_pending},
        daemon=True,
    )
    thread.start()
    return thread


async def _query_pairing_pending(port, capability):
    """Ask a running engine whether its pairing token is still unspent."""
    try:
        async with websockets.connect(
            f"ws://127.0.0.1:{port}",
            origin=HOSTED_APP_ORIGIN,
            open_timeout=PAIRING_REQUEST_TIMEOUT,
            close_timeout=PAIRING_REQUEST_TIMEOUT,
        ) as ws:
            await ws.send(json.dumps({
                "type": "pairing_status",
                "protocol": PROTOCOL_VERSION,
                "capability": capability,
            }))
            raw = await asyncio.wait_for(ws.recv(), timeout=PAIRING_REQUEST_TIMEOUT)
    except (
        ConnectionRefusedError,
        OSError,
        asyncio.TimeoutError,
        websockets.exceptions.WebSocketException,
    ):
        # Including an older engine, which closes on an unknown request type.
        return None
    try:
        response = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if not isinstance(response, dict) or response.get("type") != "pairing_status":
        return None
    pending = response.get("pending")
    return pending if isinstance(pending, bool) else None


def _remote_pairing_pending(port, capability):
    return asyncio.run(_query_pairing_pending(port, capability))


async def _request_pairing_from_running_engine(port, capability):
    """Return a fresh browser token, or None when no engine owns the port."""
    try:
        async with websockets.connect(
            f"ws://127.0.0.1:{port}",
            origin=HOSTED_APP_ORIGIN,
            open_timeout=PAIRING_REQUEST_TIMEOUT,
            close_timeout=PAIRING_REQUEST_TIMEOUT,
        ) as ws:
            await ws.send(json.dumps({
                "type": "create_pairing",
                "protocol": PROTOCOL_VERSION,
                "capability": capability,
            }))
            raw = await asyncio.wait_for(ws.recv(), timeout=PAIRING_REQUEST_TIMEOUT)
    except (ConnectionRefusedError, OSError):
        return None
    except (asyncio.TimeoutError, websockets.exceptions.WebSocketException) as exc:
        raise RunningEngineError(
            f"port {port} is occupied, but it did not answer as Knuth"
        ) from exc

    try:
        response = json.loads(raw)
    except (TypeError, ValueError) as exc:
        raise RunningEngineError("the running engine returned an invalid response") from exc
    if not isinstance(response, dict):
        raise RunningEngineError("the running engine returned an invalid response")
    if response.get("type") == "incompatible":
        raise RunningEngineError(
            "the running Knuth engine is an older, incompatible version; "
            "stop or restart it after upgrading"
        )
    if response.get("type") == "unauthorized":
        raise RunningEngineError(
            "the running Knuth engine has a different capability; restart it "
            "or use `knuth agent pair`"
        )
    token = response.get("token")
    if response.get("type") != "pairing_created" or not isinstance(token, str):
        raise RunningEngineError("the running engine could not create a pairing")
    return token


def run_hosted(
    port=5197,
    grace=GRACE_SECONDS,
    *,
    open_browser=True,
):
    """Pair/open the hosted PWA and keep a local engine in the foreground.

    If an updated background agent already owns the control port, ask it for a
    one-time pairing URL and return. Otherwise start the engine here and keep it
    alive until the user ends this command.
    """
    capability = load_or_create_capability()
    try:
        existing_token = asyncio.run(
            _request_pairing_from_running_engine(port, capability)
        )
    except RunningEngineError as exc:
        print(f"Knuth could not start: {exc}")
        return 1
    if existing_token:
        print(f"Using the Knuth engine already running on port {port}.")
        print(f"Opening {HOSTED_APP_URL}")
        _open_hosted_app(
            existing_token,
            open_browser,
            is_pending=lambda: _remote_pairing_pending(port, capability),
        )
        return 0

    pairings = PairingBroker()
    token = pairings.issue()

    def ready():
        print(f"Opening {HOSTED_APP_URL}")
        print("The Python engine is running locally. Press Ctrl-C to stop it.")
        # on_ready runs on the server's event loop, and confirming delivery
        # means waiting for the very attach this loop has to accept — so the
        # waiting happens on a thread that cannot stall it.
        _deliver_in_background(token, open_browser, lambda: pairings.pending)

    try:
        serve_main(
            port,
            grace,
            capability=capability,
            pairing_broker=pairings,
            on_ready=ready,
        )
    except OSError as exc:
        print(f"Knuth could not bind the local engine on port {port}: {exc}")
        return 1
    return 0
