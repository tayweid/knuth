"""knuth run: the reproducibility check and canonical artifact producer.

Fresh session, program cells only (scratch and text untouched), top to
bottom in the document's own folder, stopping at the first error. Output
blocks are rewritten for every cell that ran — receipts of what actually
happened — and on a clean run the folder contract is regenerated:
values.json wholesale, named figures into figs/. On failure the previous
contract is left untouched (it reflects the last complete run) and the
exit code is nonzero.
"""

import io
import json
import os
import re
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from .percent import cell_code, parse_document, serialize_document, set_output
from .session import Session

# Stored-output cap — the same policy as the app (DESIGN.md).
MAX_OUTPUT_LINES = 40

# Memory addresses in reprs ("<object at 0x104f2b3d0>") change every run;
# receipts must not churn on them.
ADDRESS = re.compile(r"0x[0-9a-fA-F]{6,}")


def truncate(text):
    text = ADDRESS.sub("0x…", text)
    lines = text.rstrip("\n").split("\n")
    if len(lines) <= MAX_OUTPUT_LINES:
        return "\n".join(lines)
    kept = lines[:MAX_OUTPUT_LINES]
    kept.append(f"… (+{len(lines) - MAX_OUTPUT_LINES} more lines)")
    return "\n".join(kept)


def run_file(file, echo=print):
    path = Path(file).resolve()
    if not path.exists():
        echo(f"knuth run: no such file: {file}")
        return 1
    doc = parse_document(path.read_text())
    program = [c for c in doc.cells if c.kind == "program"]
    if not program:
        echo(f"knuth run: {path.name} has no program cells")
        return 1

    os.environ.setdefault("MPLBACKEND", "Agg")
    session = Session()
    failed = False
    old_cwd = os.getcwd()
    os.chdir(path.parent)
    try:
        for i, cell in enumerate(program, 1):
            buf = io.StringIO()
            with redirect_stdout(buf), redirect_stderr(buf):
                ok, payload = session.run(cell_code(cell))
            text = buf.getvalue()
            if payload is not None:
                if text and not text.endswith("\n"):
                    text += "\n"
                text += payload
            stored = truncate(text)
            if ok:
                # Figure receipts: this cell's named figures, by path —
                # the same lines the app writes, byte-stable across runs.
                refs = [f"figs/{n}.svg" for n in session.figure_receipts(session.last_assigned)]
                stored = "\n".join(s for s in [stored, *refs] if s)
            set_output(cell, stored if stored else None)
            echo(f"[{i}/{len(program)}] {'ok' if ok else 'ERROR'}")
            if not ok:
                echo(payload.rstrip("\n"))
                failed = True
                break

        path.write_text(serialize_document(doc))

        if not failed:
            values, figures = session.artifacts()
            (path.parent / "values.json").write_text(json.dumps(values, indent=2) + "\n")
            if figures:
                figs = path.parent / "figs"
                figs.mkdir(exist_ok=True)
                for name, svg in figures.items():
                    (figs / f"{name}.svg").write_text(svg)
            echo(f"{path.name}: reproduced ({len(program)} cells; values.json"
                 + (f", {len(figures)} figure(s)" if figures else "") + ")")
    finally:
        os.chdir(old_cwd)
    return 1 if failed else 0
