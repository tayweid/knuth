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

from . import env, files, state, web
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
        # document's own when it has a header, else the engine's Python —
        # or, from Knuth.app, a scratch one of the session's own.
        self.document = document
        self.environment = environment
        # The file uv manages for this session's environment: the document
        # itself, or its scratch stand-in (see environment_document).
        self.env_document = document
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
        "install",
        "chdir",
        "complete",
    }:
        return "unknown request type"
    if kind not in {"interrupt", "chdir"}:
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
    elif kind == "complete":
        if not isinstance(msg.get("code"), str) or len(msg["code"].encode("utf-8")) > MAX_CODE_BYTES:
            return "complete code must be a string within the code limit"
        offset = msg.get("offset")
        if type(offset) is not int or offset < 0:
            return "complete offset must be a non-negative integer"
    elif kind == "chdir":
        path = msg.get("path")
        if not isinstance(path, str) or not path or len(path) > MAX_PATH_CHARS:
            return f"chdir path must be a string of at most {MAX_PATH_CHARS} characters"
    elif kind == "install":
        module = msg.get("module")
        if not isinstance(module, str) or not module.isidentifier() or len(module) > MAX_NAME_CHARS:
            return "install module must be a module name"
        if "text" in msg and not isinstance(msg["text"], str):
            return "install text must be a string"
        if "download" in msg and not isinstance(msg["download"], bool):
            return "install download must be a boolean"
    elif kind == "restart":
        if "text" in msg and not isinstance(msg["text"], str):
            return "restart text must be a string"
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
            scratch_document(sid).unlink(missing_ok=True)

    def environment_document(sid, document, fresh, unsaved_text=None):
        """The file uv builds this session's environment from. A document
        with a header is its own. Otherwise every session still gets an
        environment (KNUTH_ENVIRONMENTS=off is for tests only): a scratch
        file with a fresh header, so that installing a package later lands
        in the environment the kernel is already running in — no restart,
        and the session keeps its variables (Taylor, 2026-09-27). `fresh`
        starts the scratch header over (a different document); otherwise
        it keeps the packages installed so far. `unsaved_text` is an unsaved
        document's own: when it has a header the scratch starts from it, so
        a document restored after a relaunch gets its packages back."""
        if document:
            text = env._read(document)
            if text is not None and env.find_header(text) is not None:
                return document
        if os.environ.get("KNUTH_ENVIRONMENTS") == "off" or env.find_uv() is None:
            return document
        scratch = scratch_document(sid)
        current = env._read(str(scratch)) if scratch.exists() else None
        if fresh or current is None or env.find_header(current) is None:
            scratch.parent.mkdir(parents=True, exist_ok=True)
            seeded = (
                unsaved_text
                if not document and isinstance(unsaved_text, str) and env.find_header(unsaved_text) is not None
                else "\n".join(env.new_header()) + "\n"
            )
            files.save_document(str(scratch), seeded)
        return str(scratch)

    def scratch_document(sid):
        """Where an unsaved document's packages are listed: uv reads a
        header from a file, and an unsaved document has none, so its
        session keeps a copy here (ENVIRONMENT.md). The header the page
        sees is spliced from it, so it travels with the text on save."""
        return state.state_dir() / "unsaved" / f"{sid}.py"

    async def report_start_failure(kernel, ws, event, reason):
        # One voice for both start-failure paths (first attach and restart):
        # stop the half-started process, say exactly what failed — closing
        # without a word leaves the app guessing, and its guess was "engine
        # unavailable", which is wrong: the engine answered, Python is what
        # failed — then close 1011.
        await kernel.stop()
        await ws.send(json.dumps(event))
        await ws.close(code=1011, reason=reason)

    async def install_package(ws, sid, session, msg):
        """Install a module a cell could not import, the one way Knuth
        installs anything: `uv add --script` into the header of the file
        this session's environment is built from, then sync (ENVIRONMENT.md).
        Without `download`, only from what uv already has on this Mac, and
        silently: no `dependency` events, and a failure answers `installed`
        with `download: true` so the page can ask. With it (the page's
        toast, the person said yes), uv may download, and says so. When
        that file is the session's environment, the running kernel sees
        the package at its next run — no restart. The header comes back as
        a `header` event naming that file, for the page to splice in.
        """
        module = msg["module"]
        distribution = env.distribution_for(module)
        base = {"type": "dependency", "id": msg["id"], "module": module, "distribution": distribution}
        target = session.env_document
        scratch = scratch_document(sid)
        is_scratch = target is not None and target == str(scratch)
        download = msg.get("download") is True

        async def refuse(reason, needs_download=False):
            if download:
                await ws.send(json.dumps({**base, "state": "failed", "error": reason}))
            await ws.send(json.dumps({
                "type": "installed", "id": msg["id"], "ok": False, "error": reason,
                **({"download": True} if needs_download else {}),
            }))

        if target is None and not isinstance(msg.get("text"), str):
            # A terminal engine's unsaved document: no environment to add to.
            await refuse("the document's text is needed to install into it")
            return
        if env.find_uv() is None:
            await refuse("uv is not installed")
            return
        if target is None:
            target, is_scratch = str(scratch), True

        def work():
            if is_scratch and isinstance(msg.get("text"), str):
                # The page's header is the one to keep in step with.
                if env.find_header(msg["text"]) is not None or not scratch.exists():
                    scratch.parent.mkdir(parents=True, exist_ok=True)
                    saved = files.save_document(target, msg["text"])
                    if "error" in saved:
                        return False, saved["error"]
            text = env._read(target)
            if text is None:
                return False, "the document could not be read"
            if env.find_header(text) is None:
                header_text, _ = env.with_header(text)
                saved = files.save_document(target, header_text)
                if "error" in saved:
                    return False, saved["error"]
            return env.add_dependency(target, distribution, offline=not download)

        if download:
            await ws.send(json.dumps({**base, "state": "installing"}))
        ok, reason = await asyncio.to_thread(work)
        if not ok:
            await refuse(reason or f"uv could not install {distribution}", needs_download=not download)
            return
        text = env._read(target) or ""
        if download:
            await ws.send(json.dumps({
                **base, "state": "installed", "version": env.pinned_version(text, distribution),
            }))
        lines = env.header_lines(text)
        if lines is not None:
            try:
                modified = int(os.stat(target).st_mtime * 1000)
            except OSError:
                modified = None
            await ws.send(json.dumps({
                "type": "header", "id": msg["id"], "path": target,
                "lines": lines, "modified": modified,
            }))
        in_place = (
            session.environment is not None and session.environment.managed
            and session.env_document == target
        )
        if not in_place:
            session.env_document = target  # the restart the page sends builds it
        await ws.send(json.dumps({"type": "installed", "id": msg["id"], "ok": True, "restart": not in_place}))

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
            unsaved_text = first.get("text")
            if not isinstance(unsaved_text, str) or len(unsaved_text.encode("utf-8")) > MAX_CODE_BYTES:
                unsaved_text = None
            env_document = environment_document(sid, session_document, fresh=True, unsaved_text=unsaved_text)
            try:
                async with start_slots:
                    environment = await prepare_environment(ws, env_document)
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
            session.env_document = env_document
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
                elif kind == "install":
                    await install_package(ws, sid, session, msg)
                elif kind == "chdir":
                    session.root = _session_root(msg["path"], session.root)
                    await session.kernel.send(msg)
                elif kind == "restart":
                    if "root" in msg:
                        session.root = _session_root(msg["root"], root)
                    fresh = False
                    if "document" in msg:
                        document = _session_document(msg["document"])
                        fresh = document != session.document
                        session.document = document
                    session.env_document = environment_document(
                        sid, session.document, fresh or "text" in msg, unsaved_text=msg.get("text")
                    )
                    session.pump_task.cancel()
                    await asyncio.gather(session.pump_task, return_exceptions=True)
                    await session.kernel.stop()
                    session.kernel = KernelProcess()
                    try:
                        async with start_slots:
                            session.environment = await prepare_environment(
                                ws, session.env_document
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
            # No keepalive pings. While a restart waits on uv (minutes, the
            # first time), this loop reads nothing; the page's requests fill
            # the queue, reading pauses, the page's pong goes unread, and the
            # library closed the socket at 60 s — the page reconnected and
            # started a second sync. The socket is loopback: a closed window
            # closes it, and there is no network in between to watch.
            ping_interval=None,
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
            if os.environ.get("KNUTH_ENVIRONMENTS") != "off":
                # Code hints: Jedi, once, in the background (knuth.env.tools_dir).
                tools = asyncio.create_task(asyncio.to_thread(env.ensure_tools))
                tools.add_done_callback(lambda task: task.exception())
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
