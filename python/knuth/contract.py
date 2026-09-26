"""Writing the folder contract: values.json, figs/<name>.svg, and the
ownership manifest, atomically and in one place.

Two producers share this: `knuth run` (runner.py) regenerates the contract
at the end of a clean reproduction, and the live kernel (kernel.py) does the
same on the app's `persist` request after program cells run. They must write
the same bytes the same way — a figure the app wrote and `knuth run` later
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
    """Stage the complete contract (plus any `extra` (path, text) files that
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
            stage_text(root / "values.json", json.dumps(values, indent=2) + "\n"),
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
