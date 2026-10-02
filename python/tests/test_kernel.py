"""Session checks and the full server/kernel stack over a real WebSocket."""

import asyncio
from contextlib import asynccontextmanager, suppress
import json
import os
import re
import socket
import subprocess
import sys
import time

import pytest
import websockets
from websockets.exceptions import ConnectionClosed, InvalidHandshake

from knuth import kernel as kernel_module
from knuth.doctor import _engine_status
from knuth.limits import MAX_INBOUND_MESSAGE_BYTES
from knuth.session import Session
from knuth.server import (
    DEFAULT_ALLOWED_ORIGINS,
    KernelProcess,
    PROTOCOL_VERSION,
    local_origins,
    serve,
)


DEV_ORIGIN = "http://127.0.0.1:5198"
FOREIGN_ORIGIN = "https://knuth.tayweid.io"


def served_origin(port):
    """The origin the engine serves its app on — the only trusted one."""
    return local_origins(port)[0]


def close_code(ws):
    """The close code the server sent, across supported websockets versions.

    14.0 (our floor) exposes it only on the underlying protocol; later
    versions promote it onto the connection.
    """
    code = getattr(ws, "close_code", None)
    if code is not None:
        return code
    return getattr(getattr(ws, "protocol", None), "close_code", None)


@asynccontextmanager
async def closing_websocket(ws):
    """Close an already-awaited client across supported websockets versions."""
    try:
        yield ws
    finally:
        await ws.close()


def test_no_origin_is_trusted_by_default_except_our_own():
    """Nothing off this engine's own address gets in without --origin."""
    assert DEFAULT_ALLOWED_ORIGINS == ()
    assert local_origins(5197) == ("http://127.0.0.1:5197", "http://localhost:5197")


def test_windows_interrupt_uses_ctrl_break(monkeypatch):
    expected_signal = object()
    sent = []
    kernel = KernelProcess()
    kernel.proc = type("Process", (), {"send_signal": sent.append})()
    monkeypatch.setattr("knuth.server.sys.platform", "win32")
    monkeypatch.setattr(
        "knuth.server.signal.CTRL_BREAK_EVENT", expected_signal, raising=False
    )

    kernel.interrupt()

    assert sent == [expected_signal]


def test_windows_kernel_maps_ctrl_break_to_keyboard_interrupt(monkeypatch):
    expected_signal = object()
    installed = []
    monkeypatch.setattr(kernel_module.sys, "platform", "win32")
    monkeypatch.setattr(kernel_module.signal, "SIGBREAK", expected_signal, raising=False)
    monkeypatch.setattr(
        kernel_module.signal,
        "signal",
        lambda received, handler: installed.append((received, handler)),
    )

    kernel_module._install_interrupt_handler()

    assert installed == [(expected_signal, kernel_module._raise_keyboard_interrupt)]


def test_session():
    s = Session()
    ok, result = s.run("x = 6 * 7\nx")
    assert ok and result == "42", (ok, result)
    ok, result = s.run("x + 1")
    assert ok and result == "43", (ok, result)
    ok, result = s.run("y = 1")
    assert ok and result is None, (ok, result)
    ok, result = s.run("None")
    assert ok and result is None, (ok, result)
    ok, tb = s.run("1/0")
    assert not ok and "ZeroDivisionError" in tb and "session.py" not in tb, tb
    ok, tb = s.run("def broken(:")
    assert not ok and "SyntaxError" in tb, tb
    ok, result = s.run("x")  # session survived the errors
    assert ok and result == "42", (ok, result)
    names = {v["name"]: v for v in s.snapshot()}
    assert names["x"]["type"] == "int" and names["x"]["preview"] == "42", names
    assert "_" not in names
    s.reset()
    ok, tb = s.run("x")
    assert not ok and "NameError" in tb, tb


def _run_in_process(session, run_id, code, scratch=False):
    """One run through the kernel's own dispatcher, its events collected."""
    events = []
    state = {"id": None, "stream_bytes": 0}
    kernel_module.handle_request(
        {"type": "run", "id": run_id, "code": code, "scratch": scratch},
        session,
        state,
        events.append,
    )
    return events


def test_done_carries_what_the_run_bound(monkeypatch):
    # The receipt (docs/SESSION.md): the done event lists what the cell
    # bound, in the cell's order, with kinds and short previews, and
    # `saved` on what values.json mirrors.
    monkeypatch.delenv("KNUTH_DOCUMENT", raising=False)
    s = Session()
    events = _run_in_process(
        s, 1,
        "import math\nn, words = 3, ['a', 'b']\ndef f():\n    return n\nlabel = 'x' * 200\nn",
    )
    done = events[-1]
    assert done["type"] == "done" and done["result"] == "3", events
    bound = done["bound"]
    # Modules and underscore names are not values: math is not listed.
    assert [entry["name"] for entry in bound] == ["n", "words", "f", "label"], bound
    by_name = {entry["name"]: entry for entry in bound}
    assert by_name["n"] == {"name": "n", "type": "int", "preview": "3", "saved": True}
    assert by_name["words"]["length"] == 2 and by_name["words"]["saved"] is True
    # A function is bound but never saved; a long repr is cut short.
    assert by_name["f"]["type"] == "function" and "saved" not in by_name["f"]
    assert len(by_name["label"]["preview"]) == 81 and by_name["label"]["preview"].endswith("…")

    # Rebinding reports the name again; an unchanged session name does not.
    events = _run_in_process(s, 2, "n = n + 1")
    assert [entry["name"] for entry in events[-1]["bound"]] == ["n"], events
    assert events[-1]["bound"][0]["preview"] == "4"

    # A scratch run's names are marked scratch and never saved.
    events = _run_in_process(s, 3, "tmp = n * 2", scratch=True)
    assert events[-1]["bound"] == [{"name": "tmp", "type": "int", "preview": "8", "scratch": True}], events

    # A failed run carries no receipt: its assigned names are the AST's,
    # not what was bound before the error.
    events = _run_in_process(s, 4, "z = 1\n1/0")
    assert events[-1]["type"] == "error" and "bound" not in events[-1], events


