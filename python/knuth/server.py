"""WebSocket server: one kernel session per WINDOW, resilient to reloads.

Sessions are keyed by a client-held id kept in sessionStorage — which
survives reloads of the same tab but is never shared with a new window,
exactly the lifetime a session should have. A dropped connection (reload,
sleep, network blip) leaves its kernel alive for a grace period; a client
reattaching with the same id resumes it, variables intact. A window
closed for good is never reclaimed and gets reaped.

This server also serves the app itself, on the same port, through the
handshake's `process_request` hook (see web.py and SAME_ORIGIN.md). That is
the whole authentication story: the exact Origin check on the upgrade proves
the browser loaded the page from this process, so there is no secret to
deliver, store, diverge, or lose. Nothing else may open the socket.

Handshake: the client's first message is `attach{protocol, session, root?}`.
The server replies `attached{protocol, session, resumed}` (echoing a fresh
id if the claimed one is actively held — a duplicated tab forks, it doesn't
steal), then either synthesizes `ready{resumed:true}` for a resumed kernel
or lets the fresh kernel's own `ready` flow through. Every later request is
shape- and size-validated before it reaches this session's kernel.

Roots are per session (APP.md): `root` on attach, or on a `restart`, is the
absolute directory the session's kernel runs in — the opened document's
folder, when the page has a real path. Without one, the engine's own root
(`--root`, else its cwd) applies, as before.

Documents by path (files.py) are answered here, not by the kernel: `open`,
`save`, `stat`, `rename`. `persist` goes to the kernel, which writes the
folder contract into its cwd.

Environments are per document (ENVIRONMENT.md): `document` on attach or
restart, beside `root`, is the absolute path of the open `.py`. When it
carries a PEP 723 header and uv is available, the kernel starts on that
document's own interpreter (env.py), and the page hears `environment`
events: `syncing` while uv works, then `ready` or `fallback`.
"""

import asyncio
import importlib.metadata
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import uuid

import websockets

from . import env, files, web
from .ipynb import notebook_to_document
from .percent import serialize_document
from .limits import (
    HANDSHAKE_TIMEOUT_SECONDS,
    MAX_CODE_BYTES,
    MAX_CONCURRENT_KERNEL_STARTS,
    MAX_INBOUND_MESSAGE_BYTES,
    MAX_INBOUND_MESSAGE_QUEUE,
    MAX_KERNEL_EVENT_BYTES,
    MAX_LIVE_SESSIONS,
    MAX_NAME_CHARS,
    MAX_PATH_CHARS,
    MAX_REQUEST_ID,
    MAX_SESSION_ID_CHARS,
)
from .session import MAX_TABLE_LIMIT

GRACE_SECONDS = 120
PROTOCOL_VERSION = 2

# Origin matching is exact and happens during the WebSocket HTTP upgrade,
# before handler() can create a kernel. The engine serves its own app, so the
# only origin it trusts by default is its own address; anything else has to
# be named explicitly with --origin (the vite dev server, mainly).
DEFAULT_ALLOWED_ORIGINS = ()


def local_origins(port):
    """The origins this engine serves the app on — its own address.

    Because the page comes from here, the Origin check on the upgrade is the
    whole authentication story: it proves the browser loaded the page from
    this process. There is no secret to deliver, store, or lose, which is
    the entire point of SAME_ORIGIN.md.
    """
    return (f"http://127.0.0.1:{port}", f"http://localhost:{port}")


def build_stamp():
    """A fingerprint of the code this process would load from disk.

    Versions do not move during development, so `2.0.0.dev0` cannot tell a
    freshly upgraded package from the one a long-lived engine started with.
    The newest mtime across the package can, and that is the exact question
    after a pip install: is the engine still serving what it booted with?
    """
    root = Path(__file__).parent
    newest = 0.0
    for path in root.rglob("*"):
        if path.suffix in {".py", ".html", ".js", ".css"}:
            try:
                newest = max(newest, path.stat().st_mtime)
            except OSError:
                continue
    return f"{newest:.0f}"


def _package_version():
    try:
        return importlib.metadata.version("knuth")
    except importlib.metadata.PackageNotFoundError:
        return "source checkout"


