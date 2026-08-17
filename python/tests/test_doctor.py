"""Redacted diagnostic command behavior."""

from pathlib import Path

from knuth import doctor


def _finish_coroutine(coroutine, result):
    coroutine.close()
    return result


def test_doctor_reports_compatible_engine_without_printing_capability(monkeypatch, capsys):
    capability = "s" * 43
    monkeypatch.setattr(doctor, "load_or_create_capability", lambda: capability)
    monkeypatch.setattr(doctor, "capability_path", lambda: Path("/safe/config/capability"))
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
    assert capability not in output


def test_doctor_explains_when_engine_is_not_running(monkeypatch, capsys):
    monkeypatch.setattr(doctor, "load_or_create_capability", lambda: "s" * 43)
    monkeypatch.setattr(doctor, "capability_path", lambda: Path("/safe/config/capability"))
    monkeypatch.setattr(
        doctor.asyncio,
        "run",
        lambda coroutine: _finish_coroutine(coroutine, None),
    )

    assert doctor.run_doctor(8123) == 1
    output = capsys.readouterr().out
    assert "not running on 127.0.0.1:8123" in output
    assert "knuth app --hosted" in output
