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
        lambda port, grace, *, open_browser, browser: called.append(
            (port, grace, open_browser, browser)
        ) or 0,
    )
    monkeypatch.setattr(
        sys,
        "argv",
        ["knuth", "app", "--port", "8123", "--grace", "9", "--no-browser",
         "--browser", "chrome"],
    )
    with pytest.raises(SystemExit) as exit_info:
        cli.main()
    assert exit_info.value.code == 0
    assert called == [(8123, 9, False, "chrome")]


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


def _isatty(monkeypatch, value=True):
    monkeypatch.setattr(hosted.sys, "stdin", type("Stdin", (), {"isatty": lambda _s: value})())


def test_first_run_offers_the_login_agent_and_lets_it_take_over(monkeypatch, tmp_path):
    """Accepting means the agent is the engine — do not start a second one."""
    monkeypatch.setenv("KNUTH_CONFIG_DIR", str(tmp_path))
    monkeypatch.setattr(hosted.sys, "platform", "darwin")
    _isatty(monkeypatch)
    monkeypatch.setattr(hosted.agent, "is_installed", lambda: False)
    installed = []
    monkeypatch.setattr(hosted.agent, "install", lambda port: installed.append(port) or 0)
    monkeypatch.setattr(hosted, "input", lambda _prompt: "y", raising=False)
    taken = iter([False, True])
    monkeypatch.setattr(hosted, "_port_is_taken", lambda _port: next(taken, True))
    monkeypatch.setattr(hosted.webbrowser, "open", lambda _url: True)
    monkeypatch.setattr(
        hosted,
        "serve_main",
        lambda *args, **kwargs: pytest.fail("the agent owns the engine now"),
    )

    assert hosted.run_hosted(5197) == 0
    assert installed == [5197]


def test_declining_starts_the_foreground_engine_and_is_not_asked_twice(
    monkeypatch, tmp_path, capsys
):
    monkeypatch.setenv("KNUTH_CONFIG_DIR", str(tmp_path))
    monkeypatch.setattr(hosted.sys, "platform", "darwin")
    _isatty(monkeypatch)
    monkeypatch.setattr(hosted.agent, "is_installed", lambda: False)
    monkeypatch.setattr(
        hosted.agent, "install", lambda port: pytest.fail("declined means declined")
    )
    monkeypatch.setattr(hosted, "input", lambda _prompt: "n", raising=False)
    monkeypatch.setattr(hosted, "_port_is_taken", lambda _port: False)
    monkeypatch.setattr(hosted.webbrowser, "open", lambda _url: True)
    served = []
    monkeypatch.setattr(
        hosted, "serve_main", lambda port, grace, **o: served.append(port) or o["on_ready"]()
    )

    assert hosted.run_hosted(5197) == 0
    assert served == [5197]
    assert "knuth agent install" in capsys.readouterr().out

    # Second run: the question is settled, so it is never asked again.
    monkeypatch.setattr(
        hosted, "input", lambda _prompt: pytest.fail("asked twice")
    )
    assert hosted.run_hosted(5197) == 0


def test_a_non_interactive_run_is_never_prompted(monkeypatch, tmp_path):
    monkeypatch.setenv("KNUTH_CONFIG_DIR", str(tmp_path))
    monkeypatch.setattr(hosted.sys, "platform", "darwin")
    _isatty(monkeypatch, value=False)
    monkeypatch.setattr(hosted.agent, "is_installed", lambda: False)
    monkeypatch.setattr(
        hosted, "input", lambda _prompt: pytest.fail("no tty, no prompt"), raising=False
    )

    assert hosted._offer_login_agent(5197) is False


