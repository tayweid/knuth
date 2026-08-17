"""Redacted diagnostic command behavior."""

from knuth import doctor


def _finish_coroutine(coroutine, result):
    coroutine.close()
    return result


def test_doctor_reports_a_compatible_engine(monkeypatch, capsys):
    monkeypatch.setattr(doctor, "_installed_version", lambda: "2.0.0rc1")
    monkeypatch.setattr(
        doctor.asyncio,
        "run",
        lambda coroutine: _finish_coroutine(coroutine, {
            "type": "status",
            "version": "2.0.0rc1",
            "protocol": doctor.PROTOCOL_VERSION,
            "sessions": 1,
            "max_sessions": 8,
        }),
    )

    assert doctor.run_doctor() == 0
    output = capsys.readouterr().out
    assert "protocol 2" in output and "sessions 1/8" in output
    assert "http://127.0.0.1:5197/" in output


def test_doctor_explains_when_engine_is_not_running(monkeypatch, capsys):
    monkeypatch.setattr(
        doctor.asyncio,
        "run",
        lambda coroutine: _finish_coroutine(coroutine, None),
    )

    assert doctor.run_doctor(8123) == 1
    output = capsys.readouterr().out
    assert "not running on 127.0.0.1:8123" in output
    assert "knuth app" in output


def test_doctor_asks_as_the_page_the_engine_serves(monkeypatch):
    """The status verb is local-origin only, so doctor must speak as one."""
    captured = {}

    def fake_connect(url, *, origin, **options):
        captured["url"] = url
        captured["origin"] = origin
        raise ConnectionRefusedError

    monkeypatch.setattr(doctor.websockets, "connect", fake_connect)
    assert doctor.asyncio.run(doctor._engine_status(8123)) is None
    assert captured == {
        "url": "ws://127.0.0.1:8123",
        "origin": "http://127.0.0.1:8123",
    }
