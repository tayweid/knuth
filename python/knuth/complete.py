"""Code completion against the live session: what fits at the cursor.

Jedi when it is importable — what IPython, Jupyter and Spyder use; it reads
the live namespace (`jedi.Interpreter`), so after `df.` it knows `df` is a
DataFrame — and otherwise the standard library's rlcompleter, which only
knows names and attributes. Pure: no I/O, no state beyond the namespace it
is handed, so the subprocess kernel and the Pyodide kernel answer the same.

Knuth.app installs Jedi beside the engine, never into a document's own
environment, so it never appears in a package header.
"""

import keyword
import os
import re
import sys

MAX_ITEMS = 200
_WORD = re.compile(r"[A-Za-z_][A-Za-z0-9_]*$")
_DOTTED = re.compile(r"((?:[A-Za-z_][A-Za-z0-9_]*\.)*[A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)?$")


def complete(code, offset, namespace):
    """Completions for `code` at character `offset`: (start, items), where
    items are {"label", "type"} dicts and `start` is the offset the
    completed word begins at, so the page replaces from there."""
    offset = max(0, min(offset, len(code)))
    before = code[:offset]
    typed = _WORD.search(before)
    start = offset - (len(typed.group(0)) if typed else 0)
    items = _jedi(code, offset, namespace)
    if items is None:
        items = _rlcompleter(before, namespace)
    return start, items[:MAX_ITEMS]


def _jedi(code, offset, namespace):
    try:
        import jedi
    except ImportError:
        # The engine keeps Jedi beside it, not in the document's packages
        # (knuth.env.tools_dir): appended, so it never shadows the document's.
        tools = os.environ.get("KNUTH_TOOLS")
        if not tools or not os.path.isdir(os.path.join(tools, "jedi")):
            return None
        if tools not in sys.path:
            sys.path.append(tools)
        try:
            import jedi
        except ImportError:
            return None
    lines = code[:offset].split("\n")
    try:
        script = jedi.Interpreter(code, [namespace])
        found = script.complete(line=len(lines), column=len(lines[-1]))
    except Exception:
        # Jedi on a half-typed line can fail in odd ways; the fallback is
        # better than nothing and never raises.
        return None
    return [{"label": c.name, "type": c.type} for c in found if not c.name.startswith("__")] or []


def _rlcompleter(before, namespace):
    dotted = _DOTTED.search(before)
    if dotted:
        base, partial = dotted.group(1), dotted.group(2) or ""
        try:
            value = eval(base, dict(namespace))  # names and attributes only
        except Exception:
            return []
        names = [n for n in dir(value) if n.startswith(partial)]
        if not partial.startswith("_"):
            names = [n for n in names if not n.startswith("_")]
        return [{"label": n, "type": _kind(getattr(value, n, None))} for n in sorted(names)]
    typed = _WORD.search(before)
    partial = typed.group(0) if typed else ""
    if not partial:
        return []
    import builtins

    pool = {**vars(builtins), **namespace}
    names = sorted(n for n in pool if n.startswith(partial) and not n.startswith("_"))
    items = [{"label": n, "type": _kind(pool[n])} for n in names]
    items += [{"label": k, "type": "keyword"} for k in keyword.kwlist if k.startswith(partial)]
    return items


def _kind(value):
    import inspect

    if inspect.ismodule(value):
        return "module"
    if inspect.isclass(value):
        return "class"
    if callable(value):
        return "function"
    return "instance"
