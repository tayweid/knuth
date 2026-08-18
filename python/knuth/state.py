"""Small, non-secret preferences that outlive one run.

Deliberately not the old config module: nothing here is a credential, and
nothing here is required for Knuth to work. It exists so a one-time question
stays one-time.
"""

import json
import os
import sys
from pathlib import Path

FILE = "preferences.json"


def state_dir():
    override = os.environ.get("KNUTH_CONFIG_DIR")
    if override:
        return Path(override).expanduser()
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Knuth"
    if sys.platform == "win32":
        app_data = os.environ.get("APPDATA")
        root = Path(app_data) if app_data else Path.home() / "AppData" / "Roaming"
        return root / "Knuth"
    return Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "knuth"


def _read():
    try:
        with open(state_dir() / FILE, encoding="utf-8") as handle:
            loaded = json.load(handle)
    except (OSError, ValueError):
        return {}
    return loaded if isinstance(loaded, dict) else {}


def get(key, default=None):
    return _read().get(key, default)


def set(key, value):
    """Best effort: a preference that cannot be saved must not break a launch."""
    merged = {**_read(), key: value}
    try:
        directory = state_dir()
        directory.mkdir(parents=True, exist_ok=True)
        with open(directory / FILE, "w", encoding="utf-8") as handle:
            json.dump(merged, handle)
    except OSError:
        pass
