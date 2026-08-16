"""Shared test environment: deterministic and isolated from user config."""

import os
import shutil
import tempfile
from pathlib import Path


_MPL_CONFIG = Path(tempfile.mkdtemp(prefix="knuth-test-matplotlib-"))
_KNUTH_CONFIG = Path(tempfile.mkdtemp(prefix="knuth-test-config-"))


def pytest_configure():
    # Set this before tests import matplotlib. A writable, session-stable
    # config directory prevents first-run cache warnings from becoming cell
    # output and making the runner's second pass differ from its first.
    os.environ["MPLBACKEND"] = "Agg"
    os.environ["MPLCONFIGDIR"] = str(_MPL_CONFIG)
    os.environ["KNUTH_CONFIG_DIR"] = str(_KNUTH_CONFIG)


def pytest_unconfigure():
    shutil.rmtree(_MPL_CONFIG, ignore_errors=True)
    shutil.rmtree(_KNUTH_CONFIG, ignore_errors=True)
