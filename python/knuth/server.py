"""WebSocket server: one kernel session per WINDOW, resilient to reloads.

Sessions are keyed by a client-held id kept in sessionStorage — which
survives reloads of the same tab but is never shared with a new window,
exactly the lifetime a session should have. A dropped connection (reload,
sleep, network blip) leaves its kernel alive for a grace period; a client
reattaching with the same id resumes it, variables intact. A window
closed for good is never reclaimed and gets reaped.

This server also serves the app itself, on the same port, through the
handshake's `process_request` hook (see web.py and SAME_ORIGIN.md). A page
it served shares its origin, and the Origin check on the upgrade already
proves the browser loaded that page from this process — so such a client
needs no credential at all. Cross-origin clients (the hosted build) still
present the durable capability or a short-lived pairing token.

The HTTP upgrade is accepted only from exact Knuth app origins. Handshake:
the client's first message is `attach{protocol, capability, pairing, session}`.
The optional short-lived pairing token can bootstrap the durable browser
capability without ever placing that durable secret in a URL. The server
authenticates either credential before process creation and replies
`attached{protocol, session, resumed}` (echoing a fresh id if the claimed one
is actively held — a duplicated tab forks, it doesn't steal), then either
synthesizes `ready{resumed:true}` for a resumed kernel or lets the fresh
kernel's own `ready` flow through. Every later request is shape- and
size-validated before it reaches this session's kernel.
"""

import asyncio
import importlib.metadata
import json
import os
import secrets
import signal
import subprocess
import sys
import time
import uuid

import websockets

from . import web
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
PROTOCOL_VERSION = 2
PAIRING_TOKEN_BYTES = 32
PAIRING_TOKEN_CHARS = 43
PAIRING_TTL_SECONDS = 300

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


def local_origins(port):
    """The origins this engine serves the app on — its own address.

    A page fetched from here shares the engine's origin, so it needs no
    capability: the Origin check already proves the browser loaded it from
    this process. See SAME_ORIGIN.md.
    """
    return (f"http://127.0.0.1:{port}", f"http://localhost:{port}")


def _package_version():
    try:
        return importlib.metadata.version("knuth")
    except importlib.metadata.PackageNotFoundError:
        return "source checkout"


class PairingBroker:
    """Issue and consume one active, short-lived browser bootstrap token.

    Issuing a token revokes the previous unconsumed token. Consumption is
    constant-time and single-use. The broker lives only in the server process;
    the durable per-install capability remains in the owner-only config file.
    """

    def __init__(self, ttl_seconds=PAIRING_TTL_SECONDS):
        if ttl_seconds <= 0:
            raise ValueError("pairing token lifetime must be positive")
        self.ttl_seconds = ttl_seconds
        self._token = None
        self._expires_at = 0.0

    def issue(self):
        self._token = secrets.token_urlsafe(PAIRING_TOKEN_BYTES)
        self._expires_at = time.monotonic() + self.ttl_seconds
        return self._token

    @property
    def pending(self):
        """Whether an issued token is still unspent and unexpired.

        The launcher polls this to learn whether the browser it opened
        actually received the pairing URL, rather than trusting that a
        window appeared. Reading it reveals no secret.
        """
        return self._token is not None and time.monotonic() <= self._expires_at

    def consume(self, candidate):
        expected = self._token
        well_formed = (
            isinstance(candidate, str)
            and candidate.isascii()
            and len(candidate) == PAIRING_TOKEN_CHARS
        )
        matches = bool(
            expected is not None
            and well_formed
            and secrets.compare_digest(candidate, expected)
        )
        if not matches:
            return False
        valid = time.monotonic() <= self._expires_at
        self._token = None
        self._expires_at = 0.0
        return valid


def _capability_matches(candidate, expected):
    return bool(
        isinstance(candidate, str)
        and candidate.isascii()
        and len(candidate) == len(expected)
        and secrets.compare_digest(candidate, expected)
    )


