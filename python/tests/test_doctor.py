"""The doctor command against a live engine, the way test_kernel works.

Earlier this asserted on a mocked `websockets.connect` call; a real
`serve()` answers for the origin, the status verb and the shape of the
reply all at once (ROADMAP.md, test debt)."""

import asyncio
import socket
import subprocess
import sys
import time

import pytest

from knuth import doctor
from knuth.server import PROTOCOL_VERSION


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@pytest.fixture
def engine():
    """A real engine on a free port, up by the time the test gets the port."""
    port = free_port()
    server = subprocess.Popen(
        [sys.executable, "-m", "knuth", "serve", "--port", str(port)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        deadline = time.monotonic() + 20
        while True:
            try:
                status = asyncio.run(doctor._engine_status(port))
            except RuntimeError:
                status = None  # bound but not answering yet
            if status is not None:
                break
            if time.monotonic() > deadline:
                raise RuntimeError("the engine did not come up")
            time.sleep(0.1)
        yield port
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait()


def test_doctor_reports_a_live_engine(engine, capsys):
    """The status verb is local-origin only, so a reply at all means doctor
    asked as the page the engine serves."""
    assert doctor.run_doctor(engine) == 0
    output = capsys.readouterr().out
    assert f"protocol {PROTOCOL_VERSION}" in output
    assert "sessions 0/" in output
    assert f"http://127.0.0.1:{engine}/" in output
    assert "no document content was printed" in output


def test_doctor_explains_when_nothing_listens(capsys):
    port = free_port()
    assert doctor.run_doctor(port) == 1
    output = capsys.readouterr().out
    assert f"not running on 127.0.0.1:{port}" in output
    assert "knuth app" in output


def test_doctor_tells_a_port_that_is_not_knuth(capsys):
    """Something else on the port: the handshake never completes, and
    doctor says so rather than calling the engine absent."""
    with socket.socket() as other:
        other.bind(("127.0.0.1", 0))
        other.listen(1)
        port = other.getsockname()[1]
        assert doctor.run_doctor(port) == 1
    output = capsys.readouterr().out
    assert "did not answer as Knuth" in output
