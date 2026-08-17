"""Cross-platform foreground launcher for Knuth's hosted PWA."""

import asyncio
import json
import webbrowser

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


class RunningEngineError(RuntimeError):
    """The control port answered, but not as a compatible Knuth engine."""


def _launch_url(token):
    # token_urlsafe emits only unreserved URL characters. Keeping the token in
    # the fragment prevents it from reaching GitHub Pages or HTTP access logs.
    return f"{HOSTED_APP_URL}#pair={token}"


def _open_hosted_app(token, open_browser):
    print(f"Opening {HOSTED_APP_URL}")
    if open_browser and webbrowser.open(_launch_url(token)):
        return
    if open_browser:
        print("Could not open a browser automatically.")
    print(f"Open {HOSTED_APP_URL} and use its manual Pair action.")
    print("Run `knuth agent pair` to display the pairing capability.")


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
        _open_hosted_app(existing_token, open_browser)
        return 0

    pairings = PairingBroker()
    token = pairings.issue()

    def ready():
        _open_hosted_app(token, open_browser)
        print("The Python engine is running locally. Press Ctrl-C to stop it.")

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
