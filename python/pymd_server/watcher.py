"""
File watcher for hot-reload.

Monitors the open .md file and notifies the frontend when it changes
on disk (e.g., edited by Claude Code or another editor).
"""

import asyncio
import time
from pathlib import Path
from typing import Callable


class FileWatcher:
    """Polls a file for changes and calls a callback when modified."""

    def __init__(self, debounce_ms: int = 300):
        self.debounce_ms = debounce_ms
        self._watching: Path | None = None
        self._last_mtime: float = 0
        self._task: asyncio.Task | None = None
        self._callback: Callable[[], None] | None = None

    def watch(self, path: str | Path, callback: Callable[[], None]):
        """Start watching a file. Replaces any existing watch."""
        self.stop()
        self._watching = Path(path)
        self._callback = callback
        self._last_mtime = self._watching.stat().st_mtime if self._watching.exists() else 0
        self._task = asyncio.ensure_future(self._poll_loop())

    def stop(self):
        """Stop watching."""
        if self._task:
            self._task.cancel()
            self._task = None
        self._watching = None
        self._callback = None

    async def _poll_loop(self):
        """Poll the file for changes."""
        while self._watching and self._callback:
            try:
                await asyncio.sleep(self.debounce_ms / 1000)
                if not self._watching or not self._watching.exists():
                    continue
                mtime = self._watching.stat().st_mtime
                if mtime > self._last_mtime:
                    self._last_mtime = mtime
                    self._callback()
            except asyncio.CancelledError:
                break
            except Exception:
                continue
