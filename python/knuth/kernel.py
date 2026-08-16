"""Kernel subprocess: line-delimited JSON on stdin/stdout around a Session.

Run as `python -m knuth.kernel` by the server, never directly by users.
User code's stdout/stderr are redirected into `stream` events; the real
stdout carries only protocol events. SIGINT lands here as KeyboardInterrupt:
during a run it surfaces as an `error` event, while idle it is swallowed.

Events out: ready | stream{id,which,text} | done{id,result} |
            error{id,traceback} | namespace{vars}
Commands in: run{id,code} | namespace{}
"""

import io
import json
import sys

from .limits import (
    MAX_ARTIFACT_RESPONSE_BYTES,
    MAX_FIGURE_BYTES,
    MAX_FIGURE_BYTES_PER_RUN,
    MAX_FIGURES_PER_RUN,
    MAX_NAMESPACE_RESPONSE_BYTES,
    MAX_RESULT_BYTES,
    MAX_STREAM_BYTES_PER_RUN,
    MAX_STREAM_EVENT_CHARS,
    MAX_TABLE_RESPONSE_BYTES,
    MAX_TRACEBACK_BYTES,
)
from .session import Session, capture_open_figures


class OutputLimitExceeded(RuntimeError):
    """Stop a run whose stdout/stderr would otherwise grow without bound."""


def _utf8_size(text):
    return len(text.encode("utf-8"))


def _truncate_utf8(text, limit):
    encoded = text.encode("utf-8")
    if len(encoded) <= limit:
        return text, False
    marker = f"\n… [truncated at {limit} bytes]"
    marker_bytes = marker.encode("utf-8")
    if len(marker_bytes) > limit:
        return encoded[:limit].decode("utf-8", errors="ignore"), True
    available = limit - len(marker_bytes)
    prefix = encoded[:available].decode("utf-8", errors="ignore")
    return prefix + marker, True


def _event_size(event):
    return len(json.dumps(event, ensure_ascii=False).encode("utf-8"))


class _StreamOut(io.TextIOBase):
    def __init__(self, emit, state, which):
        self._emit = emit
        self._state = state
        self._which = which

    def writable(self):
        return True

    def write(self, s):
        if s:
            encoded = s.encode("utf-8")
            remaining = MAX_STREAM_BYTES_PER_RUN - self._state["stream_bytes"]
            allowed = encoded[: max(0, remaining)].decode("utf-8", errors="ignore")
            for start in range(0, len(allowed), MAX_STREAM_EVENT_CHARS):
                self._emit({
                    "type": "stream",
                    "id": self._state["id"],
                    "which": self._which,
                    "text": allowed[start : start + MAX_STREAM_EVENT_CHARS],
                })
            self._state["stream_bytes"] += _utf8_size(allowed)
            if len(encoded) > _utf8_size(allowed):
                raise OutputLimitExceeded(
                    f"cell output exceeded the {MAX_STREAM_BYTES_PER_RUN}-byte limit"
                )
        return len(s)


def main():
    real_stdout = sys.stdout
    stdin = sys.stdin

    def emit(event):
        real_stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
        real_stdout.flush()

    state = {"id": None, "stream_bytes": 0}
    sys.stdout = _StreamOut(emit, state, "stdout")
    sys.stderr = _StreamOut(emit, state, "stderr")

    session = Session()
    emit({"type": "ready"})

    while True:
        try:
            line = stdin.readline()
            if not line:
                break
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            kind = msg.get("type")
            if kind == "run":
                state["id"] = msg["id"]
                state["stream_bytes"] = 0
                ok, payload = session.run(msg["code"], scratch=bool(msg.get("scratch")))
                svgs = capture_open_figures(MAX_FIGURES_PER_RUN)
                named = [] if msg.get("scratch") else session.figure_receipts(
                    session.last_assigned
                )
                kept_svgs = []
                figure_bytes = 0
                omitted = 0
                for svg in svgs:
                    size = _utf8_size(svg)
                    if (
                        len(kept_svgs) >= MAX_FIGURES_PER_RUN
                        or size > MAX_FIGURE_BYTES
                        or figure_bytes + size > MAX_FIGURE_BYTES_PER_RUN
                    ):
                        omitted += 1
                        continue
                    kept_svgs.append(svg)
                    figure_bytes += size
                if len(named) > MAX_FIGURES_PER_RUN:
                    omitted += len(named) - MAX_FIGURES_PER_RUN
                    named = named[:MAX_FIGURES_PER_RUN]
                if omitted:
                    emit({
                        "type": "stream",
                        "id": msg["id"],
                        "which": "stderr",
                        "text": f"Knuth omitted {omitted} figure(s) that exceeded display limits.\n",
                    })
                if kept_svgs or named:
                    emit({
                        "type": "figures",
                        "id": msg["id"],
                        "svgs": kept_svgs,
                        "named": named,
                    })
                if ok:
                    result, truncated = (
                        _truncate_utf8(payload, MAX_RESULT_BYTES)
                        if payload is not None
                        else (None, False)
                    )
                    event = {"type": "done", "id": msg["id"], "result": result}
                    if truncated:
                        event["truncated"] = True
                    emit(event)
                else:
                    traceback, truncated = _truncate_utf8(payload, MAX_TRACEBACK_BYTES)
                    event = {"type": "error", "id": msg["id"], "traceback": traceback}
                    if truncated:
                        event["truncated"] = True
                    emit(event)
                state["id"] = None
            elif kind == "namespace":
                event = {"type": "namespace", "vars": session.snapshot()}
                if _event_size(event) <= MAX_NAMESPACE_RESPONSE_BYTES:
                    emit(event)
                else:
                    emit({
                        "type": "protocol_error",
                        "request": "namespace",
                        "error": "namespace response exceeds the configured limit",
                    })
            elif kind == "artifacts":
                values, figures = session.artifacts()
                event = {"type": "artifacts", "values": values, "figures": figures}
                if _event_size(event) <= MAX_ARTIFACT_RESPONSE_BYTES:
                    emit(event)
                else:
                    emit({
                        "type": "protocol_error",
                        "request": "artifacts",
                        "error": "artifact response exceeds the configured limit",
                    })
            elif kind == "figure":
                result = session.figure(msg.get("name", ""))
                if "svg" in result and _utf8_size(result["svg"]) > MAX_FIGURE_BYTES:
                    result = {
                        "name": result["name"],
                        "error": "figure exceeds the configured display limit",
                    }
                emit({"type": "figure", **result})
            elif kind == "table":
                event = {
                    "type": "table",
                    **session.table(
                        msg.get("name", ""), msg.get("offset", 0), msg.get("limit", 100)
                    ),
                }
                if _event_size(event) <= MAX_TABLE_RESPONSE_BYTES:
                    emit(event)
                else:
                    emit({
                        "type": "protocol_error",
                        "request": "table",
                        "error": "table response exceeds the configured limit",
                    })
        except KeyboardInterrupt:
            # Interrupt arrived while idle (or between commands): ignore.
            state["id"] = None
            continue


if __name__ == "__main__":
    main()