class KernelProcess:
    def __init__(self):
        self.proc = None

    async def start(self):
        platform_options = {}
        if sys.platform == "win32":
            # A new process group lets the parent deliver Ctrl-Break to this
            # interpreter without terminating the foreground Knuth launcher.
            platform_options["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        self.proc = await asyncio.create_subprocess_exec(
            sys.executable,
            "-u",
            "-m",
            "knuth.kernel",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            limit=MAX_KERNEL_EVENT_BYTES,
            # Headless matplotlib: no GUI windows from a background service.
            env={**os.environ, "MPLBACKEND": "Agg"},
            **platform_options,
        )

    async def send(self, msg):
        self.proc.stdin.write((json.dumps(msg) + "\n").encode())
        await self.proc.stdin.drain()

    def interrupt(self):
        try:
            interrupt_signal = (
                signal.CTRL_BREAK_EVENT if sys.platform == "win32" else signal.SIGINT
            )
            self.proc.send_signal(interrupt_signal)
        except (ProcessLookupError, ValueError):
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
    if kind != "interrupt":
        request_id = msg.get("id")
        if type(request_id) is not int or not 0 <= request_id <= MAX_REQUEST_ID:
            return f"{kind} id must be a non-negative safe integer"
    if kind == "run":
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


async def _pump(kernel, ws, ready_id=None):
    """Forward kernel events and report an unexpected subprocess exit."""
    while True:
        line = await kernel.proc.stdout.readline()
        if not line:
            break
        if ready_id is not None:
            try:
                event = json.loads(line)
            except ValueError:
                event = None
            if isinstance(event, dict) and event.get("type") == "ready":
                event["id"] = ready_id
                line = (json.dumps(event) + "\n").encode()
                ready_id = None
        try:
            await ws.send(line.decode())
        except websockets.exceptions.ConnectionClosed:
            return

    returncode = await kernel.proc.wait()
    try:
        await ws.send(json.dumps({
            "type": "kernel_exit",
            "error": "Python engine exited unexpectedly",
            "returncode": returncode,
        }))
        await ws.close(code=1011, reason="kernel process exited")
    except websockets.exceptions.ConnectionClosed:
        pass


