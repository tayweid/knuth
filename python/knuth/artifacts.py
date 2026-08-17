"""Safe names and ownership metadata for generated project artifacts."""

import json
import unicodedata


MANIFEST_NAME = ".knuth-artifacts.json"
MANIFEST_VERSION = 1
MAX_FIGURE_NAME_BYTES = 128
WINDOWS_RESERVED_NAMES = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


def is_safe_figure_name(name):
    """Whether a Python binding is one portable SVG filename component."""
    return bool(
        isinstance(name, str)
        and name
        and not name.startswith("_")
        and name.isidentifier()
        and name == unicodedata.normalize("NFC", name)
        and len(name.encode("utf-8")) <= MAX_FIGURE_NAME_BYTES
        and name.upper() not in WINDOWS_RESERVED_NAMES
    )


def figure_path(name):
    if not is_safe_figure_name(name):
        raise ValueError(f"unsafe figure artifact name: {name!r}")
    return f"figs/{name}.svg"


def manifest_text(names):
    paths = sorted(figure_path(name) for name in names)
    return json.dumps(
        {"version": MANIFEST_VERSION, "figures": paths},
        indent=2,
        ensure_ascii=False,
    ) + "\n"


def owned_figure_names(raw):
    """Parse only safe current-format paths; malformed manifests own nothing."""
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return set()
    if not isinstance(data, dict) or data.get("version") != MANIFEST_VERSION:
        return set()
    paths = data.get("figures")
    if not isinstance(paths, list):
        return set()
    names = set()
    for path in paths:
        if not isinstance(path, str) or not path.startswith("figs/") or not path.endswith(".svg"):
            return set()
        name = path[len("figs/") : -len(".svg")]
        if not is_safe_figure_name(name) or figure_path(name) != path:
            return set()
        names.add(name)
    return names
