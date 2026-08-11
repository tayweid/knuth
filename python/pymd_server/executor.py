"""
Code executor with shared namespace.

Runs executable code blocks in a persistent Python namespace,
captures stdout/stderr, and intercepts matplotlib/plotly figures.
"""

import sys
import io
import traceback
import hashlib
from pathlib import Path
from typing import Any


class ExecutionResult:
    """Result of executing a single code block."""

    def __init__(
        self,
        block_id: str,
        stdout: str = "",
        stderr: str = "",
        error: str | None = None,
        figures: list[str] | None = None,
    ):
        self.block_id = block_id
        self.stdout = stdout
        self.stderr = stderr
        self.error = error
        self.figures = figures or []

    def to_dict(self) -> dict:
        return {
            "block_id": self.block_id,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "error": self.error,
            "figures": self.figures,
        }


class Executor:
    """
    Executes Python code blocks in a shared namespace.

    The namespace persists across blocks so that imports and variables
    defined in earlier blocks are available in later ones.
    """

    def __init__(self, cache_dir: Path):
        self.namespace: dict[str, Any] = {}
        self.cache_dir = cache_dir
        self.figures_dir = cache_dir / "figures"
        self.figures_dir.mkdir(parents=True, exist_ok=True)

    def reset(self):
        """Clear the namespace for a fresh run."""
        self.namespace.clear()

    def execute_block(self, block_id: str, code: str) -> ExecutionResult:
        """Execute a single code block, capturing output and figures."""
        stdout_capture = io.StringIO()
        stderr_capture = io.StringIO()
        figures: list[str] = []

        # Intercept matplotlib if available
        self._setup_figure_capture(block_id, figures)

        old_stdout = sys.stdout
        old_stderr = sys.stderr
        sys.stdout = stdout_capture
        sys.stderr = stderr_capture

        error = None
        try:
            exec(code, self.namespace)
        except Exception:
            error = traceback.format_exc()
        finally:
            sys.stdout = old_stdout
            sys.stderr = old_stderr
            self._teardown_figure_capture()

        return ExecutionResult(
            block_id=block_id,
            stdout=stdout_capture.getvalue(),
            stderr=stderr_capture.getvalue(),
            error=error,
            figures=figures,
        )

    def execute_blocks(
        self, blocks: list[tuple[str, str]], up_to: str | None = None, rerun: bool = False
    ) -> list[ExecutionResult]:
        """
        Execute multiple blocks sequentially.

        Args:
            blocks: List of (block_id, code) tuples in document order.
            up_to: If set, only execute blocks up to and including this block_id.
            rerun: If True, reset namespace before executing.
        """
        if rerun:
            self.reset()

        results = []
        for block_id, code in blocks:
            result = self.execute_block(block_id, code)
            results.append(result)
            if up_to and block_id == up_to:
                break
        return results

    def get_namespace_snapshot(self) -> dict[str, str]:
        """
        Return a snapshot of the namespace as {name: str(value)} for
        {{variable}} interpolation. Filters out modules, builtins, and
        private names.
        """
        snapshot = {}
        for key, value in self.namespace.items():
            if key.startswith("_"):
                continue
            if hasattr(value, "__module__") and hasattr(value, "__name__"):
                continue  # skip modules and functions
            try:
                snapshot[key] = str(value)
            except Exception:
                continue
        return snapshot

    def _setup_figure_capture(self, block_id: str, figures: list[str]):
        """Hook into matplotlib to save figures automatically."""
        try:
            import matplotlib
            matplotlib.use("Agg")
            import matplotlib.pyplot as plt

            # Close any existing figures
            plt.close("all")

            # Store reference for teardown
            self._plt = plt
            self._current_block_id = block_id
            self._current_figures = figures
        except ImportError:
            self._plt = None

    def _teardown_figure_capture(self):
        """Save any open matplotlib figures after block execution."""
        if not getattr(self, "_plt", None):
            return

        plt = self._plt
        for i, fig_num in enumerate(plt.get_fignums()):
            fig = plt.figure(fig_num)
            fig_hash = hashlib.md5(
                f"{self._current_block_id}_{i}".encode()
            ).hexdigest()[:8]
            fig_path = self.figures_dir / f"{fig_hash}.png"
            fig.savefig(fig_path, dpi=150, bbox_inches="tight")
            self._current_figures.append(str(fig_path))

        plt.close("all")
        self._plt = None