def test_numpy_scalars_preview_by_value(monkeypatch):
    # The receipt's slim rows show a short value in place of its type: a
    # numpy scalar (the usual elasticity out of pandas) previews by its
    # value, as values.json has it, not as np.float64(…).
    monkeypatch.delenv("KNUTH_DOCUMENT", raising=False)
    s = Session()
    events = _run_in_process(
        s, 1,
        "import numpy as np\n"
        "elasticity = np.float64(-0.4088817904210866)\n"
        "k = np.int64(7)\n"
        "flag = np.bool_(True)\n"
        "arr = np.arange(3)\n"
        "narrow = np.float32(0.1)\n"
        "when = np.datetime64('2024-01-01T00:00', 'ns')\n"
        "never = np.datetime64('NaT', 'ns')\n"
        "word = np.str_('abc')\n",
    )
    by_name = {entry["name"]: entry for entry in events[-1]["bound"]}
    assert by_name["elasticity"]["type"] == "float64", by_name
    assert by_name["elasticity"]["preview"] == "-0.4088817904210866", by_name
    assert by_name["k"]["preview"] == "7" and by_name["flag"]["preview"] == "True", by_name
    # Numbers and dates by numpy's own str: item() would widen the float32
    # (0.10000000149011612), turn the nanosecond date into an int and NaT
    # into None. A string keeps Python's quotes.
    assert by_name["narrow"]["preview"] == "0.1", by_name
    assert by_name["when"]["type"] == "datetime64", by_name
    assert by_name["when"]["preview"] == "2024-01-01T00:00:00.000000000", by_name
    assert by_name["never"]["preview"] == "NaT", by_name
    assert by_name["word"]["preview"] == "'abc'", by_name
    # An array is not a scalar: its repr stays.
    assert by_name["arr"]["preview"] == "array([0, 1, 2])", by_name
    snapshot = {v["name"]: v for v in s.snapshot()}
    assert snapshot["elasticity"]["preview"] == "-0.4088817904210866", snapshot


def test_done_bound_is_capped(monkeypatch):
    monkeypatch.delenv("KNUTH_DOCUMENT", raising=False)
    from knuth.session import MAX_BOUND

    s = Session()
    names = [f"v{i}" for i in range(MAX_BOUND + 10)]
    code = ", ".join(names) + " = " + ", ".join(str(i) for i in range(len(names)))
    events = _run_in_process(s, 1, code)
    bound = events[-1]["bound"]
    assert len(bound) == MAX_BOUND and bound[0]["name"] == "v0", bound[:2]


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def server_command(port, *extra, origins=(), root=None):
    command = [sys.executable, "-m", "knuth", "serve", "--port", str(port), *extra]
    for origin in origins:
        command.extend(("--origin", origin))
    if root is not None:
        command.extend(("--root", str(root)))
    return command


class Client:
    def __init__(self, ws):
        self.ws = ws

    async def send(self, **msg):
        await self.ws.send(json.dumps(msg))

    async def recv(self):
        return json.loads(await self.ws.recv())

    async def attach(self, session):
        """Handshake; returns the `attached` message (session, resumed)."""
        await self.send(type="attach", protocol=PROTOCOL_VERSION, session=session)
        while True:
            msg = await self.recv()
            if msg["type"] == "attached":
                return msg

    async def wait_ready(self):
        while True:
            msg = await self.recv()
            if msg["type"] == "ready":
                return msg

    async def run(self, run_id, code):
        """Send a run and collect (streams, final) until done/error."""
        await self.send(type="run", id=run_id, code=code)
        streams = []
        while True:
            msg = await self.recv()
            if msg["type"] == "stream" and msg["id"] == run_id:
                streams.append((msg["which"], msg["text"]))
            elif msg["type"] in ("done", "error") and msg.get("id") == run_id:
                return streams, msg


