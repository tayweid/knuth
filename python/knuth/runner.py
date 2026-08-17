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
import stat
import tempfile
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from .artifacts import MANIFEST_NAME, figure_path, manifest_text, owned_figure_names
from .percent import cell_code, parse_document, serialize_document, set_output
from .session import Session

# Stored-output cap — the same policy as the app (DESIGN.md).
MAX_OUTPUT_LINES = 40

# Memory addresses in reprs ("<object at 0x104f2b3d0>") change every run;
# receipts must not churn on them.
ADDRESS = re.compile(r"0x[0-9a-fA-F]{6,}")


def _stage_text(path, text):
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


def _atomic_write(path, text):
    temporary = _stage_text(path, text)
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _materialize_success(path, document_text, values, figures):
    """Stage the complete clean-run contract, then replace each file."""
    root = path.parent
    manifest_path = root / MANIFEST_NAME
    try:
        previous = owned_figure_names(manifest_path.read_text(encoding="utf-8"))
    except OSError:
        # Migration: without a valid ownership record, pre-existing SVGs are
        # user-owned and must never be inferred or deleted.
        previous = set()

    current = set(figures)
    staged = [
        (_stage_text(path, document_text), path),
        (
            _stage_text(root / "values.json", json.dumps(values, indent=2) + "\n"),
            root / "values.json",
        ),
    ]
    try:
        for name in sorted(current):
            relative = figure_path(name)
            destination = root / relative
            staged.append((_stage_text(destination, figures[name]), destination))
        staged_manifest = _stage_text(manifest_path, manifest_text(current))
    except BaseException:
        for temporary, _ in staged:
            temporary.unlink(missing_ok=True)
        raise

    try:
        for temporary, destination in staged:
            os.replace(temporary, destination)

        for name in previous - current:
            stale = root / figure_path(name)
            stale.unlink(missing_ok=True)

        # Last means this record never claims ownership of an SVG that was
        # not already written successfully in this generation.
        os.replace(staged_manifest, manifest_path)
    finally:
        for temporary, _ in staged:
            temporary.unlink(missing_ok=True)
        staged_manifest.unlink(missing_ok=True)


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
