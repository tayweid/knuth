"""Documents by path: what the engine does for a page that has a real path.

A page served by the engine and running in Knuth.app (or any browser given
a `?open=` path) never touches the file itself. It names an absolute path
over the origin-checked socket and the engine reads, writes, stats, and
renames on its behalf — as the same user, on the same machine, so a path
the page can name is one the user could already open in Python. That is
the boundary, and it is the same one running a cell has.

Every function here returns the body of the reply event (without `type`
and `id`): either the data, or `{"error": <user-safe sentence>}`.
"""

import os
from pathlib import Path

from .ipynb import notebook_to_document
from .limits import MAX_DOCUMENT_BYTES, MAX_PATH_CHARS
from .percent import serialize_document
from .contract import atomic_write


def check_path(value):
    """An absolute path string, or the reason it is not."""
    if not isinstance(value, str) or not value:
        return None, "path must be a non-empty string"
    if len(value) > MAX_PATH_CHARS:
        return None, f"path exceeds {MAX_PATH_CHARS} characters"
    if "\0" in value:
        return None, "path contains a NUL byte"
    path = Path(value)
    if not path.is_absolute():
        return None, "path must be absolute"
    return path, None


def _modified(path):
    """Milliseconds since the epoch, the unit the page's poll already uses."""
    return int(path.stat().st_mtime * 1000)


def open_document(value):
    path, error = check_path(value)
    if error:
        return {"error": error}
    try:
        size = path.stat().st_size
    except FileNotFoundError:
        return {"error": f"{path.name} does not exist"}
    except OSError as exc:
        return {"error": f"{path.name} could not be read: {exc.strerror or exc}"}
    if not path.is_file():
        return {"error": f"{path.name} is not a file"}
    if size > MAX_DOCUMENT_BYTES:
        return {"error": f"{path.name} is larger than {MAX_DOCUMENT_BYTES // (1024 * 1024)} MB"}
    try:
        raw = path.read_bytes()
    except OSError as exc:
        return {"error": f"{path.name} could not be read: {exc.strerror or exc}"}
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return {"error": f"{path.name} is not UTF-8 text"}

    if path.suffix.lower() == ".ipynb":
        # One-way import, the one converter: the document arrives unsaved
        # under a sibling .py name; the notebook is never touched.
        try:
            doc, commented = notebook_to_document(text)
        except ValueError as exc:
            return {"error": str(exc)}
        target = path.with_suffix(".py")
        return {
            "path": str(target),
            "name": target.name,
            "text": serialize_document(doc),
            "modified": None,
            "unsaved": True,
            "commented": commented,
        }
    return {
        "path": str(path),
        "name": path.name,
        "text": text,
        "modified": _modified(path),
    }


def save_document(value, text):
    path, error = check_path(value)
    if error:
        return {"error": error}
    if not isinstance(text, str):
        return {"error": "text must be a string"}
    if path.exists() and not path.is_file():
        return {"error": f"{path.name} is not a file"}
    try:
        atomic_write(path, text)
    except OSError as exc:
        return {"error": f"{path.name} could not be saved: {exc.strerror or exc}"}
    return {"path": str(path), "modified": _modified(path)}


def stat_document(value):
    path, error = check_path(value)
    if error:
        return {"error": error}
    try:
        if not path.is_file():
            return {"path": str(path), "modified": None}
        return {"path": str(path), "modified": _modified(path)}
    except OSError:
        return {"path": str(path), "modified": None}


def rename_document(value, name):
    """Rename within the file's own folder; a new name never moves it."""
    path, error = check_path(value)
    if error:
        return {"error": error}
    if not isinstance(name, str) or not name.strip():
        return {"error": "name must be a non-empty string"}
    name = name.strip()
    if name in {".", ".."} or "/" in name or "\\" in name or "\0" in name:
        return {"error": "name must be a file name, not a path"}
    if len(name.encode("utf-8")) > 255:
        return {"error": "name is too long"}
    target = path.with_name(name)
    if not path.is_file():
        return {"error": f"{path.name} does not exist"}
    if target.exists() and not os.path.samefile(path, target):
        return {"error": f"{name} already exists"}
    try:
        os.replace(path, target)
    except OSError as exc:
        return {"error": f"{path.name} could not be renamed: {exc.strerror or exc}"}
    return {"path": str(target), "name": target.name, "modified": _modified(target)}
