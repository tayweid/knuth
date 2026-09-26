"""knuth run: the reproducibility check and canonical artifact producer.

Fresh session, program cells only (scratch and text not executed), top to
bottom in the document's own folder, stopping at the first error. Output
blocks are rewritten for every cell that ran — receipts of what actually
happened — and on a clean run the folder contract is regenerated:
values.json wholesale, named figures into figs/. On failure the previous
contract is left untouched (it reflects the last complete run) and the
exit code is nonzero.

Every rewrite also canonicalizes scratch cell bodies to their commented
"#|" form (same doctrine as the CRLF canonicalization below: a one-time
diff on a legacy file, byte-stable ever after).
"""

import io
import os
import re
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from .contract import atomic_write as _atomic_write, write_contract
from .percent import (
    cell_code,
    parse_document,
    scratch_code,
    serialize_document,
    set_output,
    set_scratch_code,
)
from .session import Session

# Stored-output cap — the same policy as the app (DESIGN.md).
MAX_OUTPUT_LINES = 40

# Memory addresses in reprs ("<object at 0x104f2b3d0>") change every run;
# receipts must not churn on them.
ADDRESS = re.compile(r"0x[0-9a-fA-F]{6,}")


def _materialize_success(path, document_text, values, figures):
    """The clean-run contract, with the document's receipts in the same
    generation: one writer for both producers (contract.py)."""
    write_contract(path.parent, values, figures, extra=[(path, document_text)])


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
    # read_text() applies universal-newline translation on purpose: knuth
    # run canonicalizes a document to LF the first time it rewrites receipts
    # (DECIDED, DESIGN.md). Receipt lines are LF either way, so preserving
    # CRLF would mean mixed endings forever; one line-ending diff on the
    # first run, byte-stable ever after.
    doc = parse_document(path.read_text())
    # Canonicalize every scratch body to its commented "#|" form. Decoding
    # then re-encoding is idempotent: new-form bodies come back unchanged,
    # legacy bare-code bodies migrate — a one-time diff, byte-stable after.
    for cell in doc.cells:
        if cell.kind == "scratch":
            set_scratch_code(cell, scratch_code(cell))
    # The preamble is the implicit cell zero: a plain script (no # %%
    # markers) runs whole; it gets no output block (nothing to anchor
    # one to — the file must stay byte-identical apart from receipts).
    units = []
    if any(line.strip() for line in doc.preamble):
        units.append((None, "\n".join(doc.preamble)))
    units.extend((c, cell_code(c)) for c in doc.cells if c.kind == "program")
    if not units:
        echo(f"knuth run: {path.name} has no program cells")
        return 1

    os.environ.setdefault("MPLBACKEND", "Agg")
    session = Session()
    failed = False
    old_cwd = os.getcwd()
    os.chdir(path.parent)
    try:
        for i, (cell, code) in enumerate(units, 1):
            buf = io.StringIO()
            with redirect_stdout(buf), redirect_stderr(buf):
                ok, payload = session.run(code)
            text = buf.getvalue()
            if payload is not None:
                if text and not text.endswith("\n"):
                    text += "\n"
                text += payload
            if cell is not None:
                stored = truncate(text)
                if ok:
                    # Figure receipts: this cell's named figures, by path —
                    # the same lines the app writes, byte-stable across runs.
                    refs = [
                        f"figs/{n}.svg"
                        for n in session.figure_receipts(session.last_assigned)
                    ]
                    stored = "\n".join(s for s in [stored, *refs] if s)
                set_output(cell, stored if stored else None)
            echo(f"[{i}/{len(units)}] {'ok' if ok else 'ERROR'}")
            if not ok:
                echo(payload.rstrip("\n"))
                failed = True
                break

        document_text = serialize_document(doc)
        if failed:
            _atomic_write(path, document_text)
        else:
            values, figures = session.artifacts()
            _materialize_success(path, document_text, values, figures)
            echo(f"{path.name}: reproduced ({len(units)} cells; values.json"
                 + (f", {len(figures)} figure(s)" if figures else "") + ")")
    finally:
        os.chdir(old_cwd)
    return 1 if failed else 0
