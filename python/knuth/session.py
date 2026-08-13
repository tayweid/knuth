"""The live session: a persistent namespace that runs cells REPL-style.

Used in-process by `knuth run` (Milestone 5) and by the kernel subprocess
behind the WebSocket server (this milestone). Holds no I/O of its own —
stdout/stderr redirection is the kernel's job.
"""

import ast
import json
import traceback
import types

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


def _is_figure(value):
    t = type(value)
    return t.__name__ == "Figure" and t.__module__.startswith("matplotlib")


def _figure_svg(fig):
    import io

    buf = io.StringIO()
    fig.savefig(buf, format="svg")
    return buf.getvalue()


class Session:
    def __init__(self):
        self.namespace = {"__name__": "__main__"}

    def reset(self):
        self.namespace = {"__name__": "__main__"}

    def run(self, code):
        """Execute a cell. Returns (ok, payload): payload is the repr of the
        last expression (None if the cell ends in a statement or None) on
        success, the formatted traceback on failure."""
        try:
            tree = ast.parse(code, "<cell>")
        except SyntaxError as e:
            return False, "".join(traceback.format_exception_only(e))

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
            if name.startswith("_") or isinstance(value, types.ModuleType):
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

    def artifacts(self):
        """The folder contract (DESIGN.md auto-persistence): a JSON-safe
        mirror of the namespace for values.json, and named figures rendered
        to SVG text for figs/<name>.svg. Underscore names are private;
        modules and non-serializables (DataFrames included) stay behind."""
        values, figures = {}, {}
        for name, value in self.namespace.items():
            if name.startswith("_") or isinstance(value, types.ModuleType):
                continue
            if _is_figure(value):
                try:
                    figures[name] = _figure_svg(value)
                except Exception:
                    pass
                continue
            mirrored, ok = _persistable(value)
            if ok:
                values[name] = mirrored
        return values, figures

    def _format_traceback(self, e):
        # Hide our own frames: report from the first frame inside the cell.
        tb = e.__traceback__
        while tb is not None and tb.tb_frame.f_code.co_filename != "<cell>":
            tb = tb.tb_next
        return "".join(traceback.format_exception(type(e), e, tb))
