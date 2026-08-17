"""Cross-platform hosted-launcher and CLI behavior."""

import sys

import pytest

from knuth import cli, hosted


def _finish_coroutine(coroutine, result):
    coroutine.close()
    return result


def test_hosted_starts_foreground_server_and_opens_after_bind(monkeypatch):
    monkeypatch.setattr(hosted, "load_or_create_capability", lambda: "c" * 43)
    monkeypatch.setattr(
        hosted.asyncio,
        "run",
        lambda coroutine: _finish_coroutine(coroutine, None),
    )
    opened = []
    monkeypatch.setattr(
        hosted,
        "_open_hosted_app",
        lambda token, open_browser: opened.append((token, open_browser)),
    )
    served = []

    def fake_serve(port, grace, **options):
        served.append((port, grace, options))
        options["on_ready"]()

    monkeypatch.setattr(hosted, "serve_main", fake_serve)
    assert hosted.run_hosted(8123, 45) == 0
    assert len(opened) == 1 and len(opened[0][0]) == 43 and opened[0][1] is True
    assert served[0][0:2] == (8123, 45)
    assert served[0][2]["capability"] == "c" * 43


def test_hosted_reuses_a_running_engine(monkeypatch):
    monkeypatch.setattr(hosted, "load_or_create_capability", lambda: "c" * 43)
    monkeypatch.setattr(
        hosted.asyncio,
        "run",
        lambda coroutine: _finish_coroutine(coroutine, "p" * 43),
    )
    opened = []
    monkeypatch.setattr(
        hosted,
        "_open_hosted_app",
        lambda token, open_browser: opened.append((token, open_browser)),
    )
    monkeypatch.setattr(
        hosted,
        "serve_main",
        lambda *args, **kwargs: pytest.fail("must not start a second engine"),
    )
    assert hosted.run_hosted(open_browser=False) == 0
    assert opened == [("p" * 43, False)]


def test_macos_launcher_opens_installed_pwa_with_pairing_fragment(monkeypatch):
    calls = []
    monkeypatch.setattr(hosted.sys, "platform", "darwin")
    monkeypatch.setattr(
        hosted.subprocess,
        "run",
        lambda command, **options: calls.append((command, options))
        or type("Result", (), {"returncode": 0})(),
    )
    monkeypatch.setattr(
        hosted.webbrowser,
        "open",
        lambda _url: pytest.fail("installed PWA should be preferred"),
    )

    hosted._open_hosted_app("p" * 43, True)

    assert calls == [
        (
            ["open", "-a", "Knuth", f"https://knuth.tayweid.io/#pair={'p' * 43}"],
            {"capture_output": True, "timeout": 5},
        )
    ]


def test_launcher_falls_back_to_default_browser_without_installed_pwa(monkeypatch):
    monkeypatch.setattr(hosted, "_open_macos_installed_app", lambda _url: False)
    opened = []
    monkeypatch.setattr(
        hosted.webbrowser, "open", lambda url: opened.append(url) or True
    )

    hosted._open_hosted_app("p" * 43, True)

    assert opened == [f"https://knuth.tayweid.io/#pair={'p' * 43}"]


def test_cli_dispatches_hosted_app(monkeypatch):
    called = []
    monkeypatch.setattr(
        hosted,
        "run_hosted",
        lambda port, grace, *, open_browser: called.append((port, grace, open_browser)) or 0,
    )
    monkeypatch.setattr(
        sys,
        "argv",
        ["knuth", "app", "--hosted", "--port", "8123", "--grace", "9", "--no-browser"],
    )
    with pytest.raises(SystemExit) as exit_info:
        cli.main()
    assert exit_info.value.code == 0
    assert called == [(8123, 9, False)]


def test_cli_without_a_command_shows_help_instead_of_starting_server(
    monkeypatch, capsys
):
    monkeypatch.setattr(sys, "argv", ["knuth"])
    monkeypatch.setattr(
        cli,
        "serve_main",
        lambda *args, **kwargs: pytest.fail("must not start an implicit server"),
    )

    assert cli.main() == 2
    assert "usage: knuth" in capsys.readouterr().out
