"""WebSocket server: one kernel session per WINDOW, resilient to reloads.

Sessions are keyed by a client-held id kept in sessionStorage — which
survives reloads of the same tab but is never shared with a new window,
exactly the lifetime a session should have. A dropped connection (reload,
sleep, network blip) leaves its kernel alive for a grace period; a client
reattaching with the same id resumes it, variables intact. A window
closed for good is never reclaimed and gets reaped.

The HTTP upgrade is accepted only from exact Knuth app origins. Handshake:
the client's first message is `attach{protocol, capability, session}`. The
server authenticates it before process creation and replies
`attached{protocol, session, resumed}` (echoing a fresh id if the claimed one
is actively held — a duplicated tab forks, it doesn't steal), then either
synthesizes `ready{resumed:true}` for a resumed kernel or lets the fresh
kernel's own `ready` flow through. Every later request is shape- and
size-validated before it reaches this session's kernel.
"""

import asyncio
import json
import os
import secrets
import signal
import sys
import uuid

import websockets

from .config import load_or_create_capability
from .limits import (
    HANDSHAKE_TIMEOUT_SECONDS,
    MAX_CODE_BYTES,
    MAX_CONCURRENT_KERNEL_STARTS,
    MAX_INBOUND_MESSAGE_BYTES,
    MAX_INBOUND_MESSAGE_QUEUE,
    MAX_KERNEL_EVENT_BYTES,
    MAX_LIVE_SESSIONS,
    MAX_NAME_CHARS,
    MAX_REQUEST_ID,
    MAX_SESSION_ID_CHARS,
)
from .session import MAX_TABLE_LIMIT

GRACE_SECONDS = 120
PROTOCOL_VERSION = 1

