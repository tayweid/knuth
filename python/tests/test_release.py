"""Release publishing gates."""

import importlib.util
from pathlib import Path

import pytest


SCRIPT = Path(__file__).parents[1] / "scripts" / "check_release.py"
SPEC = importlib.util.spec_from_file_location("check_release", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
CHECK_RELEASE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK_RELEASE)


@pytest.mark.parametrize("version", ["2.0.0", "2.0.0a1", "2.0.0b2", "2.0.0rc3"])
def test_release_version_and_tag_must_match(version):
    CHECK_RELEASE.validate_release(f"v{version}", version)


@pytest.mark.parametrize("version", ["2.0.0.dev0", "2.0", "latest", "2.0.0+local"])
def test_development_or_noncanonical_versions_cannot_publish(version):
    with pytest.raises(ValueError, match="non-release package version"):
        CHECK_RELEASE.validate_release(f"v{version}", version)


def test_mismatched_release_tag_cannot_publish():
    with pytest.raises(ValueError, match="does not match"):
        CHECK_RELEASE.validate_release("v2.0.1", "2.0.0")