async def serve(
    port,
    grace=GRACE_SECONDS,
    origins=None,
    capability=None,
    *,
    pairing_broker=None,
    on_ready=None,
    max_sessions=MAX_LIVE_SESSIONS,
    max_concurrent_starts=MAX_CONCURRENT_KERNEL_STARTS,
    web_root=None,
):
    sessions = {}
    starting_sids = set()
    start_slots = asyncio.Semaphore(max_concurrent_starts)
    served_origins = local_origins(port)
    allowed_origins = tuple(origins or DEFAULT_ALLOWED_ORIGINS)
    if web.available(web_root):
        # Only trust our own address when we are actually the one serving
        # the page there; otherwise the origin proves nothing.
        allowed_origins = tuple(dict.fromkeys(allowed_origins + served_origins))
        trusted_origins = frozenset(served_origins)
    else:
        trusted_origins = frozenset()
    agent_capability = capability or load_or_create_capability()
    pairings = pairing_broker or PairingBroker()

    def same_origin(ws):
        request = getattr(ws, "request", None)
        origin = request.headers.get("Origin") if request else None
        return origin in trusted_origins

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
        if not isinstance(first, dict):
            await ws.close(code=1002, reason="expected handshake object")
            return

        client_protocol = first.get("protocol")
        if type(client_protocol) is not int or client_protocol != PROTOCOL_VERSION:
            await ws.send(json.dumps({
                "type": "incompatible",
                "protocol": PROTOCOL_VERSION,
                "received": client_protocol,
            }))
            await ws.close(code=1002, reason="unsupported protocol version")
            return

        if first.get("type") == "status":
            if not _capability_matches(first.get("capability"), agent_capability):
                await ws.send(json.dumps({"type": "unauthorized"}))
                await ws.close(code=4401, reason="status authorization required")
                return
            await ws.send(json.dumps({
                "type": "status",
                "protocol": PROTOCOL_VERSION,
                "version": _package_version(),
                "sessions": len(sessions) + len(starting_sids),
                "max_sessions": max_sessions,
            }))
            await ws.close(code=1000, reason="status reported")
            return

        if first.get("type") == "create_pairing":
            if not _capability_matches(first.get("capability"), agent_capability):
                await ws.send(json.dumps({"type": "unauthorized"}))
                await ws.close(code=4401, reason="pairing authorization required")
                return
            token = pairings.issue()
            await ws.send(json.dumps({
                "type": "pairing_created",
                "protocol": PROTOCOL_VERSION,
                "token": token,
                "expires_in": pairings.ttl_seconds,
            }))
            await ws.close(code=1000, reason="pairing created")
            return

        if first.get("type") == "pairing_status":
            if not _capability_matches(first.get("capability"), agent_capability):
                await ws.send(json.dumps({"type": "unauthorized"}))
                await ws.close(code=4401, reason="pairing authorization required")
                return
            await ws.send(json.dumps({
                "type": "pairing_status",
                "protocol": PROTOCOL_VERSION,
                "pending": pairings.pending,
            }))
            await ws.close(code=1000, reason="pairing status reported")
            return

        if first.get("type") != "attach":
            await ws.close(code=1002, reason="expected attach handshake")
            return

        supplied_capability = first.get("capability")
        # A page this engine served is already proven by its Origin. Control
        # requests above (status, create_pairing, pairing_status) stay
        # capability-gated — those are owner verbs, not app traffic.
        authorized = same_origin(ws) or _capability_matches(
            supplied_capability, agent_capability
        )
        supplied_pairing = first.get("pairing")
        bootstrapped = False
        if not authorized and supplied_pairing is not None:
            bootstrapped = pairings.consume(supplied_pairing)
            authorized = bootstrapped
        elif authorized and supplied_pairing is not None:
            # A correctly paired browser may still arrive through a fresh
            # launch URL. Consume that URL token so it cannot be replayed.
            pairings.consume(supplied_pairing)
        if not authorized:
            response_type = (
                "pairing_expired" if supplied_pairing is not None else "unauthorized"
            )
            await ws.send(json.dumps({"type": response_type}))
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
            if bootstrapped:
                await ws.send(json.dumps({
                    "type": "paired",
                    "protocol": PROTOCOL_VERSION,
                    "capability": agent_capability,
                }))
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
                    await asyncio.gather(session.pump_task, return_exceptions=True)
                    await session.kernel.stop()
                    session.kernel = KernelProcess()
                    try:
                        async with start_slots:
                            await session.kernel.start()
                    except Exception:
                        sessions.pop(sid, None)
                        await session.kernel.stop()
                        await ws.send(json.dumps({
                            "type": "kernel_exit",
                            "id": msg["id"],
                            "error": "Python engine failed to restart",
                        }))
                        await ws.close(code=1011, reason="kernel failed to restart")
                        return
                    session.pump_task = asyncio.create_task(
                        _pump(session.kernel, ws, ready_id=msg["id"])
                    )
                else:
                    await session.kernel.send(msg)
        finally:
            if session.pump_task:
                session.pump_task.cancel()
                await asyncio.gather(session.pump_task, return_exceptions=True)
            if sessions.get(sid) is session:
                process = session.kernel.proc
                if process is not None and process.returncode is not None:
                    sessions.pop(sid, None)
                    await session.kernel.stop()
                else:
                    session.ws = None
                    session.reap_task = asyncio.create_task(reap_later(sid))

    try:
        async with websockets.serve(
            handler,
            "127.0.0.1",
            port,
            origins=allowed_origins,
            process_request=lambda connection, request: web.respond(request, web_root),
            max_size=MAX_INBOUND_MESSAGE_BYTES,
            max_queue=MAX_INBOUND_MESSAGE_QUEUE,
        ):
            if on_ready:
                on_ready()
            print(
                f"knuth kernel server on ws://127.0.0.1:{port} "
                f"(protocol {PROTOCOL_VERSION}, up to {max_sessions} sessions, "
                f"{grace}s reattach grace)",
                flush=True,
            )
            if web.available(web_root):
                print(f"knuth app on http://127.0.0.1:{port}", flush=True)
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


def main(
    port=5197,
    grace=GRACE_SECONDS,
    origins=None,
    capability=None,
    *,
    pairing_broker=None,
    on_ready=None,
):
    try:
        asyncio.run(serve(
            port,
            grace,
            origins,
            capability,
            pairing_broker=pairing_broker,
            on_ready=on_ready,
        ))
    except KeyboardInterrupt:
        pass