# Origin matching is exact and happens during the WebSocket HTTP upgrade,
# before handler() can create a kernel. Release defaults are production-only;
# loopback development origins require an explicit CLI opt-in.
DEFAULT_ALLOWED_ORIGINS = (
    "https://knuth.tayweid.io",
)
DEVELOPMENT_ORIGINS = (
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
            limit=MAX_KERNEL_EVENT_BYTES,
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


def _request_error(msg, error):
    """A bounded error the browser can correlate with the rejected request."""
    response = {"type": "protocol_error", "error": error}
    if isinstance(msg, dict):
        if isinstance(msg.get("type"), str):
            response["request"] = msg["type"]
        if type(msg.get("id")) is int:
            response["id"] = msg["id"]
    return response


def _validate_request(msg):
    """Return a user-safe error for an invalid post-attach request, or None."""
    if not isinstance(msg, dict):
        return "request must be a JSON object"
    kind = msg.get("type")
    if kind not in {
        "run",
        "interrupt",
        "restart",
        "namespace",
        "artifacts",
        "figure",
        "table",
    }:
        return "unknown request type"
    if kind == "run":
        request_id = msg.get("id")
        if type(request_id) is not int or not 0 <= request_id <= MAX_REQUEST_ID:
            return "run id must be a non-negative safe integer"
        code = msg.get("code")
        if not isinstance(code, str):
            return "run code must be a string"
        if len(code.encode("utf-8")) > MAX_CODE_BYTES:
            return f"run code exceeds the {MAX_CODE_BYTES}-byte limit"
        if "scratch" in msg and not isinstance(msg["scratch"], bool):
            return "run scratch must be a boolean"
    elif kind in {"figure", "table"}:
        name = msg.get("name")
        if not isinstance(name, str) or len(name) > MAX_NAME_CHARS:
            return f"{kind} name must be a string of at most {MAX_NAME_CHARS} characters"
        if kind == "table":
            offset = msg.get("offset", 0)
            limit = msg.get("limit", 100)
            if type(offset) is not int or not 0 <= offset <= MAX_REQUEST_ID:
                return "table offset must be a non-negative safe integer"
            if type(limit) is not int or not 1 <= limit <= MAX_TABLE_LIMIT:
                return f"table limit must be an integer from 1 to {MAX_TABLE_LIMIT}"
    return None


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


async def serve(
    port,
    grace=GRACE_SECONDS,
    origins=None,
    capability=None,
    *,
    max_sessions=MAX_LIVE_SESSIONS,
    max_concurrent_starts=MAX_CONCURRENT_KERNEL_STARTS,
):
    sessions = {}
    starting_sids = set()
    start_slots = asyncio.Semaphore(max_concurrent_starts)
    allowed_origins = tuple(origins or DEFAULT_ALLOWED_ORIGINS)
    agent_capability = capability or load_or_create_capability()

    async def reap_later(sid):
        await asyncio.sleep(grace)
        session = sessions.pop(sid, None)
        if session:
            await session.kernel.stop()

    async def handler(ws):
        # Handshake: attach{session} names the session to create or resume.
        try:
            first = json.loads(
                await asyncio.wait_for(ws.recv(), timeout=HANDSHAKE_TIMEOUT_SECONDS)
            )
        except (asyncio.TimeoutError, ValueError, websockets.exceptions.ConnectionClosed):
            await ws.close(code=1002, reason="invalid or missing attach handshake")
            return
        if not isinstance(first, dict) or first.get("type") != "attach":
            await ws.close(code=1002, reason="expected attach handshake")
            return

        # Transitional compatibility: a missing field is legacy protocol 1.
        # Explicit unknown versions fail closed. Remove the fallback after one
        # coordinated app/agent release has shipped.
        client_protocol = first.get("protocol", PROTOCOL_VERSION)
        if type(client_protocol) is not int or client_protocol != PROTOCOL_VERSION:
            await ws.send(json.dumps({
                "type": "incompatible",
                "protocol": PROTOCOL_VERSION,
                "received": client_protocol,
            }))
            await ws.close(code=1002, reason="unsupported protocol version")
            return

        supplied_capability = first.get("capability")
        authorized = (
            isinstance(supplied_capability, str)
            and supplied_capability.isascii()
            and len(supplied_capability) == len(agent_capability)
            and secrets.compare_digest(supplied_capability, agent_capability)
        )
        if not authorized:
            await ws.send(json.dumps({"type": "unauthorized"}))
            await ws.close(code=4401, reason="pairing required")
            return

        supplied_sid = first.get("session")
        if supplied_sid is not None and not isinstance(supplied_sid, str):
            await ws.close(code=1002, reason="session id must be a string")
            return
        if supplied_sid and len(supplied_sid) > MAX_SESSION_ID_CHARS:
            await ws.close(code=1002, reason="session id is too long")
            return
        sid = supplied_sid or uuid.uuid4().hex

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
        elif sid in starting_sids:
            # Two simultaneous first attaches with one id are also duplicate
            # tabs. Reserve a distinct identity before either process starts.
            sid = uuid.uuid4().hex
        if session is None:
            if len(sessions) + len(starting_sids) >= max_sessions:
                await ws.send(json.dumps({
                    "type": "server_busy",
                    "error": f"live session limit ({max_sessions}) reached",
                }))
                await ws.close(code=1013, reason="live session limit reached")
                return
            starting_sids.add(sid)
            kernel = KernelProcess()
            try:
                async with start_slots:
                    await kernel.start()
            except asyncio.CancelledError:
                await kernel.stop()
                raise
            except Exception:
                await kernel.stop()
                await ws.close(code=1011, reason="kernel failed to start")
                return
            finally:
                starting_sids.discard(sid)
            session = KernelSession(kernel)
            sessions[sid] = session

        session.ws = ws
        try:
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

            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except ValueError:
                    await ws.send(json.dumps(_request_error(None, "invalid JSON request")))
                    continue
                error = _validate_request(msg)
                if error:
                    await ws.send(json.dumps(_request_error(msg, error)))
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

    try:
        async with websockets.serve(
            handler,
            "127.0.0.1",
            port,
            origins=allowed_origins,
            max_size=MAX_INBOUND_MESSAGE_BYTES,
            max_queue=MAX_INBOUND_MESSAGE_QUEUE,
        ):
            print(
                f"knuth kernel server on ws://127.0.0.1:{port} "
                f"(protocol {PROTOCOL_VERSION}, up to {max_sessions} sessions, "
                f"{grace}s reattach grace)",
                flush=True,
            )
            await asyncio.get_running_loop().create_future()
    finally:
        # Foreground shutdown and test cancellation must not orphan subprocesses.
        background_tasks = []
        for session in sessions.values():
            if session.pump_task:
                session.pump_task.cancel()
                background_tasks.append(session.pump_task)
            if session.reap_task:
                session.reap_task.cancel()
                background_tasks.append(session.reap_task)
        await asyncio.gather(*background_tasks, return_exceptions=True)
        await asyncio.gather(
            *(session.kernel.stop() for session in sessions.values()),
            return_exceptions=True,
        )


def main(port=5197, grace=GRACE_SECONDS, origins=None, capability=None):
    try:
        asyncio.run(serve(port, grace, origins, capability))
    except KeyboardInterrupt:
        pass
