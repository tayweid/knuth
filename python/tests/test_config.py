"""Secure local capability creation and rotation."""

import stat

import pytest

from knuth.config import capability_path, config_dir, load_or_create_capability, rotate_capability


def test_capability_lifecycle(tmp_path, monkeypatch):
    monkeypatch.setenv("KNUTH_CONFIG_DIR", str(tmp_path / "config"))

    first = load_or_create_capability()
    path = capability_path()
    assert len(first) == 43
    assert path.read_text(encoding="ascii").strip() == first
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
    assert load_or_create_capability() == first

    second = rotate_capability()
    assert second != first
    assert load_or_create_capability() == second
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_capability_rejects_unsafe_permissions(tmp_path, monkeypatch):
    monkeypatch.setenv("KNUTH_CONFIG_DIR", str(tmp_path / "config"))
    load_or_create_capability()
    path = capability_path()
    path.chmod(0o644)

    with pytest.raises(RuntimeError, match="permissions must be 0600"):
        load_or_create_capability()


@pytest.mark.parametrize("content", ["a" * 42, "a" * 44, "a" * 42 + "!"])
def test_capability_rejects_malformed_content(tmp_path, monkeypatch, content):
    directory = tmp_path / "config"
    directory.mkdir(mode=0o700)
    path = directory / "capability"
    path.write_text(content + "\n", encoding="ascii")
    path.chmod(0o600)
    monkeypatch.setenv("KNUTH_CONFIG_DIR", str(directory))

    with pytest.raises(RuntimeError, match="capability is invalid"):
        load_or_create_capability()


def test_windows_uses_roaming_application_data(tmp_path, monkeypatch):
    monkeypatch.delenv("KNUTH_CONFIG_DIR", raising=False)
    monkeypatch.setenv("APPDATA", str(tmp_path / "Roaming"))
    monkeypatch.setattr("knuth.config.sys.platform", "win32")
    assert config_dir() == tmp_path / "Roaming" / "Knuth"
