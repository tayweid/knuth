"""Launching the app the engine serves, and the CLI that does it."""

import sys

import pytest

from knuth import cli, hosted


def _finish_coroutine(coroutine, result):
    coroutine.close()
    return result


def test_app_url_is_the_engine_itself():
    assert hosted.app_url(5197) == "http://127.0.0.1:5197/"
    assert hosted.app_url(8123) == "http://127.0.0.1:8123/"


def test_starts_the_engine_and_opens_it_once_bound(monkeypatch):
    """The browser opens on ready, not before: the URL must answer."""
    monkeypatch.setattr(hosted, "_port_is_taken", lambda _port: False)
    opened = []
    monkeypatch.setattr(hosted.webbrowser, "open", lambda url: opened.append(url) or True)
    served = []

    def fake_serve(port, grace, **options):
        served.append((port, grace))
        assert opened == [], "a browser opened before the engine was listening"
        options["on_ready"]()

    monkeypatch.setattr(hosted, "serve_main", fake_serve)

    assert hosted.run_hosted(8123, 45) == 0
    assert served == [(8123, 45)]
    assert opened == ["http://127.0.0.1:8123/"]


def test_a_running_engine_is_reused_not_replaced(monkeypatch):
    monkeypatch.setattr(hosted, "_port_is_taken", lambda _port: True)
    opened = []
    monkeypatch.setattr(hosted.webbrowser, "open", lambda url: opened.append(url) or True)
    monkeypatch.setattr(
        hosted,
        "serve_main",
        lambda *args, **kwargs: pytest.fail("must not start a second engine"),
    )

    assert hosted.run_hosted(5197) == 0
    assert opened == ["http://127.0.0.1:5197/"]


def test_no_browser_still_serves_and_says_where(monkeypatch, capsys):
    monkeypatch.setattr(hosted, "_port_is_taken", lambda _port: False)
    monkeypatch.setattr(
        hosted.webbrowser, "open", lambda _url: pytest.fail("--no-browser opens nothing")
    )
    monkeypatch.setattr(hosted, "serve_main", lambda port, grace, **o: o["on_ready"]())

    assert hosted.run_hosted(5197, open_browser=False) == 0
    output = capsys.readouterr().out
    assert "The app is at http://127.0.0.1:5197/" in output
    assert "Opening" not in output


def test_a_browser_that_will_not_open_prints_the_url(monkeypatch, capsys):
    monkeypatch.setattr(hosted, "_port_is_taken", lambda _port: False)
    monkeypatch.setattr(hosted.webbrowser, "open", lambda _url: False)
    monkeypatch.setattr(hosted, "serve_main", lambda port, grace, **o: o["on_ready"]())

    assert hosted.run_hosted(5197) == 0
    assert "http://127.0.0.1:5197/" in capsys.readouterr().out


def test_a_port_it_cannot_bind_is_reported(monkeypatch, capsys):
    monkeypatch.setattr(hosted, "_port_is_taken", lambda _port: False)

    def refuse(*args, **kwargs):
        raise OSError("address already in use")

    monkeypatch.setattr(hosted, "serve_main", refuse)

    assert hosted.run_hosted(5197) == 1
    assert "could not bind" in capsys.readouterr().out


def test_cli_dispatches_app(monkeypatch):
    called = []
    monkeypatch.setattr(
        hosted,
        "run_hosted",
        lambda port, grace, *, open_browser: called.append((port, grace, open_browser)) or 0,
    )
    monkeypatch.setattr(
        sys, "argv", ["knuth", "app", "--port", "8123", "--grace", "9", "--no-browser"]
    )
    with pytest.raises(SystemExit) as exit_info:
        cli.main()
    assert exit_info.value.code == 0
    assert called == [(8123, 9, False)]


def test_cli_no_longer_offers_pairing_verbs(monkeypatch, capsys):
    """`pair` and `rotate-token` had nothing left to pair."""
    monkeypatch.setattr(sys, "argv", ["knuth", "agent", "pair"])
    with pytest.raises(SystemExit) as exit_info:
        cli.main()
    assert exit_info.value.code == 2
    assert "invalid choice" in capsys.readouterr().err


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
