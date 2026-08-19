"""Import Jupyter notebooks: .ipynb in, percent-format .py out.

One-way by design (DESIGN.md: the document is a plain .py file), and
implemented once, in Python — the app opens the .py this writes rather
than growing a second converter in TypeScript.

The mapping (decided 2026-08-19):
- code cell -> program cell; magic and shell-escape lines (%..., !...)
  are commented out — they are not Python and would error under a real
  kernel — and any line that would read as a cell marker is prefixed so
  one notebook cell can never explode into several.
- markdown cell -> text cell with the canonical "# " prose prefix.
- raw cell -> program cell, fully commented out (preserved, not Python).
- outputs and execution counts are dropped: receipts are things Knuth
  itself reproduced, and `knuth run` regenerates them.
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
