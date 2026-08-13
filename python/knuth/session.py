"""The live session: a persistent namespace that runs cells REPL-style.

Used in-process by `knuth run` (Milestone 5) and by the kernel subprocess
behind the WebSocket server (this milestone). Holds no I/O of its own —
stdout/stderr redirection is the kernel's job.
"""

import ast
import traceback
import types


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

    def _format_traceback(self, e):
        # Hide our own frames: report from the first frame inside the cell.
        tb = e.__traceback__
        while tb is not None and tb.tb_frame.f_code.co_filename != "<cell>":
            tb = tb.tb_next
        return "".join(traceback.format_exception(type(e), e, tb))