class KernelProcess:
    def __init__(self):
        self.proc = None

    async def start(self, cwd=None, environment=None):
        platform_options = {}
        if sys.platform == "win32":
            # A new process group lets the parent deliver Ctrl-Break to this
            # interpreter without terminating the foreground Knuth launcher.
            platform_options["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        # The document's own interpreter when it has one (ENVIRONMENT.md),
        # else ours; kernel_environ adds the shim that makes `knuth.kernel`
        # importable there, and headless matplotlib either way (no GUI
        # windows from a background service).
        self.proc = await asyncio.create_subprocess_exec(
            environment.python if environment is not None else sys.executable,
            "-u",
            "-m",
            "knuth.kernel",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            limit=MAX_KERNEL_EVENT_BYTES,
            cwd=cwd,
            env=env.kernel_environ(environment),
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
    def __init__(self, kernel, root=None, document=None, environment=None):
        self.kernel = kernel
        # Where this session's kernel runs (and restarts): the document's
        # folder when the page has a path, else the engine's root.
        self.root = root
        # The open document, and the environment its kernel runs in: the
        # document's own when it has a header, else the engine's Python.
        self.document = document
        self.environment = environment
        self.ws = None
        self.pump_task = None
        self.reap_task = None


def _session_root(value, default):
    """The directory a session asked for, or the engine's default.

    A root that is not an existing directory falls back rather than
    refusing: the page still gets a kernel, and `knuth doctor` says where.
    """
    if not isinstance(value, str) or not value or len(value) > MAX_PATH_CHARS:
        return default
    path = Path(value)
    if not path.is_absolute() or not path.is_dir():
        return default
    return str(path)


def _session_document(value):
    """The document a session names — an absolute path to an existing file —
    or None: no document means no environment of its own."""
    if not isinstance(value, str) or not value or len(value) > MAX_PATH_CHARS:
        return None
    if "\0" in value:
        return None
    path = Path(value)
    if not path.is_absolute() or not path.is_file():
        return None
    return str(path)


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
        "persist",
        "figure",
        "table",
        "convert",
        "open",
        "save",
        "stat",
        "rename",
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
    elif kind == "convert":
        if not isinstance(msg.get("text"), str):
            return "convert text must be a string"
    elif kind == "restart":
        if "root" in msg and not isinstance(msg["root"], str):
            return "restart root must be a string"
        if "document" in msg and not isinstance(msg["document"], str):
            return "restart document must be a string"
    elif kind in {"open", "save", "stat", "rename"}:
        path = msg.get("path")
        if not isinstance(path, str) or not path or len(path) > MAX_PATH_CHARS:
            return f"{kind} path must be a string of at most {MAX_PATH_CHARS} characters"
        if kind == "save" and not isinstance(msg.get("text"), str):
            return "save text must be a string"
        if kind == "rename" and not isinstance(msg.get("name"), str):
            return "rename name must be a string"
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


def _file_response(msg):
    """Answer a document-by-path request from the engine itself."""
    kind = msg["type"]
    if kind == "open":
        body = files.open_document(msg["path"])
        reply = "document"
    elif kind == "save":
        body = files.save_document(msg["path"], msg["text"])
        reply = "saved"
    elif kind == "stat":
        body = files.stat_document(msg["path"])
        reply = "stat"
    else:
        body = files.rename_document(msg["path"], msg["name"])
        reply = "renamed"
    return {"type": reply, "id": msg["id"], **body}


def _convert_response(msg):
    """Answer a convert request: .ipynb JSON in, percent-format text out.

    The notebook importer is pure text transformation (ipynb.py), so the
    server answers directly — the kernel is never involved, and the one
    converter stays the Python one.
    """
    try:
        doc, commented = notebook_to_document(msg["text"])
    except ValueError as error:
        return {"type": "converted", "id": msg["id"], "error": str(error)}
    return {
        "type": "converted",
        "id": msg["id"],
        "text": serialize_document(doc),
        "commented": commented,
    }


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


def _process_alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


async def _exit_with_parent(pid, interval=2.0):
    """Stop serving once the process that started us is gone (APP.md: the
    shell owns the engine's lifetime — including when it crashes or is
    force-quit, which no terminate handler survives)."""
    while _process_alive(pid):
        await asyncio.sleep(interval)
    # Returning ends the `async with websockets.serve(...)` block, whose
    # finally clause stops every kernel — the same path Ctrl-C takes.
    print(f"parent process {pid} is gone; stopping the engine", flush=True)


async def serve(
    port,
    grace=GRACE_SECONDS,
    origins=None,
    *,
    on_ready=None,
    max_sessions=MAX_LIVE_SESSIONS,
    max_concurrent_starts=MAX_CONCURRENT_KERNEL_STARTS,
    web_root=None,
    root=None,
    parent=None,
):
    sessions = {}
    starting_sids = set()
    start_slots = asyncio.Semaphore(max_concurrent_starts)
    # We are bound to this port, so nothing else can be serving pages at
    # this origin while we run — the Origin is ours by construction, whether
    # or not this install carries a build to serve. (A page served by some
    # other process on this port *before* we started could still be open in
    # a browser; that is the one gap, and it is not worth a secret.)
    served_origins = local_origins(port)
    allowed_origins = tuple(dict.fromkeys(
        tuple(origins or DEFAULT_ALLOWED_ORIGINS) + served_origins
    ))
    trusted_origins = frozenset(served_origins)

    def same_origin(ws):
        request = getattr(ws, "request", None)
        origin = request.headers.get("Origin") if request else None
        return origin in trusted_origins

    async def reap_later(sid):
        await asyncio.sleep(grace)
        session = sessions.pop(sid, None)
        if session:
            await session.kernel.stop()

    async def report_start_failure(kernel, ws, event, reason):
        # One voice for both start-failure paths (first attach and restart):
        # stop the half-started process, say exactly what failed — closing
        # without a word leaves the app guessing, and its guess was "engine
        # unavailable", which is wrong: the engine answered, Python is what
        # failed — then close 1011.
        await kernel.stop()
        await ws.send(json.dumps(event))
        await ws.close(code=1011, reason=reason)

    async def prepare_environment(ws, document):
        """The document's environment, built or refreshed (ENVIRONMENT.md).

        uv may take minutes the first time (a Python download), so the work
        runs in a thread and the page is told it is happening first.
        """
        if env.is_candidate(document):
            await ws.send(json.dumps({
                "type": "environment",
                "document": document,
                "state": "syncing",
                # Not known yet; the page's shape check wants both fields.
                "python": sys.executable,
                "managed": False,
            }))
        return await asyncio.to_thread(env.ensure_environment, document)

    async def handle_status(ws):
        # The read-only probe `knuth doctor` uses: answer and hang up,
        # touching no session state. Kept apart from handler() so attach
        # and the probe cannot tangle.
        if not same_origin(ws):
            await ws.close(code=4401, reason="status is local-origin only")
            return
        await ws.send(json.dumps({
            "type": "status",
            "protocol": PROTOCOL_VERSION,
            "version": _package_version(),
            "build": build_stamp(),
            "sessions": len(sessions) + len(starting_sids),
            "max_sessions": max_sessions,
            "root": root,
        }))
        await ws.close(code=1000, reason="status reported")

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
            await handle_status(ws)
            return

        if first.get("type") != "attach":
            await ws.close(code=1002, reason="expected attach handshake")
            return

        # The Origin check already ran during the upgrade; restated here
        # because this is where a kernel process would get created.
        if not same_origin(ws):
            await ws.close(code=4401, reason="attach is local-origin only")
            return

        supplied_sid = first.get("session")
        if supplied_sid is not None and not isinstance(supplied_sid, str):
            await ws.close(code=1002, reason="session id must be a string")
            return
        if supplied_sid and len(supplied_sid) > MAX_SESSION_ID_CHARS:
            await ws.close(code=1002, reason="session id is too long")
            return
        sid = supplied_sid or uuid.uuid4().hex
        session_root = _session_root(first.get("root"), root)
        session_document = _session_document(first.get("document"))

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
            environment = None
            try:
                async with start_slots:
                    environment = await prepare_environment(ws, session_document)
                    await kernel.start(cwd=session_root, environment=environment)
            except asyncio.CancelledError:
                await kernel.stop()
                raise
            except Exception:
                await report_start_failure(kernel, ws, {
                    "type": "kernel_start_failed",
                    "error": "Python could not be started for this window",
                }, "kernel failed to start")
                return
            finally:
                starting_sids.discard(sid)
            session = KernelSession(kernel, session_root, session_document, environment)
            sessions[sid] = session

        session.ws = ws
        try:
            await ws.send(json.dumps({
                "type": "attached",
                "protocol": PROTOCOL_VERSION,
                "session": sid,
                "resumed": resumed,
                "root": session.root,
                "document": session.document,
            }))
            if session.environment is not None:
                await ws.send(json.dumps(session.environment.event()))
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
                elif kind == "convert":
                    await ws.send(json.dumps(_convert_response(msg)))
                elif kind in {"open", "save", "stat", "rename"}:
                    await ws.send(json.dumps(_file_response(msg)))
                elif kind == "restart":
                    if "root" in msg:
                        session.root = _session_root(msg["root"], root)
                    if "document" in msg:
                        session.document = _session_document(msg["document"])
                    session.pump_task.cancel()
                    await asyncio.gather(session.pump_task, return_exceptions=True)
                    await session.kernel.stop()
                    session.kernel = KernelProcess()
                    try:
                        async with start_slots:
                            session.environment = await prepare_environment(
                                ws, session.document
                            )
                            await session.kernel.start(
                                cwd=session.root, environment=session.environment
                            )
                    except Exception:
                        sessions.pop(sid, None)
                        await report_start_failure(session.kernel, ws, {
                            "type": "kernel_exit",
                            "id": msg["id"],
                            "error": "Python engine failed to restart",
                        }, "kernel failed to restart")
                        return
                    await ws.send(json.dumps(session.environment.event()))
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
            if parent:
                await _exit_with_parent(parent)
            else:
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
    *,
    on_ready=None,
    root=None,
    parent=None,
):
    try:
        asyncio.run(serve(
            port,
            grace,
            origins,
            on_ready=on_ready,
            root=root,
            parent=parent,
        ))
    except KeyboardInterrupt:
        pass
