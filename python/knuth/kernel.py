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

from .session import Session


class _StreamOut(io.TextIOBase):
    def __init__(self, emit, state, which):
        self._emit = emit
        self._state = state
        self._which = which

    def writable(self):
        return True

    def write(self, s):
        if s:
            self._emit(
                {"type": "stream", "id": self._state["id"], "which": self._which, "text": s}
            )
        return len(s)


def main():
    real_stdout = sys.stdout
    stdin = sys.stdin

    def emit(event):
        real_stdout.write(json.dumps(event) + "\n")
        real_stdout.flush()

    state = {"id": None}
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
                ok, payload = session.run(msg["code"], scratch=bool(msg.get("scratch")))
                state["id"] = None
                if ok:
                    emit({"type": "done", "id": msg["id"], "result": payload})
                else:
                    emit({"type": "error", "id": msg["id"], "traceback": payload})
            elif kind == "namespace":
                emit({"type": "namespace", "vars": session.snapshot()})
            elif kind == "artifacts":
                values, figures = session.artifacts()
                emit({"type": "artifacts", "values": values, "figures": figures})
            elif kind == "table":
                emit({
                    "type": "table",
                    **session.table(
                        msg.get("name", ""), msg.get("offset", 0), msg.get("limit", 100)
                    ),
                })
        except KeyboardInterrupt:
            # Interrupt arrived while idle (or between commands): ignore.
            state["id"] = None
            continue


if __name__ == "__main__":
    main()
