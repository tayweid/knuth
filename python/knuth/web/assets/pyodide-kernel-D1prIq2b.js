import{t as e}from"./index-zct07XcG.js";var t=`from .session import Session

__all__ = ["Session"]
`,n=`"""Safe names and ownership metadata for generated project artifacts."""

import json
import unicodedata


MANIFEST_NAME = ".knuth-artifacts.json"
MANIFEST_VERSION = 1
MAX_FIGURE_NAME_BYTES = 128
WINDOWS_RESERVED_NAMES = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


def is_safe_figure_name(name):
    """Whether a Python binding is one portable SVG filename component."""
    return bool(
        isinstance(name, str)
        and name
        and not name.startswith("_")
        and name.isidentifier()
        and name == unicodedata.normalize("NFC", name)
        and len(name.encode("utf-8")) <= MAX_FIGURE_NAME_BYTES
        and name.upper() not in WINDOWS_RESERVED_NAMES
    )


def figure_path(name):
    if not is_safe_figure_name(name):
        raise ValueError(f"unsafe figure artifact name: {name!r}")
    return f"figs/{name}.svg"


def manifest_text(names):
    paths = sorted(figure_path(name) for name in names)
    return json.dumps(
        {"version": MANIFEST_VERSION, "figures": paths},
        indent=2,
        ensure_ascii=False,
    ) + "\\n"


def owned_figure_names(raw):
    """Parse only safe current-format paths; malformed manifests own nothing."""
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return set()
    if not isinstance(data, dict) or data.get("version") != MANIFEST_VERSION:
        return set()
    paths = data.get("figures")
    if not isinstance(paths, list):
        return set()
    names = set()
    for path in paths:
        if not isinstance(path, str) or not path.startswith("figs/") or not path.endswith(".svg"):
            return set()
        name = path[len("figs/") : -len(".svg")]
        if not is_safe_figure_name(name) or figure_path(name) != path:
            return set()
        names.add(name)
    return names
`,r=`"""Named resource limits at Knuth's browser/kernel trust boundaries.

These defaults are intentionally generous for interactive analysis while
bounding unauthenticated frames, live subprocesses, and data retained by the
browser. Changing them is a compatibility and security decision, so they live
in one small module rather than as incidental library defaults.
"""

HANDSHAKE_TIMEOUT_SECONDS = 10
MAX_INBOUND_MESSAGE_BYTES = 1 * 1024 * 1024
MAX_INBOUND_MESSAGE_QUEUE = 16

MAX_LIVE_SESSIONS = 8
MAX_CONCURRENT_KERNEL_STARTS = 2

MAX_SESSION_ID_CHARS = 128
MAX_REQUEST_ID = (1 << 53) - 1
MAX_CODE_BYTES = 512 * 1024
MAX_NAME_CHARS = 256

MAX_STREAM_BYTES_PER_RUN = 4 * 1024 * 1024
MAX_STREAM_EVENT_CHARS = 16 * 1024
MAX_RESULT_BYTES = 1 * 1024 * 1024
MAX_TRACEBACK_BYTES = 512 * 1024
MAX_FIGURE_BYTES = 8 * 1024 * 1024
MAX_FIGURE_BYTES_PER_RUN = 16 * 1024 * 1024
MAX_FIGURES_PER_RUN = 16
MAX_KERNEL_EVENT_BYTES = 40 * 1024 * 1024
MAX_ARTIFACT_RESPONSE_BYTES = 32 * 1024 * 1024
MAX_NAMESPACE_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_TABLE_RESPONSE_BYTES = 8 * 1024 * 1024
`,i=`"""The live session: a persistent namespace that runs cells REPL-style.

Used in-process by \`knuth run\` (Milestone 5) and by the kernel subprocess
behind the WebSocket server (this milestone). Holds no I/O of its own —
stdout/stderr redirection is the kernel's job.
"""

import ast
import json
import sys
import traceback
import types

from .artifacts import is_safe_figure_name

# values.json size guard: a "small serializable" stops being small here.
MAX_VALUE_JSON = 10_000

# Data viewer windowing: rows per request (clamped) and a column cap so a
# thousand-column frame can't flood the socket.
MAX_TABLE_LIMIT = 500
MAX_TABLE_COLS = 200


def _persistable(value):
    """(value, ok): JSON-safe mirror of a namespace value, or ok=False.
    Unwraps numpy scalars; rejects non-finite floats, big payloads, and
    anything json can't express (DataFrames stay session-only)."""
    if type(value).__module__ == "numpy" and hasattr(value, "item"):
        try:
            value = value.item()
        except Exception:
            return None, False
    if not (value is None or isinstance(value, (bool, int, float, str, list, tuple, dict))):
        return None, False
    try:
        encoded = json.dumps(value, allow_nan=False)
    except (TypeError, ValueError):
        return None, False
    if len(encoded) > MAX_VALUE_JSON:
        return None, False
    return value, True


def _target_names(target):
    if isinstance(target, ast.Name):
        return {target.id}
    if isinstance(target, (ast.Tuple, ast.List)):
        names = set()
        for elt in target.elts:
            names |= _target_names(elt)
        return names
    if isinstance(target, ast.Starred):
        return _target_names(target.value)
    return set()


def _assigned_names(tree):
    """Top-level names a cell binds — how scratch state is told apart from
    program state in the shared v1 namespace."""
    names = set()
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                names |= _target_names(target)
        elif isinstance(node, (ast.AugAssign, ast.AnnAssign, ast.For, ast.AsyncFor)):
            names |= _target_names(node.target)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                names.add((alias.asname or alias.name).split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                names.add(alias.asname or alias.name)
        elif isinstance(node, (ast.With, ast.AsyncWith)):
            for item in node.items:
                if item.optional_vars is not None:
                    names |= _target_names(item.optional_vars)
    return names


def capture_open_figures(max_figures=None):
    """Display support (Jupyter-inline semantics): render open pyplot
    figures to SVG and close all of them. A caller may cap the rendered count;
    named Figure objects survive closing and still persist via artifacts()."""
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None:
        return []
    svgs = []
    numbers = plt.get_fignums()
    if max_figures is not None:
        numbers = numbers[:max_figures]
    for num in numbers:
        try:
            svgs.append(_figure_svg(plt.figure(num)))
        except Exception:
            pass
    plt.close("all")
    return svgs


def _is_figure(value):
    t = type(value)
    return t.__name__ == "Figure" and t.__module__.startswith("matplotlib")


def _owning_figure(value):
    """The Figure behind a named value: a Figure itself, any matplotlib
    artist (\`ax\`, a Line2D), or a list of artists from one figure — so the
    natural \`p = plt.plot(...)\` persists figs/p.svg, not just
    \`fig, ax = plt.subplots()\`."""
    if _is_figure(value):
        return value
    fig = getattr(value, "figure", None)
    if fig is not None and _is_figure(fig):
        return fig
    if isinstance(value, (list, tuple)) and value:
        owners = {
            id(f): f
            for f in (getattr(item, "figure", None) for item in value)
            if f is not None and _is_figure(f)
        }
        if len(owners) == 1:
            return next(iter(owners.values()))
    return None


def _figure_svg(fig):
    import io

    buf = io.StringIO()
    fig.savefig(buf, format="svg")
    return buf.getvalue()


class Session:
    def __init__(self):
        self.namespace = {"__name__": "__main__"}
        # Names bound by scratch cells (shared-namespace v1): visible in
        # the session, excluded from persistence, badged in the explorer.
        # A program cell binding the same name reclaims it.
        self.scratch_names = set()
        # Names bound by the most recent run — how figure receipts know
        # which cell touched which figure.
        self.last_assigned = set()

    def reset(self):
        self.namespace = {"__name__": "__main__"}
        self.scratch_names = set()
        self.last_assigned = set()

    def run(self, code, scratch=False):
        """Execute a cell. Returns (ok, payload): payload is the repr of the
        last expression (None if the cell ends in a statement or None) on
        success, the formatted traceback on failure."""
        try:
            tree = ast.parse(code, "<cell>")
        except SyntaxError as e:
            return False, "".join(traceback.format_exception_only(e))

        assigned = _assigned_names(tree)
        self.last_assigned = assigned
        if scratch:
            self.scratch_names |= assigned
        else:
            self.scratch_names -= assigned

        last = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last = ast.Expression(tree.body[-1].value)
            tree.body = tree.body[:-1]

        try:
            if tree.body:
                exec(compile(tree, "<cell>", "exec"), self.namespace)
            if last is not None:
                value = eval(compile(last, "<cell>", "eval"), self.namespace)
                self.namespace["_"] = value
                if value is not None:
                    return True, repr(value)
            return True, None
        except BaseException as e:  # keep the session alive through exit()/interrupt
            return False, self._format_traceback(e)

    def snapshot(self):
        """Namespace summary for the variable explorer and persistence layer:
        [{name, type, shape?|length?, preview}], underscore names and modules
        excluded."""
        out = []
        for name, value in self.namespace.items():
            if (
                not isinstance(name, str)
                or name.startswith("_")
                or isinstance(value, types.ModuleType)
            ):
                continue
            entry = {"name": name, "type": type(value).__name__}
            shape = getattr(value, "shape", None)
            if isinstance(shape, tuple):
                entry["shape"] = list(shape)
            elif hasattr(value, "__len__"):
                try:
                    entry["length"] = len(value)
                except Exception:
                    pass
            try:
                preview = repr(value)
            except Exception:
                preview = "<unrepresentable>"
            entry["preview"] = preview[:80] + ("…" if len(preview) > 80 else "")
            if name in self.scratch_names:
                entry["scratch"] = True
            if _owning_figure(value) is not None:
                entry["figure"] = True
            out.append(entry)
        return out

    def table(self, name, offset=0, limit=100):
        """A window into a tabular variable for the data viewer:
        DataFrame, Series (one column), or 2-D ndarray. Cells arrive as
        strings; the full object never leaves the session."""
        if name not in self.namespace:
            return {"name": name, "error": "no such variable"}
        value = self.namespace[name]
        t = type(value)
        mod = t.__module__ or ""
        offset = max(0, int(offset))
        limit = max(1, min(int(limit), MAX_TABLE_LIMIT))
        try:
            if mod.startswith("pandas") and t.__name__ in ("DataFrame", "Series"):
                df = value.to_frame() if t.__name__ == "Series" else value
                total_rows, total_cols = df.shape
                window = df.iloc[offset : offset + limit, :MAX_TABLE_COLS]
                columns = [str(c) for c in window.columns]
                rows = [
                    [str(x) for x in row]
                    for row in window.itertuples(index=False, name=None)
                ]
                index = [str(i) for i in window.index]
            elif mod == "numpy" and t.__name__ == "ndarray" and getattr(value, "ndim", 0) == 2:
                total_rows, total_cols = value.shape
                window = value[offset : offset + limit, :MAX_TABLE_COLS]
                columns = [str(i) for i in range(window.shape[1])]
                rows = [[str(x) for x in r] for r in window]
                index = [str(i) for i in range(offset, offset + len(rows))]
            else:
                return {"name": name, "error": f"{t.__name__} is not tabular"}
        except Exception as e:
            return {"name": name, "error": str(e)}
        return {
            "name": name,
            "columns": columns,
            "index": index,
            "rows": rows,
            "total_rows": int(total_rows),
            "total_cols": int(total_cols),
            "offset": offset,
        }

    def figure(self, name):
        """Render the figure behind a named variable for the viewer pane."""
        if name not in self.namespace:
            return {"name": name, "error": "no such variable"}
        fig = _owning_figure(self.namespace[name])
        if fig is None:
            return {"name": name, "error": f"{type(self.namespace[name]).__name__} has no figure"}
        try:
            return {"name": name, "svg": _figure_svg(fig)}
        except Exception as e:
            return {"name": name, "error": str(e)}

    def figure_bindings(self):
        """One canonical name per live figure ({name: Figure}): direct
        Figure bindings beat artist references (fig wins over ax), and
        namespace order breaks remaining ties — so \`fig, ax = subplots()\`
        persists one figs/fig.svg, not a duplicate pair."""
        candidates = []
        for name, value in self.namespace.items():
            if (
                not is_safe_figure_name(name)
                or name in self.scratch_names
                or isinstance(value, types.ModuleType)
            ):
                continue
            fig = _owning_figure(value)
            if fig is not None:
                candidates.append((name, fig, _is_figure(value)))
        chosen = {}
        for name, fig, direct in sorted(candidates, key=lambda c: not c[2]):
            chosen.setdefault(id(fig), (name, fig))
        bindings = {}
        filesystem_names = set()
        for name, fig in chosen.values():
            collision_key = name.casefold()
            if collision_key in filesystem_names:
                continue
            filesystem_names.add(collision_key)
            bindings[name] = fig
        return bindings

    def figure_receipts(self, assigned):
        """Canonical figure names touched by the given bindings — what a
        cell's output block should reference as figs/<name>.svg."""
        by_id = {id(fig): name for name, fig in self.figure_bindings().items()}
        touched = set()
        for name in assigned:
            if name not in self.namespace:
                continue
            fig = _owning_figure(self.namespace[name])
            if fig is not None and id(fig) in by_id:
                touched.add(by_id[id(fig)])
        return sorted(touched)

    def artifacts(self):
        """The folder contract (DESIGN.md auto-persistence): a JSON-safe
        mirror of the namespace for values.json, and named figures rendered
        to SVG text for figs/<name>.svg. Underscore names are private;
        modules and non-serializables (DataFrames included) stay behind."""
        values = {}
        for name, value in self.namespace.items():
            if (
                not isinstance(name, str)
                or name.startswith("_")
                or isinstance(value, types.ModuleType)
            ):
                continue
            if name in self.scratch_names:  # scratch never persists
                continue
            if _owning_figure(value) is not None:
                continue  # figures persist under their canonical name below
            mirrored, ok = _persistable(value)
            if ok:
                values[name] = mirrored
        figures = {}
        for name, fig in self.figure_bindings().items():
            try:
                figures[name] = _figure_svg(fig)
            except Exception:
                pass
        return values, figures

    def _format_traceback(self, e):
        # Hide our own frames: report from the first frame inside the cell.
        tb = e.__traceback__
        while tb is not None and tb.tb_frame.f_code.co_filename != "<cell>":
            tb = tb.tb_next
        return "".join(traceback.format_exception(type(e), e, tb))
`,a=`"""Kernel subprocess: line-delimited JSON on stdin/stdout around a Session.

Run as \`python -m knuth.kernel\` by the server, never directly by users.
User code's stdout/stderr are redirected into \`stream\` events; the real
stdout carries only protocol events. SIGINT lands here as KeyboardInterrupt:
during a run it surfaces as an \`error\` event, while idle it is swallowed.

Events out: ready | stream{id,which,text} | done{id,result} |
            error{id,traceback} | namespace{id,vars}
Commands in: run{id,code} | namespace{id}
"""

import io
import json
import signal
import sys

from .limits import (
    MAX_ARTIFACT_RESPONSE_BYTES,
    MAX_FIGURE_BYTES,
    MAX_FIGURE_BYTES_PER_RUN,
    MAX_FIGURES_PER_RUN,
    MAX_NAMESPACE_RESPONSE_BYTES,
    MAX_RESULT_BYTES,
    MAX_STREAM_BYTES_PER_RUN,
    MAX_STREAM_EVENT_CHARS,
    MAX_TABLE_RESPONSE_BYTES,
    MAX_TRACEBACK_BYTES,
)
from .session import Session, capture_open_figures


class OutputLimitExceeded(RuntimeError):
    """Stop a run whose stdout/stderr would otherwise grow without bound."""


def _raise_keyboard_interrupt(_signum, _frame):
    """Give Windows Ctrl-Break the same cell-interrupt semantics as SIGINT."""
    raise KeyboardInterrupt


def _install_interrupt_handler():
    if sys.platform == "win32":
        signal.signal(signal.SIGBREAK, _raise_keyboard_interrupt)


def _utf8_size(text):
    return len(text.encode("utf-8"))


def _truncate_utf8(text, limit):
    encoded = text.encode("utf-8")
    if len(encoded) <= limit:
        return text, False
    marker = f"\\n… [truncated at {limit} bytes]"
    marker_bytes = marker.encode("utf-8")
    if len(marker_bytes) > limit:
        return encoded[:limit].decode("utf-8", errors="ignore"), True
    available = limit - len(marker_bytes)
    prefix = encoded[:available].decode("utf-8", errors="ignore")
    return prefix + marker, True


def _event_size(event):
    return len(json.dumps(event, ensure_ascii=False).encode("utf-8"))


class _StreamOut(io.TextIOBase):
    def __init__(self, emit, state, which):
        self._emit = emit
        self._state = state
        self._which = which

    def writable(self):
        return True

    def write(self, s):
        if s:
            encoded = s.encode("utf-8")
            remaining = MAX_STREAM_BYTES_PER_RUN - self._state["stream_bytes"]
            allowed = encoded[: max(0, remaining)].decode("utf-8", errors="ignore")
            for start in range(0, len(allowed), MAX_STREAM_EVENT_CHARS):
                self._emit({
                    "type": "stream",
                    "id": self._state["id"],
                    "which": self._which,
                    "text": allowed[start : start + MAX_STREAM_EVENT_CHARS],
                })
            self._state["stream_bytes"] += _utf8_size(allowed)
            if len(encoded) > _utf8_size(allowed):
                raise OutputLimitExceeded(
                    f"cell output exceeded the {MAX_STREAM_BYTES_PER_RUN}-byte limit"
                )
        return len(s)


def handle_request(msg, session, state, emit):
    """Serve one request against a session, emitting protocol events.

    Extracted from the subprocess loop so a second host can drive the same
    semantics: Pyodide runs this in the browser tab, where there is no stdin
    to read and no subprocess to be. Anything that diverges here is a way for
    the two backends to disagree, so nothing should.
    """
    kind = msg.get("type")
    if kind == "run":
        state["id"] = msg["id"]
        state["stream_bytes"] = 0
        ok, payload = session.run(msg["code"], scratch=bool(msg.get("scratch")))
        svgs = capture_open_figures(MAX_FIGURES_PER_RUN)
        named = [] if msg.get("scratch") else session.figure_receipts(
            session.last_assigned
        )
        kept_svgs = []
        figure_bytes = 0
        omitted = 0
        for svg in svgs:
            size = _utf8_size(svg)
            if (
                len(kept_svgs) >= MAX_FIGURES_PER_RUN
                or size > MAX_FIGURE_BYTES
                or figure_bytes + size > MAX_FIGURE_BYTES_PER_RUN
            ):
                omitted += 1
                continue
            kept_svgs.append(svg)
            figure_bytes += size
        if len(named) > MAX_FIGURES_PER_RUN:
            omitted += len(named) - MAX_FIGURES_PER_RUN
            named = named[:MAX_FIGURES_PER_RUN]
        if omitted:
            emit({
                "type": "stream",
                "id": msg["id"],
                "which": "stderr",
                "text": f"Knuth omitted {omitted} figure(s) that exceeded display limits.\\n",
            })
        if kept_svgs or named:
            emit({
                "type": "figures",
                "id": msg["id"],
                "svgs": kept_svgs,
                "named": named,
            })
        if ok:
            result, truncated = (
                _truncate_utf8(payload, MAX_RESULT_BYTES)
                if payload is not None
                else (None, False)
            )
            event = {"type": "done", "id": msg["id"], "result": result}
            if truncated:
                event["truncated"] = True
            emit(event)
        else:
            traceback, truncated = _truncate_utf8(payload, MAX_TRACEBACK_BYTES)
            event = {"type": "error", "id": msg["id"], "traceback": traceback}
            if truncated:
                event["truncated"] = True
            emit(event)
        state["id"] = None
    elif kind == "namespace":
        event = {"type": "namespace", "id": msg["id"], "vars": session.snapshot()}
        if _event_size(event) <= MAX_NAMESPACE_RESPONSE_BYTES:
            emit(event)
        else:
            emit({
                "type": "protocol_error",
                "request": "namespace",
                "id": msg["id"],
                "error": "namespace response exceeds the configured limit",
            })
    elif kind == "artifacts":
        values, figures = session.artifacts()
        event = {
            "type": "artifacts",
            "id": msg["id"],
            "values": values,
            "figures": figures,
        }
        if _event_size(event) <= MAX_ARTIFACT_RESPONSE_BYTES:
            emit(event)
        else:
            emit({
                "type": "protocol_error",
                "request": "artifacts",
                "id": msg["id"],
                "error": "artifact response exceeds the configured limit",
            })
    elif kind == "figure":
        result = session.figure(msg.get("name", ""))
        if "svg" in result and _utf8_size(result["svg"]) > MAX_FIGURE_BYTES:
            result = {
                "name": result["name"],
                "error": "figure exceeds the configured display limit",
            }
        emit({"type": "figure", "id": msg["id"], **result})
    elif kind == "table":
        event = {
            "type": "table",
            "id": msg["id"],
            **session.table(
                msg.get("name", ""), msg.get("offset", 0), msg.get("limit", 100)
            ),
        }
        if _event_size(event) <= MAX_TABLE_RESPONSE_BYTES:
            emit(event)
        else:
            emit({
                "type": "protocol_error",
                "request": "table",
                "id": msg["id"],
                "error": "table response exceeds the configured limit",
            })


def main():
    _install_interrupt_handler()
    real_stdout = sys.stdout
    stdin = sys.stdin

    def emit(event):
        real_stdout.write(json.dumps(event, ensure_ascii=False) + "\\n")
        real_stdout.flush()

    state = {"id": None, "stream_bytes": 0}
    sys.stdout = _StreamOut(emit, state, "stdout")
    sys.stderr = _StreamOut(emit, state, "stderr")

    session = Session()
    emit({"type": "ready"})

    while True:
        try:
            line = stdin.readline()
            if not line:
                break
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            handle_request(msg, session, state, emit)
        except KeyboardInterrupt:
            # Interrupt arrived while idle (or between commands): ignore.
            state["id"] = None
            continue


if __name__ == "__main__":
    main()
`,o=`https://cdn.jsdelivr.net/pyodide/v0.28.3/full/`,s=`
import json, sys
import knuth.kernel as kernel_module
from knuth.kernel import Session, _StreamOut, handle_request

_state = {"id": None, "stream_bytes": 0}
_session = Session()

def _emit(event):
    _knuth_emit(json.dumps(event, ensure_ascii=False))

sys.stdout = _StreamOut(_emit, _state, "stdout")
sys.stderr = _StreamOut(_emit, _state, "stderr")

def knuth_handle(raw):
    msg = json.loads(raw)
    if msg.get("type") == "restart":
        global _session
        _session = Session()
        _emit({"type": "ready", "id": msg.get("id")})
        return
    handle_request(msg, _session, _state, _emit)

def knuth_reset():
    global _session
    _session = Session()
`,c=class{onStatus;pyodide=null;ready;closed=!1;nextId=1;runs=new Map;waiters=new Map;constructor(e){this.onStatus=e,this.onStatus?.(`connecting`),this.ready=this.boot().then(()=>this.onStatus?.(`ready`,!1),e=>{console.error(`Pyodide failed to start`,e),this.onStatus?.(`kernel_failed`)})}async boot(){let{loadPyodide:c}=await e(async()=>{let{loadPyodide:e}=await import(`${o}pyodide.mjs`);return{loadPyodide:e}},[],import.meta.url),l=await c({indexURL:o});l.FS.mkdirTree(`/lib/knuth`);let u=[[`__init__.py`,t],[`artifacts.py`,n],[`limits.py`,r],[`session.py`,i],[`kernel.py`,a]];for(let[e,t]of u)l.FS.writeFile(`/lib/knuth/${e}`,t,{encoding:`utf8`});l.runPython(`import sys; sys.path.insert(0, "/lib")`),l.globals.set(`_knuth_emit`,e=>this.receive(e)),l.runPython(s),this.pyodide=l}receive(e){let t;try{t=JSON.parse(e)}catch{return}let n=typeof t.id==`number`?t.id:null;if(t.type===`stream`&&n!==null){this.runs.get(n)?.handlers?.onStream?.(t.which,String(t.text??``));return}if(t.type===`figures`&&n!==null){this.runs.get(n)?.handlers?.onFigures?.(t.svgs??[],t.named??[]);return}if(t.type===`done`&&n!==null){this.runs.get(n)?.resolve({ok:!0,result:t.result??null,traceback:null}),this.runs.delete(n);return}if(t.type===`error`&&n!==null){this.runs.get(n)?.resolve({ok:!1,result:null,traceback:String(t.traceback??`error`)}),this.runs.delete(n);return}n!==null&&this.waiters.has(n)&&(this.waiters.get(n)(t),this.waiters.delete(n))}async send(e){if(await this.ready,this.closed||!this.pyodide)return;let t=this.pyodide;t.globals.set(`_knuth_request`,JSON.stringify(e)),await t.runPythonAsync(`knuth_handle(_knuth_request)`)}async ask(e,t,n){if(await this.ready,this.closed||!this.pyodide)return n;let r=this.nextId++;return new Promise(i=>{this.waiters.set(r,e=>i(e.type===`protocol_error`?n:t(e))),this.send({...e,id:r}).catch(()=>{this.waiters.delete(r),i(n)})})}async run(e,t,n){if(await this.ready,this.closed||!this.pyodide)return{ok:!1,result:null,traceback:`Python is not running`};try{await this.pyodide.loadPackagesFromImports(e)}catch(e){console.warn(`Could not preload packages for this cell`,e)}let r=this.nextId++;return new Promise(i=>{this.runs.set(r,{handlers:t,resolve:i}),this.send({type:`run`,id:r,code:e,scratch:n?.scratch??!1}).catch(e=>{this.runs.delete(r),i({ok:!1,result:null,traceback:String(e)})})})}interrupt(){console.warn(`Interrupt is not available in the browser preview.`)}async restart(){if(await this.ready,this.closed||!this.pyodide)return;let e=this.nextId++;await new Promise(t=>{this.waiters.set(e,()=>t()),this.send({type:`restart`,id:e}).catch(()=>t())}),this.onStatus?.(`ready`,!1)}namespace(){return this.ask({type:`namespace`},e=>e.vars??[],[])}artifacts(){return this.ask({type:`artifacts`},e=>({values:e.values??{},figures:e.figures??{}}),null)}table(e,t=0,n=100){return this.ask({type:`table`,name:e,offset:t,limit:n},e=>e,null)}figure(e){return this.ask({type:`figure`,name:e},e=>e,null)}close(){this.closed=!0}};export{c as PyodideKernel};