"""Shared test environment: deterministic and isolated from user config."""

import shutil
import tempfile
from pathlib import Path


_MPL_CONFIG = Path(tempfile.mkdtemp(prefix="knuth-test-matplotlib-"))


def pytest_configure():
    # Set this before tests import matplotlib. A writable, session-stable
    # config directory prevents first-run cache warnings from becoming cell
    # output and making the runner's second pass differ from its first.
    import os

    os.environ["MPLBACKEND"] = "Agg"
    os.environ["MPLCONFIGDIR"] = str(_MPL_CONFIG)


def pytest_unconfigure():
    shutil.rmtree(_MPL_CONFIG, ignore_errors=True)