async def check_over_websocket():
    port = free_port()
    server = subprocess.Popen(
        server_command(port),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        ws = None
        deadline = time.monotonic() + 10
        while ws is None:
            try:
                ws = await websockets.connect(
                    f"ws://127.0.0.1:{port}", origin=served_origin(port)
                )
            except OSError:
                if time.monotonic() > deadline:
                    raise
                await asyncio.sleep(0.1)
        SID = "test-session-1"
        async with closing_websocket(ws):
            c = Client(ws)
            attached = await c.attach(SID)
            assert attached["protocol"] == PROTOCOL_VERSION, attached
            assert attached["session"] == SID and attached["resumed"] is False, attached
            await c.wait_ready()

            # Streaming plus REPL-style result, and persistence across runs.
            streams, final = await c.run(1, "x = 6 * 7\nprint('hi')\nx")
            stdout = "".join(t for w, t in streams if w == "stdout")
            assert stdout == "hi\n", streams
            assert final["type"] == "done" and final["result"] == "42", final
            _, final = await c.run(2, "x + 1")
            assert final["result"] == "43", final

            # stderr routes separately.
            streams, final = await c.run(3, "import sys\nsys.stderr.write('warn\\n')")
            assert ("stderr", "warn\n") in streams, streams

            # Errors carry tracebacks and don't kill the session.
            _, final = await c.run(4, "1/0")
            assert final["type"] == "error" and "ZeroDivisionError" in final["traceback"], final
            _, final = await c.run(5, "x")
            assert final["result"] == "42", final

            # Namespace snapshot.
            await c.send(type="namespace", id=30)
            msg = await c.recv()
            names = {v["name"]: v for v in msg["vars"]}
            assert msg["type"] == "namespace" and msg["id"] == 30, msg
            assert names["x"]["preview"] == "42", msg

            # convert answers in-server — notebook JSON in, percent text
            # out — and never touches the kernel.
            await c.send(type="convert", id=31, text=json.dumps({
                "nbformat": 4,
                "cells": [{"cell_type": "code", "source": ["x = 1\n"]}],
            }))
            msg = await c.recv()
            assert msg == {
                "type": "converted", "id": 31, "text": "# %%\nx = 1\n", "commented": 0,
            }, msg
            await c.send(type="convert", id=32, text=7)
            msg = await c.recv()
            assert msg["type"] == "protocol_error" and msg["request"] == "convert", msg

            # Interrupt: stop an infinite loop, session stays usable.
            await c.send(type="run", id=6, code="import time\nwhile True: time.sleep(0.05)")
            await asyncio.sleep(0.4)
            await c.send(type="interrupt")
            while True:
                msg = await asyncio.wait_for(c.recv(), timeout=5)
                if msg["type"] == "error" and msg.get("id") == 6:
                    assert "KeyboardInterrupt" in msg["traceback"], msg
                    break
            _, final = await c.run(7, "x")
            assert final["result"] == "42", final

            # Unnamed pyplot figures arrive as a display event before done.
            await c.send(
                type="run",
                id=20,
                code="import matplotlib\nmatplotlib.use('Agg')\n"
                "import matplotlib.pyplot as plt\n_ = plt.plot([1, 2], [3, 4])",
            )
            saw_figures = False
            while True:
                msg = await asyncio.wait_for(c.recv(), timeout=30)
                if msg["type"] == "figures" and msg.get("id") == 20:
                    saw_figures = len(msg["svgs"]) == 1 and "<svg" in msg["svgs"][0]
                elif msg["type"] in ("done", "error") and msg.get("id") == 20:
                    assert msg["type"] == "done", msg
                    break
            assert saw_figures, "figures event should precede done"

            # Session isolation: a different session id gets its OWN kernel.
            async with websockets.connect(
                f"ws://127.0.0.1:{port}", origin=served_origin(port)
            ) as ws2:
                c2 = Client(ws2)
                await c2.attach("test-session-2")
                await c2.wait_ready()
                _, final = await c2.run(1, "x")
                assert final["type"] == "error" and "NameError" in final["traceback"], final

            # A duplicated tab (same id, actively held) forks, never steals.
            async with websockets.connect(
                f"ws://127.0.0.1:{port}", origin=served_origin(port)
            ) as ws3:
                c3 = Client(ws3)
                attached = await c3.attach(SID)
                assert attached["session"] != SID and attached["resumed"] is False, attached
                await c3.wait_ready()
                _, final = await c3.run(1, "x")
                assert final["type"] == "error" and "NameError" in final["traceback"], final

            _, final = await c.run(9, "x")  # ours is untouched by either
            assert final["result"] == "42", final

            # Restart: fresh process, empty namespace.
            await c.send(type="restart", id=31)
            while True:
                msg = await asyncio.wait_for(c.recv(), timeout=10)
                if msg["type"] == "ready":
                    assert msg["id"] == 31, msg
                    break
            _, final = await c.run(8, "x")
            assert final["type"] == "error" and "NameError" in final["traceback"], final
            _, final = await c.run(10, "marker = 7")
            assert final["type"] == "done", final

        # Reload survival: the tab is gone but the session id reclaims the
        # still-warm kernel within the grace period.
        async with websockets.connect(
            f"ws://127.0.0.1:{port}", origin=served_origin(port)
        ) as ws4:
            c4 = Client(ws4)
            attached = await c4.attach(SID)
            assert attached["resumed"] is True, attached
            msg = await c4.wait_ready()
            assert msg.get("resumed") is True, msg
            _, final = await c4.run(1, "marker")
            assert final["result"] == "7", final

    finally:
        server.terminate()
        server.wait(timeout=5)


async def check_grace_reap():
    """Past the grace period the session is truly gone: fresh kernel."""
    port = free_port()
    server = subprocess.Popen(
        server_command(port, "--grace", "1"),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        ws = None
        deadline = time.monotonic() + 10
        while ws is None:
            try:
                ws = await websockets.connect(
                    f"ws://127.0.0.1:{port}", origin=served_origin(port)
                )
            except OSError:
                if time.monotonic() > deadline:
                    raise
                await asyncio.sleep(0.1)
        async with closing_websocket(ws):
            c = Client(ws)
            await c.attach("reap-me")
            await c.wait_ready()
            _, final = await c.run(1, "z = 5")
            assert final["type"] == "done", final
        await asyncio.sleep(2.5)
        async with websockets.connect(
            f"ws://127.0.0.1:{port}", origin=served_origin(port)
        ) as ws2:
            c2 = Client(ws2)
            attached = await c2.attach("reap-me")
            assert attached["resumed"] is False, attached
            await c2.wait_ready()
            _, final = await c2.run(1, "z")
            assert final["type"] == "error" and "NameError" in final["traceback"], final
    finally:
        server.terminate()
        server.wait(timeout=5)


def test_over_websocket():
    asyncio.run(check_over_websocket())


def test_grace_reap():
    asyncio.run(check_grace_reap())


async def check_unexpected_kernel_exit():
    """A crashed interpreter fails visibly and cannot leave a dead session."""
    port = free_port()
    server = subprocess.Popen(
        server_command(port),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        deadline = time.monotonic() + 10
        while True:
            try:
                ws = await websockets.connect(
                    f"ws://127.0.0.1:{port}", origin=served_origin(port)
                )
                break
            except OSError:
                if time.monotonic() > deadline:
                    raise
                await asyncio.sleep(0.1)

        sid = "crashing-session"
        async with closing_websocket(ws):
            client = Client(ws)
            await client.attach(sid)
            await client.wait_ready()
            await client.send(type="run", id=1, code="import os\nos._exit(23)")
            while True:
                event = await asyncio.wait_for(client.recv(), timeout=5)
                if event["type"] == "kernel_exit":
                    assert event["returncode"] == 23, event
                    break
            with pytest.raises(ConnectionClosed):
                await client.recv()

        # Let the first handler finish removing the dead session. The same
        # routing id must then create a clean process, never "resume" death.
        await asyncio.sleep(0.1)
        async with websockets.connect(
            f"ws://127.0.0.1:{port}", origin=served_origin(port)
        ) as replacement:
            client = Client(replacement)
            attached = await client.attach(sid)
            assert attached["session"] == sid and attached["resumed"] is False, attached
            await client.wait_ready()
            _, final = await client.run(2, "6 * 7")
            assert final["type"] == "done" and final["result"] == "42", final
    finally:
        server.terminate()
        server.wait(timeout=5)


def test_unexpected_kernel_exit():
    asyncio.run(check_unexpected_kernel_exit())


async def check_origin_and_protocol_rejection():
    """Hostile origins and unknown versions fail before session creation."""
    port = free_port()
    url = f"ws://127.0.0.1:{port}"
    server = subprocess.Popen(
        server_command(port, origins=(FOREIGN_ORIGIN,)),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        # Wait for readiness through each allowed origin, then close without
        # an attach message. No kernel is created by these probes.
        deadline = time.monotonic() + 10
        while True:
            try:
                probe = await websockets.connect(url, origin=served_origin(port))
                await probe.close()
                break
            except OSError:
                if time.monotonic() > deadline:
                    raise
                await asyncio.sleep(0.1)

        explicit_probe = await websockets.connect(url, origin=FOREIGN_ORIGIN)
        await explicit_probe.close()

        for origin in (
            "https://attacker.example",
            "https://knuth.tayweid.io.attacker.example",
            "https://tayweid.github.io",
            None,
        ):
            with pytest.raises(InvalidHandshake):
                if origin is None:
                    await websockets.connect(url)
                else:
                    await websockets.connect(url, origin=origin)

        sid = "security-boundary-test"
        # An origin allowed through the upgrade by --origin still cannot
        # attach: only the origin this engine serves may create a kernel.
        async with websockets.connect(url, origin=FOREIGN_ORIGIN) as ws:
            await ws.send(json.dumps({
                "type": "attach",
                "protocol": PROTOCOL_VERSION,
                "session": sid,
            }))
            with pytest.raises(ConnectionClosed):
                await ws.recv()
            await ws.wait_closed()
            assert close_code(ws) == 4401, close_code(ws)

        # Same for the control verb.
        async with websockets.connect(url, origin=FOREIGN_ORIGIN) as ws:
            await ws.send(json.dumps({"type": "status", "protocol": PROTOCOL_VERSION}))
            with pytest.raises(ConnectionClosed):
                await ws.recv()
            await ws.wait_closed()
            assert close_code(ws) == 4401, close_code(ws)

        # The explicit frame limit applies before JSON parsing or process creation.
        async with websockets.connect(url, origin=served_origin(port)) as ws:
            await ws.send("x" * (MAX_INBOUND_MESSAGE_BYTES + 1))
            with pytest.raises(ConnectionClosed):
                await ws.recv()
            await ws.wait_closed()
            assert close_code(ws) == 1009, close_code(ws)

        # Even an authorized handshake can't smuggle an unbounded/non-string id.
        async with websockets.connect(url, origin=served_origin(port)) as ws:
            await ws.send(json.dumps({
                "type": "attach",
                "protocol": PROTOCOL_VERSION,
                "session": {"not": "a routing id"},
            }))
            with pytest.raises(ConnectionClosed):
                await ws.recv()
            await ws.wait_closed()
            assert close_code(ws) == 1002, close_code(ws)

        async with websockets.connect(url, origin=served_origin(port)) as ws:
            await ws.send(json.dumps({
                "type": "attach",
                "protocol": PROTOCOL_VERSION + 1,
                "session": sid,
            }))
            incompatible = json.loads(await ws.recv())
            assert incompatible["type"] == "incompatible", incompatible
            assert incompatible["protocol"] == PROTOCOL_VERSION, incompatible

        # The rejected attempts did not reserve or resume the claimed session.
        async with websockets.connect(url, origin=served_origin(port)) as ws:
            client = Client(ws)
            attached = await client.attach(sid)
            assert attached["resumed"] is False, attached
            await client.wait_ready()

            # Invalid post-attach requests return bounded errors and don't kill
            # either the WebSocket or its kernel process.
            await ws.send("{")
            error = json.loads(await ws.recv())
            assert error == {"type": "protocol_error", "error": "invalid JSON request"}

            await ws.send(json.dumps([]))
            error = json.loads(await ws.recv())
            assert error["type"] == "protocol_error", error

            await client.send(type="table", id=40, name="x", offset="zero", limit=100)
            error = await client.recv()
            assert error["type"] == "protocol_error" and error["request"] == "table", error
            assert error["id"] == 40, error

            await client.send(type="namespace")
            error = await client.recv()
            assert error["type"] == "protocol_error", error
            assert error["request"] == "namespace" and "id" not in error, error

            await client.send(type="not-a-command")
            error = await client.recv()
            assert error["type"] == "protocol_error", error

            _, final = await client.run(1, "40 + 2")
            assert final["type"] == "done" and final["result"] == "42", final
    finally:
        server.terminate()
        server.wait(timeout=5)


def test_origin_and_protocol_rejection():
    asyncio.run(check_origin_and_protocol_rejection())


async def check_live_session_limit():
    """New sessions stop at the cap; an existing session remains usable."""
    port = free_port()
    url = f"ws://127.0.0.1:{port}"
    server_task = asyncio.create_task(
        serve(
            port,
            grace=1,
            origins=(),
            max_sessions=1,
            max_concurrent_starts=1,
        )
    )
    first = None
    try:
        deadline = time.monotonic() + 10
        while first is None:
            try:
                first = await websockets.connect(url, origin=served_origin(port))
            except OSError:
                if time.monotonic() > deadline:
                    raise
                await asyncio.sleep(0.05)

        client = Client(first)
        await client.attach("only-session")
        await client.wait_ready()

        async with websockets.connect(url, origin=served_origin(port)) as second:
            other = Client(second)
            await other.send(
                type="attach",
                protocol=PROTOCOL_VERSION,
                    session="one-too-many",
            )
            busy = await other.recv()
            assert busy["type"] == "server_busy", busy
            await second.wait_closed()
            assert close_code(second) == 1013, close_code(second)

        _, final = await client.run(1, "6 * 7")
        assert final["type"] == "done" and final["result"] == "42", final
    finally:
        if first is not None:
            await first.close()
        server_task.cancel()
        with suppress(asyncio.CancelledError):
            await server_task


def test_live_session_limit():
    asyncio.run(check_live_session_limit())


async def check_simultaneous_duplicate_attach(monkeypatch):
    """Concurrent first attaches with one id fork instead of racing/leaking."""
    original_start = KernelProcess.start
    both_starting = asyncio.Event()
    starts = 0

    async def delayed_start(kernel, cwd=None, environment=None):
        nonlocal starts
        starts += 1
        if starts == 2:
            both_starting.set()
        await asyncio.wait_for(both_starting.wait(), timeout=5)
        await original_start(kernel, cwd=cwd, environment=environment)

    monkeypatch.setattr(KernelProcess, "start", delayed_start)
    port = free_port()
    url = f"ws://127.0.0.1:{port}"
    server_task = asyncio.create_task(
        serve(
            port,
            grace=1,
            origins=(),
            max_sessions=2,
            max_concurrent_starts=2,
        )
    )
    sockets = []
    try:
        deadline = time.monotonic() + 10
        while not sockets:
            try:
                sockets.append(await websockets.connect(url, origin=served_origin(port)))
            except OSError:
                if time.monotonic() > deadline:
                    raise
                await asyncio.sleep(0.05)
        sockets.append(await websockets.connect(url, origin=served_origin(port)))
        clients = [Client(ws) for ws in sockets]
        await asyncio.gather(*(
            client.send(
                type="attach",
                protocol=PROTOCOL_VERSION,
                    session="simultaneous-id",
            )
            for client in clients
        ))
        attached = await asyncio.gather(*(client.recv() for client in clients))
        assert {message["type"] for message in attached} == {"attached"}
        assert len({message["session"] for message in attached}) == 2, attached
        await asyncio.gather(*(client.wait_ready() for client in clients))
    finally:
        await asyncio.gather(*(ws.close() for ws in sockets), return_exceptions=True)
        server_task.cancel()
        with suppress(asyncio.CancelledError):
            await server_task


def test_simultaneous_duplicate_attach(monkeypatch):
    asyncio.run(check_simultaneous_duplicate_attach(monkeypatch))


async def connect_when_up(port):
    """Connect to an in-process serve() task, retrying until it binds."""
    deadline = time.monotonic() + 10
    while True:
        try:
            return await websockets.connect(
                f"ws://127.0.0.1:{port}", origin=served_origin(port)
            )
        except OSError:
            if time.monotonic() > deadline:
                raise
            await asyncio.sleep(0.05)


async def check_kernel_start_failure(monkeypatch):
    """A Python that cannot start is reported as exactly that.

    The engine answered; Python is what failed. The app must hear
    kernel_start_failed — not a wordless close it would read as "engine
    unavailable" — and the reserved session id must be released so a later
    attach with the same id starts clean.
    """
    original_start = KernelProcess.start

    async def failing_start(kernel, cwd=None, environment=None):
        raise RuntimeError("no interpreter for this test")

    monkeypatch.setattr(KernelProcess, "start", failing_start)
    port = free_port()
    server_task = asyncio.create_task(serve(port, grace=1, origins=()))
    try:
        ws = await connect_when_up(port)
        async with closing_websocket(ws):
            client = Client(ws)
            await client.send(
                type="attach", protocol=PROTOCOL_VERSION, session="doomed-id"
            )
            event = await asyncio.wait_for(client.recv(), timeout=5)
            assert event["type"] == "kernel_start_failed", event
            assert event["error"] == "Python could not be started for this window"
            with pytest.raises(ConnectionClosed):
                await client.recv()
        assert close_code(ws) == 1011

        # The failure released the reserved id: with a working interpreter
        # again, the same id attaches fresh instead of resuming a corpse.
        monkeypatch.setattr(KernelProcess, "start", original_start)
        replacement = await connect_when_up(port)
        async with closing_websocket(replacement):
            client = Client(replacement)
            attached = await client.attach("doomed-id")
            assert attached["resumed"] is False, attached
            await asyncio.wait_for(client.wait_ready(), timeout=10)
    finally:
        server_task.cancel()
        with suppress(asyncio.CancelledError):
            await server_task


def test_kernel_start_failure(monkeypatch):
    asyncio.run(check_kernel_start_failure(monkeypatch))


async def check_restart_failure(monkeypatch):
    """A restart whose new interpreter cannot start says so and frees the session."""
    original_start = KernelProcess.start
    fail_next_start = False

    async def flaky_start(kernel, cwd=None, environment=None):
        if fail_next_start:
            raise RuntimeError("interpreter went missing")
        await original_start(kernel, cwd=cwd, environment=environment)

    monkeypatch.setattr(KernelProcess, "start", flaky_start)
    port = free_port()
    server_task = asyncio.create_task(serve(port, grace=1, origins=()))
    try:
        ws = await connect_when_up(port)
        async with closing_websocket(ws):
            client = Client(ws)
            await client.attach("restart-doomed")
            await asyncio.wait_for(client.wait_ready(), timeout=10)
            fail_next_start = True
            await client.send(type="restart", id=7)
            while True:
                event = await asyncio.wait_for(client.recv(), timeout=5)
                if event["type"] == "kernel_exit":
                    break
            assert event["id"] == 7, event
            assert event["error"] == "Python engine failed to restart"
            with pytest.raises(ConnectionClosed):
                await client.recv()
        assert close_code(ws) == 1011

        # The dead session was removed, not left to be resumed.
        fail_next_start = False
        replacement = await connect_when_up(port)
        async with closing_websocket(replacement):
            client = Client(replacement)
            attached = await client.attach("restart-doomed")
            assert attached["resumed"] is False, attached
            await asyncio.wait_for(client.wait_ready(), timeout=10)
    finally:
        server_task.cancel()
        with suppress(asyncio.CancelledError):
            await server_task


def test_restart_failure(monkeypatch):
    asyncio.run(check_restart_failure(monkeypatch))


async def check_same_origin_needs_no_credential(web_root):
    """A page the engine served is proven by its Origin, not by a secret.

    This is the whole point of SAME_ORIGIN.md: no capability file, no pairing
    token, nothing to deliver or lose.
    """
    port = free_port()
    url = f"ws://127.0.0.1:{port}"
    served = f"http://127.0.0.1:{port}"
    server_task = asyncio.create_task(
        serve(
            port,
            grace=1,
            origins=(FOREIGN_ORIGIN,),
            web_root=web_root,
        )
    )
    try:
        deadline = time.monotonic() + 10
        while True:
            try:
                probe = await websockets.connect(url, origin=served)
                break
            except OSError:
                if time.monotonic() > deadline:
                    raise
                await asyncio.sleep(0.05)

        async with closing_websocket(probe):
            client = Client(probe)
            await client.send(
                type="attach", protocol=PROTOCOL_VERSION, session="same-origin"
            )
            attached = await client.recv()
            assert attached["type"] == "attached", attached
            await client.wait_ready()

        # An unrelated origin never reaches the handshake at all.
        with pytest.raises((InvalidHandshake, OSError)):
            await websockets.connect(url, origin="https://evil.example")
    finally:
        server_task.cancel()
        with suppress(asyncio.CancelledError):
            await server_task


def test_same_origin_needs_no_credential(tmp_path):
    (tmp_path / "index.html").write_text("<!doctype html>")
    asyncio.run(check_same_origin_needs_no_credential(tmp_path))


async def check_kernel_root(root):
    """A kernel started with a server root runs there, across a restart too."""
    port = free_port()
    (root / "probe.txt").write_text("hello from root\n")
    server = subprocess.Popen(
        server_command(port, root=root),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        ws = await connect_when_up(port)
        async with closing_websocket(ws):
            client = Client(ws)
            await client.attach("root-test")
            await client.wait_ready()

            _, final = await client.run(1, "open('probe.txt').read()")
            assert final["type"] == "done", final
            assert final["result"] == repr("hello from root\n"), final

            _, final = await client.run(2, "import os; os.getcwd()")
            assert final["type"] == "done", final
            assert final["result"] == repr(str(root)), final

            await client.send(type="restart", id=3)
            while True:
                msg = await asyncio.wait_for(client.recv(), timeout=10)
                if msg["type"] == "ready":
                    assert msg["id"] == 3, msg
                    break

            _, final = await client.run(4, "import os; os.getcwd()")
            assert final["type"] == "done", final
            assert final["result"] == repr(str(root)), final
    finally:
        server.terminate()
        server.wait(timeout=5)


def test_kernel_root(tmp_path):
    asyncio.run(check_kernel_root(tmp_path.resolve()))


def test_serve_rejects_missing_root():
    """The engine never binds a port for a root that isn't a real directory."""
    port = free_port()
    result = subprocess.run(
        server_command(port, root="/nonexistent"),
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode != 0, result
    assert "/nonexistent" in result.stderr, result.stderr


async def check_session_root_and_documents(engine_root, project):
    """APP.md: a session names its own root; files go by path; persist
    writes the contract into the kernel's cwd, not the engine's root."""
    port = free_port()
    document = project / "analysis.py"
    document.write_text("# %%\nx = 1\n")
    server = subprocess.Popen(
        server_command(port, root=engine_root),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        ws = await connect_when_up(port)
        async with closing_websocket(ws):
            client = Client(ws)
            await client.send(
                type="attach", protocol=PROTOCOL_VERSION, session="doc-test",
                root=str(project),
            )
            attached = await client.recv()
            assert attached["type"] == "attached" and attached["root"] == str(project), attached
            await client.wait_ready()

            _, final = await client.run(1, "import os; os.getcwd()")
            assert final["result"] == repr(str(project)), final

            await client.send(type="open", id=2, path=str(document))
            reply = await client.recv()
            assert reply["type"] == "document" and reply["id"] == 2, reply
            assert reply["text"] == "# %%\nx = 1\n" and reply["name"] == "analysis.py", reply

            await client.send(type="save", id=3, path=str(document), text="# %%\nx = 2\n")
            reply = await client.recv()
            assert reply["type"] == "saved" and reply["path"] == str(document), reply
            assert document.read_text() == "# %%\nx = 2\n"

            await client.send(type="stat", id=4, path=str(document))
            reply = await client.recv()
            assert reply["type"] == "stat" and reply["modified"] == reply["modified"], reply
            assert reply["modified"] == int(document.stat().st_mtime * 1000)

            await client.send(type="open", id=5, path="relative.py")
            reply = await client.recv()
            assert reply["type"] == "document" and "absolute" in reply["error"], reply

            _, final = await client.run(6, "answer = 42")
            await client.send(type="persist", id=7)
            reply = await client.recv()
            assert reply["type"] == "persisted" and reply["id"] == 7, reply
            assert reply["root"] == str(project) and reply["values"] == 1, reply
            assert json.loads((project / "values.json").read_text()) == {"answer": 42}
            assert not (engine_root / "values.json").exists()

            # A restart may move the session to another folder.
            elsewhere = project / "sub"
            elsewhere.mkdir()
            await client.send(type="restart", id=8, root=str(elsewhere))
            while True:
                msg = await asyncio.wait_for(client.recv(), timeout=10)
                if msg["type"] == "ready":
                    break
            _, final = await client.run(9, "import os; os.getcwd()")
            assert final["result"] == repr(str(elsewhere)), final

            # An unusable root falls back to the engine's, never refuses.
            await client.send(type="restart", id=10, root=str(project / "missing"))
            while True:
                msg = await asyncio.wait_for(client.recv(), timeout=10)
                if msg["type"] == "ready":
                    break
            _, final = await client.run(11, "import os; os.getcwd()")
            assert final["result"] == repr(str(engine_root)), final
    finally:
        server.terminate()
        server.wait(timeout=5)


async def check_document_environment(project):
    """ENVIRONMENT.md: attach names the document; the page hears where the
    kernel runs. Without a header that is the engine's Python, with a
    reason — never a refusal."""
    port = free_port()
    plain = project / "plain.py"
    plain.write_text("# %%\nx = 1\n")
    server = subprocess.Popen(
        server_command(port, root=project),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        ws = await connect_when_up(port)
        async with closing_websocket(ws):
            client = Client(ws)
            await client.send(
                type="attach", protocol=PROTOCOL_VERSION, session="env-test",
                root=str(project), document=str(plain),
            )
            attached = await client.recv()
            assert attached["type"] == "attached" and attached["document"] == str(plain), attached
            environment = await client.recv()
            assert environment["type"] == "environment", environment
            assert environment["state"] == "fallback" and not environment["managed"]
            assert environment["reason"] == "no environment header"
            assert environment["python"] == sys.executable
            await client.wait_ready()
            _, final = await client.run(1, "import sys; sys.executable")
            assert final["result"] == repr(sys.executable), final

            # A document that is not a file is no document at all.
            await client.send(type="restart", id=2, document=str(project / "missing.py"))
            environment = await client.recv()
            assert environment["type"] == "environment" and environment["reason"] == "no document"
            await client.wait_ready()

            await client.send(type="restart", id=3, document=42)
            reply = await client.recv()
            assert reply["type"] == "protocol_error" and "document" in reply["error"], reply
    finally:
        server.terminate()
        server.wait(timeout=5)


def test_document_environment_without_a_header(tmp_path):
    project = (tmp_path / "project").resolve()
    project.mkdir()
    asyncio.run(check_document_environment(project))


def uv_with_managed_python():
    from knuth import env

    return bool(env.find_uv()) and env.run_uv(
        ["python", "find"]
    ).returncode == 0


async def check_managed_environment(project):
    """The whole path: syncing, a kernel on the document's interpreter, an
    import that installs and pins, the header event the page splices."""
    port = free_port()
    document = project / "analysis.py"
    document.write_text(
        "# /// script\n"
        '# requires-python = ">=3.11"\n'
        "# dependencies = []\n"
        "#\n"
        "# [tool.uv]\n"
        '# exclude-newer = "2026-09-26T00:00:00Z"\n'
        "# ///\n\n# %%\nimport tomli_w\n"
    )
    server = subprocess.Popen(
        server_command(port, root=project),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        ws = await connect_when_up(port)
        async with closing_websocket(ws):
            client = Client(ws)
            await client.send(
                type="attach", protocol=PROTOCOL_VERSION, session="managed-test",
                root=str(project), document=str(document),
            )
            syncing = await asyncio.wait_for(client.recv(), timeout=120)
            assert syncing == {
                "type": "environment", "document": str(document), "state": "syncing",
                "python": sys.executable, "managed": False,
            }, syncing
            # Then each step uv reports, as it happens, until the session is up.
            steps = []
            while (attached := await asyncio.wait_for(client.recv(), timeout=120))["type"] == "environment":
                assert attached["state"] == "syncing" and attached["detail"], attached
                steps.append(attached["detail"])
            assert attached["type"] == "attached", attached
            assert steps and not any(step.startswith("+ ") for step in steps), steps
            environment = await client.recv()
            assert environment["state"] == "ready" and environment["managed"], environment
            assert environment["python"] != sys.executable
            await asyncio.wait_for(client.wait_ready(), timeout=60)

            _, final = await client.run(1, "import sys; sys.executable")
            assert final["result"] == repr(environment["python"]), final

            # Nothing downloads silently: the import fails, and the page asks
            # "Download with uv", which is the install request below.
            _, final = await client.run(2, "import tomli_w\ntomli_w.__name__")
            assert final["type"] == "error" and "No module named 'tomli_w'" in final["traceback"], final

            await client.send(type="install", id=3, module="tomli_w", download=True)
            events = []
            while True:
                msg = await asyncio.wait_for(client.recv(), timeout=120)
                events.append(msg)
                if msg["type"] == "installed":
                    break
            # uv's steps ride along on "installing" events with a detail.
            assert all(e["detail"] for e in events[1:] if e.get("state") == "installing"), events
            events = [events[0], *(e for e in events[1:] if "detail" not in e)]
            kinds = [(e["type"], e.get("state")) for e in events]
            assert kinds[:2] == [("dependency", "installing"), ("dependency", "installed")], kinds
            # The name asked of uv is the import name; uv normalizes it in the header.
            assert events[1]["distribution"] == "tomli_w" and events[1]["version"], events[1]
            header = events[2]
            assert header["type"] == "header" and header["path"] == str(document), header
            assert any(line.startswith('#     "tomli-w==') for line in header["lines"]), header
            assert header["modified"] == int(document.stat().st_mtime * 1000)
            # Already in its environment: the same session can import it now.
            assert events[-1] == {"type": "installed", "id": 3, "ok": True, "restart": False}, events[-1]

            _, final = await client.run(4, "import tomli_w\ntomli_w.__name__")
            assert final["type"] == "done" and final["result"] == "'tomli_w'", final
            on_disk = document.read_text()
            # The date moved to now, so the package came at its newest version.
            assert 'exclude-newer = "2026-09-26T00:00:00Z"' not in on_disk
            assert re.search(r'exclude-newer = "\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ"', on_disk), on_disk
            assert on_disk.endswith("# ///\n\n# %%\nimport tomli_w\n"), on_disk
    finally:
        server.terminate()
        server.wait(timeout=5)


@pytest.mark.skipif(not uv_with_managed_python(), reason="needs uv and a uv-managed Python")
def test_managed_environment_end_to_end(tmp_path):
    project = (tmp_path / "project").resolve()
    project.mkdir()
    asyncio.run(check_managed_environment(project))


def test_session_root_and_documents(tmp_path):
    engine_root = (tmp_path / "engine").resolve()
    project = (tmp_path / "project").resolve()
    engine_root.mkdir()
    project.mkdir()
    asyncio.run(check_session_root_and_documents(engine_root, project))


def test_serve_exits_with_its_parent(tmp_path):
    """Knuth.app passes its own pid: when it is gone, so is the engine — even
    when it went without running any terminate handler."""
    parent = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    port = free_port()
    server = subprocess.Popen(
        server_command(port, "--parent", str(parent.pid)),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            with socket.socket() as probe:
                if probe.connect_ex(("127.0.0.1", port)) == 0:
                    break
            time.sleep(0.1)
        else:
            pytest.fail("engine never came up")
        parent.kill()
        parent.wait(timeout=5)
        server.wait(timeout=15)
        assert server.returncode == 0, server.returncode
        assert "parent process" in server.stdout.read()
    finally:
        if parent.poll() is None:
            parent.kill()
        if server.poll() is None:
            server.kill()


async def check_install_needs_a_document(project):
    """An unsaved document installs from its text; without it, refused."""
    port = free_port()
    server = subprocess.Popen(server_command(port, root=project), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        ws = await connect_when_up(port)
        async with closing_websocket(ws):
            client = Client(ws)
            await client.attach("no-document")
            await client.wait_ready()
            await client.send(type="install", id=1, module="tomli_w")
            installed = await asyncio.wait_for(client.recv(), timeout=10)
            assert installed["type"] == "installed" and installed["ok"] is False, installed
            assert "text is needed" in installed["error"] and "download" not in installed, installed
            await client.send(type="install", id=2, module="not a module")
            refused = await asyncio.wait_for(client.recv(), timeout=10)
            assert refused["type"] == "protocol_error", refused
    finally:
        server.terminate()
        server.wait(timeout=5)


def test_install_needs_a_document(tmp_path):
    asyncio.run(check_install_needs_a_document(tmp_path.resolve()))


async def check_install_gives_a_plain_document_a_header(project):
    """A saved file with no header gets one, then the package; the session
    must move into the new environment, so the reply says restart."""
    port = free_port()
    document = project / "plain.py"
    document.write_text("# %%\nimport tomli_w\n")
    server = subprocess.Popen(server_command(port, root=project), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        ws = await connect_when_up(port)
        async with closing_websocket(ws):
            client = Client(ws)
            await client.send(
                type="attach", protocol=PROTOCOL_VERSION, session="plain-install",
                root=str(project), document=str(document),
            )
            await asyncio.wait_for(client.wait_ready(), timeout=60)
            await client.send(type="install", id=5, module="tomli_w", download=True)
            while True:
                msg = await asyncio.wait_for(client.recv(), timeout=180)
                if msg["type"] == "installed":
                    break
            assert msg == {"type": "installed", "id": 5, "ok": True, "restart": True}, msg
            text = document.read_text()
            assert text.startswith("# /// script\n"), text
            assert '#     "tomli-w==' in text and text.endswith("# ///\n\n# %%\nimport tomli_w\n"), text

            # The page's restart: the session moves into the environment.
            await client.send(type="restart", id=6, document=str(document))
            while True:
                msg = await asyncio.wait_for(client.recv(), timeout=180)
                if msg["type"] == "environment" and msg["state"] != "syncing":
                    assert msg["managed"], msg
                if msg["type"] == "ready":
                    break
            _, final = await client.run(7, "import tomli_w\ntomli_w.__name__")
            assert final["type"] == "done" and final["result"] == "'tomli_w'", final
    finally:
        server.terminate()
        server.wait(timeout=5)


@pytest.mark.skipif(not uv_with_managed_python(), reason="needs uv and a uv-managed Python")
def test_install_gives_a_plain_document_a_header(tmp_path):
    asyncio.run(check_install_gives_a_plain_document_a_header(tmp_path.resolve()))


def environments_on(config):
    """An engine as Knuth.app runs it: every session in a uv environment."""
    environ = {**os.environ, "KNUTH_CONFIG_DIR": str(config)}
    environ.pop("KNUTH_ENVIRONMENTS", None)
    return environ


async def check_install_into_an_unsaved_document(project, config):
    """An unsaved window already runs in a scratch uv environment, so an
    install lands where the kernel is: no restart, variables kept."""
    port = free_port()
    server = subprocess.Popen(
        server_command(port, root=project),
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=environments_on(config),
    )
    try:
        ws = await connect_when_up(port)
        async with closing_websocket(ws):
            client = Client(ws)
            await client.attach("unsaved-install")
            await asyncio.wait_for(client.wait_ready(), timeout=180)
            _, final = await client.run(1, "kept = 41 + 1")
            assert final["type"] == "done", final

            await client.send(type="install", id=2, module="tomli_w", text="# %%\nimport tomli_w\n", download=True)
            events = []
            while True:
                msg = await asyncio.wait_for(client.recv(), timeout=180)
                events.append(msg)
                if msg["type"] == "installed":
                    break
            header = next(e for e in events if e["type"] == "header")
            assert header["path"].startswith(str(config)), header
            assert any(line.startswith('#     "tomli-w==') for line in header["lines"]), header
            assert events[-1] == {"type": "installed", "id": 2, "ok": True, "restart": False}, events[-1]
            assert not any(project.iterdir()), "nothing lands in the project folder"

            _, final = await client.run(3, "import tomli_w\n(tomli_w.__name__, kept)")
            assert final["type"] == "done" and final["result"] == "('tomli_w', 42)", final
    finally:
        server.terminate()
        server.wait(timeout=5)


async def check_only_a_download_asks(project, config):
    """A package uv already has goes in without a word; one it would have
    to download is refused with `download: true`, the file untouched."""
    port = free_port()
    first, second = project / "first.py", project / "second.py"
    for document in (first, second):
        document.write_text(
            '# /// script\n# requires-python = ">=3.11"\n# dependencies = []\n#\n'
            '# [tool.uv]\n# exclude-newer = "2026-09-26T00:00:00Z"\n# ///\n\n# %%\n'
        )
    server = subprocess.Popen(
        server_command(port, root=project),
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=environments_on(config),
    )

    async def install(client, id, module, **extra):
        await client.send(type="install", id=id, module=module, **extra)
        events = []
        while True:
            msg = await asyncio.wait_for(client.recv(), timeout=180)
            events.append(msg)
            if msg["type"] == "installed":
                return events

    try:
        ws = await connect_when_up(port)
        async with closing_websocket(ws):
            client = Client(ws)
            await client.send(
                type="attach", protocol=PROTOCOL_VERSION, session="first",
                root=str(project), document=str(first),
            )
            await asyncio.wait_for(client.wait_ready(), timeout=180)
            # Downloaded once (or already in uv's cache)...
            events = await install(client, 1, "tomli_w", download=True)
            assert events[-1]["ok"], events

            await client.send(type="restart", id=2, document=str(second))
            while (await asyncio.wait_for(client.recv(), timeout=180))["type"] != "ready":
                pass
            # ...so another document gets it without asking, and silently.
            events = await install(client, 3, "tomli_w")
            assert [e["type"] for e in events] == ["header", "installed"], events
            assert events[-1] == {"type": "installed", "id": 3, "ok": True, "restart": False}, events
            _, final = await client.run(4, "import tomli_w\ntomli_w.__name__")
            assert final["type"] == "done", final

            # A name uv has never seen would be a download: ask first.
            before = second.read_text()
            events = await install(client, 5, "knuth_no_such_package_anywhere")
            assert [e["type"] for e in events] == ["installed"], events
            assert events[0]["ok"] is False and events[0]["download"] is True, events
            assert second.read_text() == before, "a refused add leaves the file as it was"
    finally:
        server.terminate()
        server.wait(timeout=5)


@pytest.mark.skipif(not uv_with_managed_python(), reason="needs uv and a uv-managed Python")
def test_only_a_download_asks(tmp_path):
    project = (tmp_path / "project").resolve()
    project.mkdir()
    asyncio.run(check_only_a_download_asks(project, (tmp_path / "config").resolve()))


async def check_imports_are_declared(project, config):
    """A package that arrived with another is listed once a cell imports it."""
    port = free_port()
    document = project / "declared.py"
    document.write_text(
        '# /// script\n# requires-python = ">=3.11"\n# dependencies = ["python-slugify"]\n# ///\n\n# %%\n'
    )
    server = subprocess.Popen(
        server_command(port, root=project),
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=environments_on(config),
    )
    try:
        ws = await connect_when_up(port)
        async with closing_websocket(ws):
            client = Client(ws)
            await client.send(
                type="attach", protocol=PROTOCOL_VERSION, session="declare",
                root=str(project), document=str(document),
            )
            await asyncio.wait_for(client.wait_ready(), timeout=180)
            await client.send(type="run", id=1, code="import text_unidecode, os")
            header = None
            while header is None:
                msg = await asyncio.wait_for(client.recv(), timeout=120)
                assert msg["type"] != "error", msg
                if msg["type"] == "header":
                    header = msg
            assert header["path"] == str(document), header
            assert any(line.startswith('#     "text-unidecode==') for line in header["lines"]), header
            assert not any('"os' in line for line in header["lines"]), "the standard library is never listed"
            assert '"text-unidecode==' in document.read_text()
    finally:
        server.terminate()
        server.wait(timeout=5)


@pytest.mark.skipif(not uv_with_managed_python(), reason="needs uv and a uv-managed Python")
def test_imports_are_declared(tmp_path):
    project = (tmp_path / "project").resolve()
    project.mkdir()
    asyncio.run(check_imports_are_declared(project, (tmp_path / "config").resolve()))


@pytest.mark.skipif(not uv_with_managed_python(), reason="needs uv and a uv-managed Python")
def test_install_into_an_unsaved_document(tmp_path):
    project = (tmp_path / "project").resolve()
    config = (tmp_path / "config").resolve()
    project.mkdir()
    asyncio.run(check_install_into_an_unsaved_document(project, config))


async def check_an_unsaved_documents_header_builds_its_environment(project, config):
    """Relaunched with an unsaved document whose header lists a package:
    the page sends its text, and the session's environment has it."""
    port = free_port()
    server = subprocess.Popen(
        server_command(port, root=project),
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=environments_on(config),
    )
    text = (
        '# /// script\n# requires-python = ">=3.11"\n# dependencies = ["tomli-w"]\n# ///\n\n'
        "# %%\nimport tomli_w\n"
    )
    try:
        ws = await connect_when_up(port)
        async with closing_websocket(ws):
            client = Client(ws)
            await client.send(type="attach", protocol=PROTOCOL_VERSION, session="relaunch", text=text)
            await asyncio.wait_for(client.wait_ready(), timeout=180)
            _, final = await client.run(1, "import tomli_w\ntomli_w.__name__")
            assert final["type"] == "done" and final["result"] == "'tomli_w'", final
    finally:
        server.terminate()
        server.wait(timeout=5)


@pytest.mark.skipif(not uv_with_managed_python(), reason="needs uv and a uv-managed Python")
def test_an_unsaved_documents_header_builds_its_environment(tmp_path):
    project = (tmp_path / "project").resolve()
    project.mkdir()
    asyncio.run(check_an_unsaved_documents_header_builds_its_environment(project, (tmp_path / "config").resolve()))
