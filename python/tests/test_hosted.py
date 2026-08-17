"""Cross-platform hosted-launcher and CLI behavior."""

import plistlib
import sys
import threading

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
        "_deliver_in_background",
        lambda token, open_browser, _is_pending: opened.append((token, open_browser)),
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
        lambda token, open_browser, **options: opened.append((token, open_browser)),
    )
    monkeypatch.setattr(
        hosted,
        "serve_main",
        lambda *args, **kwargs: pytest.fail("must not start a second engine"),
    )
    assert hosted.run_hosted(open_browser=False) == 0
    assert opened == [("p" * 43, False)]


PAIRING_URL = f"https://knuth.tayweid.io/#pair={'p' * 43}"


def _spent_after(calls):
    """A pairing-state probe that reports the token spent after N polls."""
    remaining = [calls]

    def pending():
        if remaining[0] <= 0:
            return False
        remaining[0] -= 1
        return True

    return pending


def test_macos_launcher_opens_the_browser_that_installed_the_app(monkeypatch):
    """The shim cannot carry a URL; its browser can, and holds the storage."""
    calls = []
    monkeypatch.setattr(hosted, "DELIVERY_POLL_SECONDS", 0)
    monkeypatch.setattr(hosted, "_installed_app_browser", lambda: "com.google.Chrome")
    monkeypatch.setattr(
        hosted.subprocess,
        "run",
        lambda command, **options: calls.append((command, options))
        or type("Result", (), {"returncode": 0})(),
    )
    monkeypatch.setattr(
        hosted.webbrowser,
        "open",
        lambda _url: pytest.fail("the app's own browser should be enough"),
    )

    # Confirmation waits for the browser rather than trusting the launch.
    assert hosted._open_hosted_app("p" * 43, True, is_pending=_spent_after(1)) is True
    assert calls == [
        (
            ["open", "-b", "com.google.Chrome", PAIRING_URL],
            {"capture_output": True, "timeout": 5},
        )
    ]


def test_launcher_uses_the_default_browser_without_an_installed_app(monkeypatch):
    monkeypatch.setattr(hosted, "_installed_app_browser", lambda: None)
    opened = []
    monkeypatch.setattr(
        hosted.webbrowser, "open", lambda url: opened.append(url) or True
    )

    assert hosted._open_hosted_app("p" * 43, True, is_pending=_spent_after(0)) is True
    assert opened == [PAIRING_URL]


def test_launcher_escalates_when_a_browser_never_spends_the_token(monkeypatch):
    """A window that opened is not a browser that paired."""
    monkeypatch.setattr(hosted, "DELIVERY_TIMEOUT_SECONDS", 0)
    monkeypatch.setattr(hosted, "_installed_app_browser", lambda: "com.google.Chrome")
    monkeypatch.setattr(
        hosted.subprocess,
        "run",
        lambda command, **options: type("Result", (), {"returncode": 0})(),
    )
    opened = []
    monkeypatch.setattr(
        hosted.webbrowser, "open", lambda url: opened.append(url) or True
    )

    # The shim's browser opens but never pairs; the default browser then does.
    assert hosted._open_hosted_app("p" * 43, True, is_pending=_spent_after(1)) is True
    assert opened == [PAIRING_URL], "must fall through to the next route"


def test_launcher_reports_manual_pairing_when_no_browser_pairs(monkeypatch, capsys):
    monkeypatch.setattr(hosted, "DELIVERY_TIMEOUT_SECONDS", 0)
    monkeypatch.setattr(hosted, "_installed_app_browser", lambda: None)
    monkeypatch.setattr(hosted.webbrowser, "open", lambda _url: True)

    assert hosted._open_hosted_app("p" * 43, True, is_pending=lambda: True) is False
    printed = capsys.readouterr().out
    assert "did not complete pairing" in printed
    assert "knuth agent pair" in printed


def test_launcher_stops_after_one_window_when_pairing_state_is_unknown(monkeypatch):
    """An engine too old to report pairing state must not spray windows."""
    monkeypatch.setattr(hosted, "_installed_app_browser", lambda: None)
    opened = []
    monkeypatch.setattr(
        hosted.webbrowser, "open", lambda url: opened.append(url) or True
    )

    assert hosted._open_hosted_app("p" * 43, True, is_pending=None) is False
    assert opened == [PAIRING_URL]


def test_background_delivery_runs_off_the_event_loop_thread(monkeypatch):
    """Waiting for the browser must never block the server accepting it."""
    calls = []
    monkeypatch.setattr(
        hosted,
        "_open_hosted_app",
        lambda token, open_browser, is_pending: calls.append(
            (token, open_browser, is_pending(), threading.current_thread())
        ),
    )

    thread = hosted._deliver_in_background("p" * 43, True, lambda: False)
    thread.join(timeout=5)

    assert calls == [("p" * 43, True, False, thread)]
    assert thread is not threading.current_thread()


def test_installed_app_browser_reads_the_shim(monkeypatch, tmp_path):
    monkeypatch.setattr(hosted.sys, "platform", "darwin")
    missing = tmp_path / "empty"
    shim = tmp_path / "apps" / hosted.APP_SHIM_NAME / "Contents"
    shim.mkdir(parents=True)
    with open(shim / "Info.plist", "wb") as handle:
        plistlib.dump({"CrBundleIdentifier": "com.brave.Browser"}, handle)
    monkeypatch.setattr(
        hosted, "APP_SHIM_DIRECTORIES", (missing, tmp_path / "apps")
    )

    assert hosted._installed_app_browser() == "com.brave.Browser"


def test_installed_app_browser_is_none_without_a_shim(monkeypatch, tmp_path):
    monkeypatch.setattr(hosted.sys, "platform", "darwin")
    monkeypatch.setattr(hosted, "APP_SHIM_DIRECTORIES", (tmp_path,))

    assert hosted._installed_app_browser() is None


def test_installed_app_browser_is_macos_only(monkeypatch):
    monkeypatch.setattr(hosted.sys, "platform", "win32")
    # Not iterable: scanning for a macOS shim elsewhere would raise, not pass.
    monkeypatch.setattr(hosted, "APP_SHIM_DIRECTORIES", None)

    assert hosted._installed_app_browser() is None


def test_launcher_skips_browsers_entirely_with_no_browser(monkeypatch, capsys):
    monkeypatch.setattr(
        hosted.webbrowser, "open", lambda _url: pytest.fail("--no-browser opens nothing")
    )

    assert hosted._open_hosted_app("p" * 43, False) is False
    assert "manual Pair action" in capsys.readouterr().out


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
