"""Fail a release build unless its tag exactly matches package metadata."""

import re
import sys
import tomllib
from pathlib import Path


def validate_release(tag, version):
    """Return normally only for a publishable version and its exact v-tag."""
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:a[0-9]+|b[0-9]+|rc[0-9]+)?", version):
        raise ValueError(f"refusing to publish non-release package version {version!r}")
    if tag != f"v{version}":
        raise ValueError(f"tag {tag!r} does not match package version v{version}")


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: check_release.py TAG")
    tag = sys.argv[1]
    metadata = tomllib.loads(
        (Path(__file__).parents[1] / "pyproject.toml").read_text(encoding="utf-8")
    )
    version = metadata["project"]["version"]
    try:
        validate_release(tag, version)
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc
    print(f"release tag and package version agree: {tag}")


if __name__ == "__main__":
    main()
