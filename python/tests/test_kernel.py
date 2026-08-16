"""Session checks and the full server/kernel stack over a real WebSocket."""

import asyncio
from contextlib import suppress
import json
import socket
import subprocess
import sys
import time

import pytest
import websockets
from websockets.exceptions import ConnectionClosed, InvalidHandshake

from knuth.config import load_or_create_capability
from knuth.limits import MAX_INBOUND_MESSAGE_BYTES
from knuth.session import Session
from knuth.server import DEFAULT_ALLOWED_ORIGINS, KernelProcess, PROTOCOL_VERSION, serve


TEST_ORIGIN = "http://127.0.0.1:5198"
PRODUCTION_ORIGIN = "https://knuth.tayweid.io"
TEST_CAPABILITY = load_or_create_capability()


def test_release_origins_exclude_shared_and_development_hosts():
    assert DEFAULT_ALLOWED_ORIGINS == (PRODUCTION_ORIGIN,)


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


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def server_command(port, *extra, origins=(TEST_ORIGIN,)):
    command = [sys.executable, "-m", "knuth", "serve", "--port", str(port), *extra]
    for origin in origins:
        command.extend(("--origin", origin))
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
        await self.send(
            type="attach",
            protocol=PROTOCOL_VERSION,
            capability=TEST_CAPABILITY,
            session=session,
        )
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
                    f"ws://127.0.0.1:{port}", origin=TEST_ORIGIN
                )
            except OSError:
                if time.monotonic() > deadline:
                    raise
                await asyncio.sleep(0.1)
        SID = "test-session-1"
        async with ws:
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
            await c.send(type="namespace")
            msg = await c.recv()
            names = {v["name"]: v for v in msg["vars"]}
            assert msg["type"] == "namespace" and names["x"]["preview"] == "42", msg

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
                f"ws://127.0.0.1:{port}", origin=TEST_ORIGIN
            ) as ws2:
                c2 = Client(ws2)
                await c2.attach("test-session-2")
                await c2.wait_ready()
                _, final = await c2.run(1, "x")
                assert final["type"] == "error" and "NameError" in final["traceback"], final

            # A duplicated tab (same id, actively held) forks, never steals.
            async with websockets.connect(
                f"ws://127.0.0.1:{port}", origin=TEST_ORIGIN
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
            await c.send(type="restart")
            while True:
                msg = await asyncio.wait_for(c.recv(), timeout=10)
                if msg["type"] == "ready":
                    break
            _, final = await c.run(8, "x")
            assert final["type"] == "error" and "NameError" in final["traceback"], final
            _, final = await c.run(10, "marker = 7")
            assert final["type"] == "done", final

        # Reload survival: the tab is gone but the session id reclaims the
        # still-warm kernel within the grace period.
        async with websockets.connect(
            f"ws://127.0.0.1:{port}", origin=TEST_ORIGIN
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
                    f"ws://127.0.0.1:{port}", origin=TEST_ORIGIN
                )
            except OSError:
                if time.monotonic() > deadline:
                    raise
                await asyncio.sleep(0.1)
        async with ws:
            c = Client(ws)
            await c.attach("reap-me")
            await c.wait_ready()
            _, final = await c.run(1, "z = 5")
            assert final["type"] == "done", final
        await asyncio.sleep(2.5)
        async with websockets.connect(
            f"ws://127.0.0.1:{port}", origin=TEST_ORIGIN
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


async def check_origin_and_protocol_rejection():
    """Hostile origins and unknown versions fail before session creation."""
    port = free_port()
    url = f"ws://127.0.0.1:{port}"
    server = subprocess.Popen(
        server_command(port, origins=(TEST_ORIGIN, PRODUCTION_ORIGIN)),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        # Wait for readiness through each allowed origin, then close without
        # an attach message. No kernel is created by these probes.
        deadline = time.monotonic() + 10
        while True:
            try:
                probe = await websockets.connect(url, origin=TEST_ORIGIN)
                await probe.close()
                break
            except OSError:
                if time.monotonic() > deadline:
                    raise
                await asyncio.sleep(0.1)

        production_probe = await websockets.connect(url, origin=PRODUCTION_ORIGIN)
        await production_probe.close()

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
        for supplied in (
            None,
            "wrong-capability-that-cannot-authorize",
            "not-ascii-\N{LOCK}",
        ):
            async with websockets.connect(url, origin=TEST_ORIGIN) as ws:
                attach = {
                    "type": "attach",
                    "protocol": PROTOCOL_VERSION,
                    "session": sid,
                }
                if supplied is not None:
                    attach["capability"] = supplied
                await ws.send(json.dumps(attach))
                unauthorized = json.loads(await ws.recv())
                assert unauthorized["type"] == "unauthorized", unauthorized

        # The explicit frame limit applies before JSON parsing or process creation.
        async with websockets.connect(url, origin=TEST_ORIGIN) as ws:
            await ws.send("x" * (MAX_INBOUND_MESSAGE_BYTES + 1))
            with pytest.raises(ConnectionClosed):
                await ws.recv()
            await ws.wait_closed()
            assert ws.close_code == 1009, ws.close_code

        # Even an authorized handshake can't smuggle an unbounded/non-string id.
        async with websockets.connect(url, origin=TEST_ORIGIN) as ws:
            await ws.send(json.dumps({
                "type": "attach",
                "protocol": PROTOCOL_VERSION,
                "capability": TEST_CAPABILITY,
                "session": {"not": "a routing id"},
            }))
            with pytest.raises(ConnectionClosed):
                await ws.recv()
            await ws.wait_closed()
            assert ws.close_code == 1002, ws.close_code

        async with websockets.connect(url, origin=TEST_ORIGIN) as ws:
            await ws.send(json.dumps({
                "type": "attach",
                "protocol": PROTOCOL_VERSION + 1,
                "capability": TEST_CAPABILITY,
                "session": sid,
            }))
            incompatible = json.loads(await ws.recv())
            assert incompatible["type"] == "incompatible", incompatible
            assert incompatible["protocol"] == PROTOCOL_VERSION, incompatible

        # The rejected attempts did not reserve or resume the claimed session.
        async with websockets.connect(url, origin=TEST_ORIGIN) as ws:
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

            await client.send(type="table", name="x", offset="zero", limit=100)
            error = await client.recv()
            assert error["type"] == "protocol_error" and error["request"] == "table", error

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
            origins=(TEST_ORIGIN,),
            capability=TEST_CAPABILITY,
            max_sessions=1,
            max_concurrent_starts=1,
        )
    )
    first = None
    try:
        deadline = time.monotonic() + 10
        while first is None:
            try:
                first = await websockets.connect(url, origin=TEST_ORIGIN)
            except OSError:
                if time.monotonic() > deadline:
                    raise
                await asyncio.sleep(0.05)

        client = Client(first)
        await client.attach("only-session")
        await client.wait_ready()

        async with websockets.connect(url, origin=TEST_ORIGIN) as second:
            other = Client(second)
            await other.send(
                type="attach",
                protocol=PROTOCOL_VERSION,
                capability=TEST_CAPABILITY,
                session="one-too-many",
            )
            busy = await other.recv()
            assert busy["type"] == "server_busy", busy
            await second.wait_closed()
            assert second.close_code == 1013, second.close_code

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

    async def delayed_start(kernel):
        nonlocal starts
        starts += 1
        if starts == 2:
            both_starting.set()
        await asyncio.wait_for(both_starting.wait(), timeout=5)
        await original_start(kernel)

    monkeypatch.setattr(KernelProcess, "start", delayed_start)
    port = free_port()
    url = f"ws://127.0.0.1:{port}"
    server_task = asyncio.create_task(
        serve(
            port,
            grace=1,
            origins=(TEST_ORIGIN,),
            capability=TEST_CAPABILITY,
            max_sessions=2,
            max_concurrent_starts=2,
        )
    )
    sockets = []
    try:
        deadline = time.monotonic() + 10
        while not sockets:
            try:
                sockets.append(await websockets.connect(url, origin=TEST_ORIGIN))
            except OSError:
                if time.monotonic() > deadline:
                    raise
                await asyncio.sleep(0.05)
        sockets.append(await websockets.connect(url, origin=TEST_ORIGIN))
        clients = [Client(ws) for ws in sockets]
        await asyncio.gather(*(
            client.send(
                type="attach",
                protocol=PROTOCOL_VERSION,
                capability=TEST_CAPABILITY,
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
