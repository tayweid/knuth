"""WebSocket server: one kernel session per WINDOW, resilient to reloads.

Sessions are keyed by a client-held id kept in sessionStorage — which
survives reloads of the same tab but is never shared with a new window,
exactly the lifetime a session should have. A dropped connection (reload,
sleep, network blip) leaves its kernel alive for a grace period; a client
reattaching with the same id resumes it, variables intact. A window
closed for good is never reclaimed and gets reaped.

The HTTP upgrade is accepted only from exact Knuth app origins. Handshake:
the client's first message is `attach{protocol, session}`. The server replies
`attached{protocol, session, resumed}` (echoing a fresh id if the claimed one
is actively held — a duplicated tab forks, it doesn't steal), then either
synthesizes `ready{resumed:true}` for a resumed kernel or lets the fresh
kernel's own `ready` flow through. `interrupt` and `restart` act on this
session's kernel only; everything else is forwarded verbatim.
"""

import asyncio
import json
import os
import signal
import sys
import uuid

import websockets

GRACE_SECONDS = 120
PROTOCOL_VERSION = 1

# Origin matching is exact and happens during the WebSocket HTTP upgrade,
# before handler() can create a kernel. The GitHub Pages origin preserves the
# currently deployed app; a dedicated production origin will replace it before
# public release. Loopback entries support the fixed Vite development port.
DEFAULT_ALLOWED_ORIGINS = (
    "https://tayweid.github.io",
    "http://127.0.0.1:5198",
    "http://localhost:5198",
)


class KernelProcess:
    def __init__(self):
        self.proc = None

    async def start(self):
        self.proc = await asyncio.create_subprocess_exec(
            sys.executable,
            "-u",
            "-m",
            "knuth.kernel",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            # Headless matplotlib: no GUI windows from a background service.
            env={"MPLBACKEND": "Agg", **os.environ},
        )

    async def send(self, msg):
        self.proc.stdin.write((json.dumps(msg) + "\n").encode())
        await self.proc.stdin.drain()

    def interrupt(self):
        try:
            self.proc.send_signal(signal.SIGINT)
        except ProcessLookupError:
            pass

    def kill(self):
        if self.proc and self.proc.returncode is None:
            self.proc.kill()

    async def stop(self):
        self.kill()
        if self.proc:
            await self.proc.wait()


class KernelSession:
    def __init__(self, kernel):
        self.kernel = kernel
        self.ws = None
        self.pump_task = None
        self.reap_task = None


async def _pump(kernel, ws):
    """Forward this kernel's event lines to the currently attached client."""
    while True:
        line = await kernel.proc.stdout.readline()
        if not line:
            break
        try:
            await ws.send(line.decode())
        except websockets.exceptions.ConnectionClosed:
            break


async def serve(port, grace=GRACE_SECONDS, origins=None):
    sessions = {}
    allowed_origins = tuple(origins or DEFAULT_ALLOWED_ORIGINS)

    async def reap_later(sid):
        await asyncio.sleep(grace)
        session = sessions.pop(sid, None)
        if session:
            await session.kernel.stop()

    async def handler(ws):
        # Handshake: attach{session} names the session to create or resume.
        try:
            first = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
        except (asyncio.TimeoutError, ValueError, websockets.exceptions.ConnectionClosed):
            return
        if not isinstance(first, dict) or first.get("type") != "attach":
            await ws.close(code=1002, reason="expected attach handshake")
            return

        # Transitional compatibility: a missing field is legacy protocol 1.
        # Explicit unknown versions fail closed. Remove the fallback after one
        # coordinated app/agent release has shipped.
        client_protocol = first.get("protocol", PROTOCOL_VERSION)
        if client_protocol != PROTOCOL_VERSION:
            await ws.send(json.dumps({
                "type": "incompatible",
                "protocol": PROTOCOL_VERSION,
                "received": client_protocol,
            }))
            await ws.close(code=1002, reason="unsupported protocol version")
            return
        sid = str(first.get("session") or "") or uuid.uuid4().hex

        session = sessions.get(sid)
        resumed = False
        if session and session.ws is None:
            # Orphaned by a reload/drop: resume it.
            if session.reap_task:
                session.reap_task.cancel()
            resumed = True
        elif session is not None:
            # The id is actively held (duplicated tab): fork, don't steal.
            sid = uuid.uuid4().hex
            session = None
        if session is None:
            kernel = KernelProcess()
            await kernel.start()
            session = KernelSession(kernel)
            sessions[sid] = session

        session.ws = ws
        await ws.send(json.dumps({
            "type": "attached",
            "protocol": PROTOCOL_VERSION,
            "session": sid,
            "resumed": resumed,
        }))
        if resumed:
            # The kernel's own ready was consumed in a previous life.
            await ws.send(json.dumps({"type": "ready", "resumed": True}))
        session.pump_task = asyncio.create_task(_pump(session.kernel, ws))

        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                if not isinstance(msg, dict):
                    continue
                kind = msg.get("type")
                if kind == "interrupt":
                    session.kernel.interrupt()
                elif kind == "restart":
                    session.pump_task.cancel()
                    await session.kernel.stop()
                    session.kernel = KernelProcess()
                    await session.kernel.start()
                    session.pump_task = asyncio.create_task(_pump(session.kernel, ws))
                else:
                    await session.kernel.send(msg)
        finally:
            if session.pump_task:
                session.pump_task.cancel()
            if sessions.get(sid) is session:
                session.ws = None
                session.reap_task = asyncio.create_task(reap_later(sid))

    async with websockets.serve(
        handler,
        "127.0.0.1",
        port,
        origins=allowed_origins,
    ):
        print(
            f"knuth kernel server on ws://127.0.0.1:{port} "
            f"(protocol {PROTOCOL_VERSION}, session per window, "
            f"{grace}s reattach grace)",
            flush=True,
        )
        await asyncio.get_running_loop().create_future()


def main(port=5197, grace=GRACE_SECONDS, origins=None):
    try:
        asyncio.run(serve(port, grace, origins))
    except KeyboardInterrupt:
        pass
