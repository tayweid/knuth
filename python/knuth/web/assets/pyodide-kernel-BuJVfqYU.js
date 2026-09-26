import{t as e}from"./index-Dx48FI26.js";var t=/^\s*#\s*[%!]\s*pip\s+install\s+(.+?)\s*$/;function n(e){let n=[];for(let r of e.split(`
`)){let e=t.exec(r);if(e)for(let t of e[1].split(/\s+/))t&&!t.startsWith(`-`)&&!n.includes(t)&&n.push(t)}return n}var r=`from .session import Session

__all__ = ["Session"]
`,i=`"""Safe names and ownership metadata for generated project artifacts."""

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
`,a=`"""Writing the folder contract: values.json, figs/<name>.svg, and the
ownership manifest, atomically and in one place.

Two producers share this: \`knuth run\` (runner.py) regenerates the contract
at the end of a clean reproduction, and the live kernel (kernel.py) does the
same on the app's \`persist\` request after program cells run. They must write
the same bytes the same way — a figure the app wrote and \`knuth run\` later
deletes, or the reverse, would be a contract with two authors.

Every write is staged beside its destination and moved into place with
os.replace, so a reader (typst, git, a watcher) never sees a partial file.
"""

import json
import os
import stat
import tempfile
from pathlib import Path

from .artifacts import MANIFEST_NAME, figure_path, manifest_text, owned_figure_names


