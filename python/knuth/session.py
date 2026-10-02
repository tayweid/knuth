"""The live session: a persistent namespace that runs cells REPL-style.

Used in-process by `knuth run` (Milestone 5) and by the kernel subprocess
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

# A run's receipt (Session.bound): entries on its done event, at most. A
# cell binding more (a long unpacking, a loop of defs) is rare; the page
# reads the rest from the snapshot it takes after every run.
MAX_BOUND = 64


def _listed(name, value):
    """Whether the variable explorer lists a namespace entry: underscore
    names are private and modules are not values."""
    return (
        isinstance(name, str)
        and not name.startswith("_")
        and not isinstance(value, types.ModuleType)
    )


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


def _is_numpy_scalar(value):
    """A numpy scalar (np.float64(0.5), np.int64(3), np.bool_(True)): a
    zero-dimensional numpy value with an item()."""
    return (
        type(value).__module__ == "numpy"
        and getattr(value, "ndim", None) == 0
        and hasattr(value, "item")
    )


def _target_names(target):
    if isinstance(target, ast.Name):
        return [target.id]
    if isinstance(target, (ast.Tuple, ast.List)):
        names = []
        for elt in target.elts:
            names += _target_names(elt)
        return names
    if isinstance(target, ast.Starred):
        return _target_names(target.value)
    return []


def _assigned_names(tree):
    """Top-level names a cell binds, in the order the cell binds them, once
    each — how scratch state is told apart from program state in the
    shared v1 namespace, which figures a run touched, and what a run's
    receipt lists (the order is the cell's, so the page can show them as
    written)."""
    names = []
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                names += _target_names(target)
        elif isinstance(node, (ast.AugAssign, ast.AnnAssign, ast.For, ast.AsyncFor)):
            names += _target_names(node.target)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.append(node.name)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                names.append((alias.asname or alias.name).split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                names.append(alias.asname or alias.name)
        elif isinstance(node, (ast.With, ast.AsyncWith)):
            for item in node.items:
                if item.optional_vars is not None:
                    names += _target_names(item.optional_vars)
    return list(dict.fromkeys(names))


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
    artist (`ax`, a Line2D), or a list of artists from one figure — so the
    natural `p = plt.plot(...)` persists figs/p.svg, not just
    `fig, ax = plt.subplots()`."""
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
        # Names bound by the most recent run, in the cell's order — how
        # figure receipts know which cell touched which figure, and what
        # the run's done event reports as bound.
        self.last_assigned = []

    def reset(self):
        self.namespace = {"__name__": "__main__"}
        self.scratch_names = set()
        self.last_assigned = []

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
            self.scratch_names.update(assigned)
        else:
            self.scratch_names.difference_update(assigned)

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
        return [
            self._entry(name, value)
            for name, value in self.namespace.items()
            if _listed(name, value)
        ]

    def bound(self, names):
        """What a run bound, for the page's receipt of it: the snapshot's
        entry for each of `names` (the run's assigned names, in the cell's
        order) still in the namespace and listed by snapshot(), plus
        `saved` on a value values.json mirrors. At most MAX_BOUND entries:
        the page reads the rest from its next snapshot."""
        out = []
        for name in names:
            if len(out) >= MAX_BOUND:
                break
            if name not in self.namespace:
                continue
            value = self.namespace[name]
            if not _listed(name, value):
                continue
            entry = self._entry(name, value)
            if (
                name not in self.scratch_names
                and "figure" not in entry
                and _persistable(value)[1]
            ):
                entry["saved"] = True
            out.append(entry)
        return out

    def _entry(self, name, value):
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
            # A numpy scalar by its value, not np.float64(-0.40888…): the
            # receipt's slim rows show values. Numbers and dates by numpy's
            # own str (a float64 as repr(float) has it, np.float32(0.1) as
            # 0.1, 2024-01-01T00:00:00.000000000, NaT), since item() turns
            # a nanosecond datetime64 into an int and NaT into None; the
            # rest (strings, bytes, objects) by their Python value's repr,
            # quoted as Python shows them.
            if _is_numpy_scalar(value):
                kind = getattr(getattr(value, "dtype", None), "kind", "")
                preview = str(value) if kind in ("b", "i", "u", "f", "c", "m", "M") else repr(value.item())
            else:
                preview = repr(value)
        except Exception:
            preview = "<unrepresentable>"
        entry["preview"] = preview[:80] + ("…" if len(preview) > 80 else "")
        if name in self.scratch_names:
            entry["scratch"] = True
        if _owning_figure(value) is not None:
            entry["figure"] = True
        return entry

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
        namespace order breaks remaining ties — so `fig, ax = subplots()`
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