def test_browser_choice_is_remembered(monkeypatch, tmp_path):
    """The default browser is not always one that can install the app."""
    monkeypatch.setenv("KNUTH_CONFIG_DIR", str(tmp_path))
    monkeypatch.setattr(hosted.sys, "platform", "darwin")
    monkeypatch.setattr(hosted, "_port_is_taken", lambda _port: True)
    monkeypatch.setattr(
        hosted.webbrowser, "open", lambda _url: pytest.fail("must not use the default")
    )
    calls = []
    monkeypatch.setattr(
        hosted.subprocess,
        "run",
        lambda command, **options: calls.append(command)
        or type("Result", (), {"returncode": 0})(),
    )

    assert hosted.run_hosted(5197, browser="chrome") == 0
    assert calls == [["open", "-b", "com.google.Chrome", "http://127.0.0.1:5197/"]]

    # Asked once, honoured thereafter.
    calls.clear()
    assert hosted.run_hosted(5197) == 0
    assert calls == [["open", "-b", "com.google.Chrome", "http://127.0.0.1:5197/"]]


def test_an_unknown_browser_is_passed_through_as_an_app_name(monkeypatch, tmp_path):
    monkeypatch.setenv("KNUTH_CONFIG_DIR", str(tmp_path))
    monkeypatch.setattr(hosted.sys, "platform", "darwin")
    calls = []
    monkeypatch.setattr(
        hosted.subprocess,
        "run",
        lambda command, **options: calls.append(command)
        or type("Result", (), {"returncode": 0})(),
    )

    assert hosted.open_in("http://x", "Vivaldi") is True
    assert calls == [["open", "-a", "Vivaldi", "http://x"]]


def test_default_still_means_the_system_browser(monkeypatch, tmp_path):
    monkeypatch.setenv("KNUTH_CONFIG_DIR", str(tmp_path))
    opened = []
    monkeypatch.setattr(hosted.webbrowser, "open", lambda url: opened.append(url) or True)

    assert hosted.open_in("http://x", None) is True
    assert hosted.open_in("http://x", "default") is True
    assert opened == ["http://x", "http://x"]


def test_an_engine_older_than_the_install_is_restarted(monkeypatch, tmp_path, capsys):
    """pip replaces files; it does not restart processes."""
    monkeypatch.setenv("KNUTH_CONFIG_DIR", str(tmp_path))
    monkeypatch.setattr(hosted, "_port_is_taken", lambda _port: True)
    monkeypatch.setattr(hosted, "build_stamp", lambda: "2000")
    monkeypatch.setattr(
        hosted.asyncio, "run", lambda coroutine: _finish_coroutine(coroutine, {
            "type": "status", "build": "1000",
        })
    )
    monkeypatch.setattr(hosted.agent, "is_installed", lambda: True)
    restarted = []
    monkeypatch.setattr(hosted.agent, "restart", lambda: restarted.append(True) or 0)
    monkeypatch.setattr(hosted.webbrowser, "open", lambda _url: True)

    assert hosted.run_hosted(5197) == 0
    assert restarted == [True]
    assert "restarted it" in capsys.readouterr().out


def test_a_current_engine_is_left_alone(monkeypatch, tmp_path):
    monkeypatch.setenv("KNUTH_CONFIG_DIR", str(tmp_path))
    monkeypatch.setattr(hosted, "_port_is_taken", lambda _port: True)
    monkeypatch.setattr(hosted, "build_stamp", lambda: "2000")
    monkeypatch.setattr(
        hosted.asyncio, "run", lambda coroutine: _finish_coroutine(coroutine, {
            "type": "status", "build": "2000",
        })
    )
    monkeypatch.setattr(
        hosted.agent, "restart", lambda: pytest.fail("nothing to restart")
    )
    monkeypatch.setattr(hosted.webbrowser, "open", lambda _url: True)

    assert hosted.run_hosted(5197) == 0


def test_a_stale_foreground_engine_says_what_to_do(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("KNUTH_CONFIG_DIR", str(tmp_path))
    monkeypatch.setattr(hosted, "_port_is_taken", lambda _port: True)
    monkeypatch.setattr(hosted, "build_stamp", lambda: "2000")
    monkeypatch.setattr(
        hosted.asyncio, "run", lambda coroutine: _finish_coroutine(coroutine, {
            "type": "status", "build": "1000",
        })
    )
    monkeypatch.setattr(hosted.agent, "is_installed", lambda: False)
    monkeypatch.setattr(hosted.webbrowser, "open", lambda _url: True)

    assert hosted.run_hosted(5197) == 0
    assert "still serving the old version" in capsys.readouterr().out
