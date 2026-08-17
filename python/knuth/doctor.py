"""Redacted cross-platform diagnostics for the hosted Knuth engine."""

import asyncio
import importlib.metadata
import json
import platform
import sys

import websockets

from .hosted import app_url
from .server import PROTOCOL_VERSION, local_origins

STATUS_TIMEOUT = 2


async def _engine_status(port):
    try:
        async with websockets.connect(
            f"ws://127.0.0.1:{port}",
            # The engine trusts the origin it serves the app on; this asks
            # as that page would.
            origin=local_origins(port)[0],
            open_timeout=STATUS_TIMEOUT,
            close_timeout=STATUS_TIMEOUT,
        ) as ws:
            await ws.send(json.dumps({
                "type": "status",
                "protocol": PROTOCOL_VERSION,
            }))
            raw = await asyncio.wait_for(ws.recv(), timeout=STATUS_TIMEOUT)
    except (ConnectionRefusedError, OSError):
        return None
    except (asyncio.TimeoutError, websockets.exceptions.WebSocketException) as exc:
        raise RuntimeError(
            f"port {port} is occupied, but it did not answer as Knuth"
        ) from exc
    try:
        result = json.loads(raw)
    except (TypeError, ValueError) as exc:
        raise RuntimeError("the engine returned an invalid status response") from exc
    if not isinstance(result, dict) or result.get("type") != "status":
        response_type = result.get("type") if isinstance(result, dict) else None
        if response_type == "incompatible":
            raise RuntimeError("the running engine uses an incompatible protocol")
        raise RuntimeError("the engine returned an invalid status response")
    return result


def _installed_version():
    try:
        return importlib.metadata.version("knuth")
    except importlib.metadata.PackageNotFoundError:
        return "source checkout"


def run_doctor(port=5197):
    installed_version = _installed_version()
    print(f"Knuth package: {installed_version}")
    print(f"Python: {platform.python_version()} ({sys.executable})")
    print(f"Platform: {platform.platform()}")
    try:
        status = asyncio.run(_engine_status(port))
    except RuntimeError as exc:
        print(f"Engine: ERROR ({exc})")
        return 1
    if status is None:
        print(f"Engine: not running on 127.0.0.1:{port}")
        print("Start it with: knuth app")
        return 1
    print(
        f"Engine: Knuth {status.get('version', 'unknown')}, "
        f"protocol {status.get('protocol')}, "
        f"sessions {status.get('sessions')}/{status.get('max_sessions')}"
    )
    if status.get("protocol") != PROTOCOL_VERSION:
        print(f"Expected protocol {PROTOCOL_VERSION}; update and restart Knuth.")
        return 1
    engine_version = status.get("version")
    if engine_version != installed_version:
        print(
            f"Version mismatch: this command is {installed_version}, but the "
            f"running engine is {engine_version}. Update/restart the engine."
        )
        return 1
    print(f"App: {app_url(port)}")
    print("Diagnostics complete; no document content was printed.")
    return 0