def stage_text(path, text):
    """Flush complete bytes beside their destination without changing it."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        if path.exists():
            temporary.chmod(stat.S_IMODE(path.stat().st_mode))
        return temporary
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def atomic_write(path, text):
    temporary = stage_text(path, text)
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def write_contract(root, values, figures, extra=()):
    """Stage the complete contract (plus any \`extra\` (path, text) files that
    must land in the same generation, e.g. the document with its receipts),
    then replace each file, then commit ownership.

    Figures named in the previous manifest but absent now are removed:
    Knuth deletes only what it wrote. Without a valid manifest nothing is
    owned and nothing is deleted.
    """
    root = Path(root)
    manifest_path = root / MANIFEST_NAME
    try:
        previous = owned_figure_names(manifest_path.read_text(encoding="utf-8"))
    except OSError:
        previous = set()

    current = set(figures)
    staged = [(stage_text(path, text), Path(path)) for path, text in extra]
    try:
        staged.append((
            stage_text(root / "values.json", json.dumps(values, indent=2) + "\\n"),
            root / "values.json",
        ))
        for name in sorted(current):
            destination = root / figure_path(name)
            staged.append((stage_text(destination, figures[name]), destination))
        staged_manifest = stage_text(manifest_path, manifest_text(current))
    except BaseException:
        for temporary, _ in staged:
            temporary.unlink(missing_ok=True)
        raise

    try:
        for temporary, destination in staged:
            os.replace(temporary, destination)
        for name in previous - current:
            (root / figure_path(name)).unlink(missing_ok=True)
        # Last means this record never claims ownership of an SVG that was
        # not already written successfully in this generation.
        os.replace(staged_manifest, manifest_path)
    finally:
        for temporary, _ in staged:
            temporary.unlink(missing_ok=True)
        staged_manifest.unlink(missing_ok=True)
`,o=`"""Import Jupyter notebooks: .ipynb in, percent-format .py out.

One-way by design (DESIGN.md: the document is a plain .py file), and
implemented once, in Python — the app converts through the server's
\`convert\` request (server.py) rather than growing a second converter
in TypeScript.

The mapping (decided 2026-08-19):
- code cell -> program cell; magic and shell-escape lines (%..., !...)
  are commented out — they are not Python and would error under a real
  kernel — and any line that would read as a cell marker is prefixed so
  one notebook cell can never explode into several.
- markdown cell -> text cell with the canonical "# " prose prefix.
- raw cell -> program cell, fully commented out (preserved, not Python).
- outputs and execution counts are dropped: receipts are things Knuth
  itself reproduced, and \`knuth run\` regenerates them.
"""

from pathlib import Path
import json

from .percent import MARKER, Cell, Document, serialize_document

MAGIC_PREFIXES = ("%", "!")


def _safe(line):
    """Never emit a line the percent parser would read as a cell marker."""
    return "# " + line if MARKER.match(line) else line


def _source_lines(cell):
    source = cell.get("source", "")
    if isinstance(source, list):
        source = "".join(part for part in source if isinstance(part, str))
    if not isinstance(source, str):
        source = ""
    return source.splitlines()


def notebook_to_document(text):
    """Parse .ipynb JSON into a percent Document.

    Returns (document, commented) where commented counts the lines that
    had to be commented out. Raises ValueError for anything that is not
    an nbformat-4 notebook.
    """
    try:
        data = json.loads(text)
    except ValueError:
        raise ValueError("not a notebook (invalid JSON)") from None
    if not isinstance(data, dict) or not isinstance(data.get("cells"), list):
        raise ValueError("not a notebook (no cells list)")
    if data.get("nbformat") != 4:
        raise ValueError(f"unsupported nbformat {data.get('nbformat')!r} (4 required)")

    doc = Document(trailing_newline=True)
    commented = 0
    for raw in data["cells"]:
        if not isinstance(raw, dict):
            raise ValueError("malformed notebook cell")
        kind = raw.get("cell_type")
        lines = _source_lines(raw)
        if kind == "code":
            source = []
            for line in lines:
                if line.lstrip().startswith(MAGIC_PREFIXES):
                    source.append(_safe("# " + line))
                    commented += 1
                else:
                    before = line
                    line = _safe(line)
                    commented += line is not before
                    source.append(line)
            cell = Cell("program", "# %%", source)
        elif kind == "markdown":
            source = [_safe("# " + line) if line else "#" for line in lines]
            cell = Cell("text", "# %% [markdown]", source)
        elif kind == "raw":
            source = [_safe("# " + line) if line else "#" for line in lines]
            commented += len(lines)
            cell = Cell("program", "# %%", source)
        else:
            raise ValueError(f"unknown cell type {kind!r}")
        doc.cells.append(cell)

    # Blank separator lines between cells, the percent-file convention.
    for cell in doc.cells[:-1]:
        cell.source.append("")
    return doc, commented


def import_files(files, echo=print):
    """Convert each notebook to a sibling .py; never overwrite anything.

    Returns 1 if any file failed or was skipped, 0 when all converted.
    """
    failed = False
    for name in files:
        path = Path(name)
        target = path.with_suffix(".py")
        if not path.exists():
            echo(f"knuth import: no such file: {name}")
            failed = True
            continue
        if target.exists():
            echo(f"knuth import: refusing to overwrite {target}")
            failed = True
            continue
        try:
            doc, commented = notebook_to_document(path.read_text(encoding="utf-8"))
        except ValueError as error:
            echo(f"knuth import: {path.name}: {error}")
            failed = True
            continue
        # newline="" so the LF the serializer emits is what lands on disk,
        # on every platform (DESIGN.md: everything Knuth writes is LF).
        with target.open("w", encoding="utf-8", newline="") as stream:
            stream.write(serialize_document(doc))
        note = f", {commented} line(s) commented out" if commented else ""
        echo(f"{path.name} -> {target.name} ({len(doc.cells)} cells{note})")
    return 1 if failed else 0
`,s=`"""Named resource limits at Knuth's browser/kernel trust boundaries.

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

# Documents by path (files.py): what the engine will read into one event,
# and how long a path it will consider at all.
MAX_DOCUMENT_BYTES = 8 * 1024 * 1024
MAX_PATH_CHARS = 4096
`,c=`"""Percent-format (.py) document model — Python port of src/format/percent.ts,
same semantics, kept honest by round-tripping the same corpus in tests.

Cells open with "# %%" ("#%%" tolerated, marker preserved verbatim);
"# %% [markdown]" is a text cell; "# %% scratch" (exact token) is a scratch
cell; anything else is a program cell. Outputs are machine-managed "#->"
comment lines forming the trailing run of their cell. Scratch bodies are
stored commented ("#| " prefix) so plain \`python file.py\` runs only
program cells; "#|" can never match MARKER, so the encoding is lossless.
"""

import re
from dataclasses import dataclass, field

MARKER = re.compile(r"^# ?%%(.*)$")
OUTPUT_PREFIX = "#->"
SCRATCH_PREFIX = "#| "
SCRATCH_BLANK = "#|"


@dataclass
class Cell:
    kind: str  # 'program' | 'scratch' | 'text'
    marker: str
    source: list = field(default_factory=list)
    output: list = field(default_factory=list)
    trailing: list = field(default_factory=list)


@dataclass
class Document:
    preamble: list = field(default_factory=list)
    cells: list = field(default_factory=list)
    trailing_newline: bool = True


def _cell_kind(marker_rest):
    rest = marker_rest.strip()
    if rest.startswith("[markdown]"):
        return "text"
    if rest == "scratch":
        return "scratch"
    return "program"


def _split_body(body):
    end = len(body)
    while end > 0 and body[end - 1].strip() == "":
        end -= 1
    start = end
    while start > 0 and body[start - 1].startswith(OUTPUT_PREFIX):
        start -= 1
    if start == end:
        return body, [], []
    return body[:start], body[start:end], body[end:]


def parse_document(text):
    if text == "":
        return Document(trailing_newline=False)
    lines = text.split("\\n")
    trailing_newline = lines[-1] == ""
    if trailing_newline:
        lines.pop()

    doc = Document(trailing_newline=trailing_newline)
    current = None  # (marker, rest, body)

    def close():
        if current is None:
            return
        marker, rest, body = current
        source, output, trailing = _split_body(body)
        doc.cells.append(Cell(_cell_kind(rest), marker, source, output, trailing))

    for line in lines:
        m = MARKER.match(line)
        if m:
            close()
            current = (line, m.group(1), [])
        elif current is not None:
            current[2].append(line)
        else:
            doc.preamble.append(line)
    close()
    return doc


def serialize_document(doc):
    lines = list(doc.preamble)
    for c in doc.cells:
        lines.append(c.marker)
        lines.extend(c.source)
        lines.extend(c.output)
        lines.extend(c.trailing)
    if not lines:
        return ""
    return "\\n".join(lines) + ("\\n" if doc.trailing_newline else "")


def cell_code(cell):
    return "\\n".join(cell.source)


def scratch_code(cell):
    """A scratch cell's code, "#| " comment prefix stripped. A line without
    the prefix (legacy bare-code scratch) passes through unchanged."""

    def decode(line):
        if line == SCRATCH_BLANK:
            return ""
        if line.startswith(SCRATCH_PREFIX):
            return line[len(SCRATCH_PREFIX):]
        return line

    return "\\n".join(decode(line) for line in cell.source)


def set_scratch_code(cell, code):
    """Replace a scratch cell's body (canonical "#| " prefixing, blank
    lines as "#|"); empty code clears the source lines entirely."""
    cell.source = [] if code == "" else [
        SCRATCH_BLANK if line == "" else f"{SCRATCH_PREFIX}{line}" for line in code.split("\\n")
    ]


def set_output(cell, text):
    """Replace a cell's output block (canonical "#-> " prefixing); None
    clears it. Blank separator lines between cells stay put."""
    if text is None:
        cell.output = []
        cell.source.extend(cell.trailing)
        cell.trailing = []
        return
    if not cell.output:
        end = len(cell.source)
        while end > 0 and cell.source[end - 1].strip() == "":
            end -= 1
        cell.trailing = cell.source[end:]
        cell.source = cell.source[:end]
    cell.output = [
        OUTPUT_PREFIX if line == "" else f"{OUTPUT_PREFIX} {line}" for line in text.split("\\n")
    ]
`,l=`"""The live session: a persistent namespace that runs cells REPL-style.

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
`,u=`"""Kernel subprocess: line-delimited JSON on stdin/stdout around a Session.

Run as \`python -m knuth.kernel\` by the server, never directly by users.
User code's stdout/stderr are redirected into \`stream\` events; the real
stdout carries only protocol events. SIGINT lands here as KeyboardInterrupt:
during a run it surfaces as an \`error\` event, while idle it is swallowed.

Events out: ready | stream{id,which,text} | done{id,result} |
            error{id,traceback} | namespace{id,vars} | persisted{id,...}
Commands in: run{id,code} | namespace{id} | artifacts{id} | persist{id} | ...

\`handle_request\` is the dispatcher; main() is the stdin/stdout loop around
it, and the browser preview (src/kernel/pyodide-kernel.ts) is another host
for the same function.

\`persist\` writes the folder contract (values.json, figs/) into this
process's working directory — the project root the server started it in —
through the same writer \`knuth run\` uses, so the app and the runner never
disagree about what the folder should contain.
"""

import io
import json
import os
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
from .contract import write_contract
from .session import Session, capture_open_figures


class OutputLimitExceeded(RuntimeError):
    """Stop a run whose stdout/stderr would otherwise grow without bound."""


def _raise_keyboard_interrupt(_signum, _frame):
    """Give Windows Ctrl-Break the same cell-interrupt semantics as SIGINT."""
    raise KeyboardInterrupt


def _install_interrupt_handler():
    if sys.platform == "win32":
        signal.signal(signal.SIGBREAK, _raise_keyboard_interrupt)
    else:
        # An engine started as a shell background job inherits SIGINT as
        # ignored, Python then leaves it ignored, and this kernel inherits
        # that in turn — every interrupt silently vanishes. Interrupts are
        # this process's job: claim the handler unconditionally.
        signal.signal(signal.SIGINT, signal.default_int_handler)


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
    semantics: Pyodide runs this in the browser tab (SAME_ORIGIN.md), where
    there is no stdin to read and no subprocess to be. Anything that
    diverges here is a way for the two backends to disagree, so nothing
    should.
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
    elif kind == "persist":
        values, figures = session.artifacts()
        try:
            write_contract(os.getcwd(), values, figures)
        except (OSError, ValueError) as exc:
            emit({
                "type": "persisted",
                "id": msg["id"],
                "error": f"could not write the project folder: {exc}",
            })
        else:
            emit({
                "type": "persisted",
                "id": msg["id"],
                "root": os.getcwd(),
                "values": len(values),
                "figures": sorted(figures),
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
`,d=`https://cdn.jsdelivr.net/pyodide/v0.28.3/full/`,f=`
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

def knuth_missing_imports(code):
    # Top-level imports the tab cannot satisfy yet, after Pyodide's own
    # packages were loaded: candidates for PyPI. Stdlib and installed
    # packages resolve; a name that does not is either a PyPI package
    # under its import name, a mismatch (sklearn vs scikit-learn), or a
    # typo — micropip sorts those out, and the run reports the rest.
    import importlib.util
    from pyodide.code import find_imports
    missing = []
    for name in find_imports(code):
        try:
            found = importlib.util.find_spec(name) is not None
        except (ImportError, ValueError):
            found = False
        if not found and name not in missing:
            missing.append(name)
    return json.dumps(missing)

async def knuth_install(requirement):
    # micropip's own words for a failure ("Can't find a pure Python 3
    # wheel for 'polars'") are the useful ones; an empty string is success.
    import micropip
    try:
        await micropip.install(requirement)
    except Exception as error:
        return str(error).strip().split("\\n")[0] or type(error).__name__
    return ""

def knuth_convert(raw):
    # The one converter (ipynb.py), the same call server.py makes.
    from knuth.ipynb import notebook_to_document
    from knuth.percent import serialize_document
    try:
        doc, commented = notebook_to_document(raw)
    except ValueError as error:
        return json.dumps({"error": str(error)})
    return json.dumps({"text": serialize_document(doc), "commented": commented})
`,p=class{onStatus;pyodide=null;micropip=null;ready;closed=!1;booted=!1;root=null;nextId=1;runs=new Map;waiters=new Map;constructor(e){this.onStatus=e,this.onStatus?.(`connecting`),this.ready=this.boot().then(()=>{this.booted=!0,this.onStatus?.(`ready`,!1)},e=>{console.error(`Pyodide failed to start`,e),this.onStatus?.(`kernel_failed`)})}async boot(){let{loadPyodide:t}=await e(async()=>{let{loadPyodide:e}=await import(`${d}pyodide.mjs`);return{loadPyodide:e}},[],import.meta.url),n=await t({indexURL:d});n.FS.mkdirTree(`/lib/knuth`);let p=[[`__init__.py`,r],[`artifacts.py`,i],[`contract.py`,a],[`ipynb.py`,o],[`limits.py`,s],[`percent.py`,c],[`session.py`,l],[`kernel.py`,u]];for(let[e,t]of p)n.FS.writeFile(`/lib/knuth/${e}`,t,{encoding:`utf8`});n.runPython(`import sys; sys.path.insert(0, "/lib")`),n.globals.set(`_knuth_emit`,e=>this.receive(e)),n.runPython(f);try{await n.loadPackage(`micropip`),this.micropip=n.pyimport(`micropip`)}catch(e){console.warn(`micropip is unavailable; PyPI packages cannot be installed`,e)}this.pyodide=n}async providePackages(e,t){let r=this.pyodide;try{await r.loadPackagesFromImports(e)}catch(e){console.warn(`Could not preload packages for this cell`,e)}if(!this.micropip)return;for(let r of n(e))await this.install(r,t);let i=[];try{r.globals.set(`_knuth_code`,e),i=JSON.parse(String(r.runPython(`knuth_missing_imports(_knuth_code)`)))}catch(e){console.warn(`Could not inspect imports`,e)}for(let e of i)await this.install(e,t)}async install(e,t){let n=this.pyodide;t?.onStream?.(`stdout`,`Installing ${e}…\n`);let r;try{n.globals.set(`_knuth_requirement`,e),r=String(await n.runPythonAsync(`await knuth_install(_knuth_requirement)`))}catch(e){r=String(e?.message||e)}r&&t?.onStream?.(`stderr`,`Could not install ${e} in the built-in Python: ${r}\nPackages with compiled code need Python installed on this computer.
`)}get isReady(){return this.booted&&!this.closed}receive(e){let t;try{t=JSON.parse(e)}catch{return}let n=typeof t.id==`number`?t.id:null;if(t.type===`stream`&&n!==null){this.runs.get(n)?.handlers?.onStream?.(t.which,String(t.text??``));return}if(t.type===`figures`&&n!==null){this.runs.get(n)?.handlers?.onFigures?.(t.svgs??[],t.named??[]);return}if(t.type===`done`&&n!==null){this.runs.get(n)?.resolve({ok:!0,result:t.result??null,traceback:null}),this.runs.delete(n);return}if(t.type===`error`&&n!==null){this.runs.get(n)?.resolve({ok:!1,result:null,traceback:String(t.traceback??`error`)}),this.runs.delete(n);return}n!==null&&this.waiters.has(n)&&(this.waiters.get(n)(t),this.waiters.delete(n))}async send(e){if(await this.ready,this.closed||!this.pyodide)return;let t=this.pyodide;t.globals.set(`_knuth_request`,JSON.stringify(e)),await t.runPythonAsync(`knuth_handle(_knuth_request)`)}async ask(e,t,n){if(await this.ready,this.closed||!this.pyodide)return n;let r=this.nextId++;return new Promise(i=>{this.waiters.set(r,e=>i(e.type===`protocol_error`?n:t(e))),this.send({...e,id:r}).catch(()=>{this.waiters.delete(r),i(n)})})}async run(e,t,n){if(await this.ready,this.closed||!this.pyodide)return{ok:!1,result:null,traceback:`Python is not running`};await this.providePackages(e,t);let r=this.nextId++;return new Promise(i=>{this.runs.set(r,{handlers:t,resolve:i}),this.send({type:`run`,id:r,code:e,scratch:n?.scratch??!1}).catch(e=>{this.runs.delete(r),i({ok:!1,result:null,traceback:String(e)})})})}interrupt(){console.warn(`Interrupt is not available in the browser preview.`)}async restart(e,t){if(await this.ready,this.closed||!this.pyodide)return;let n=this.nextId++;await new Promise(e=>{this.waiters.set(n,()=>e()),this.send({type:`restart`,id:n}).catch(()=>e())}),this.onStatus?.(`ready`,!1)}namespace(){return this.ask({type:`namespace`},e=>e.vars??[],[])}artifacts(){return this.ask({type:`artifacts`},e=>({values:e.values??{},figures:e.figures??{}}),null)}table(e,t=0,n=100){return this.ask({type:`table`,name:e,offset:t,limit:n},e=>e,null)}figure(e){return this.ask({type:`figure`,name:e},e=>e,null)}async convert(e){if(await this.ready,this.closed||!this.pyodide)return null;this.pyodide.globals.set(`_knuth_notebook`,e);try{let e=await this.pyodide.runPythonAsync(`knuth_convert(_knuth_notebook)`);return JSON.parse(String(e))}catch(e){return{error:String(e)}}}async openPath(e){return null}async savePath(e,t){return null}async statPath(e){return null}async renamePath(e,t){return null}async persist(){return null}close(){this.closed=!0}};export{p as PyodideKernel};