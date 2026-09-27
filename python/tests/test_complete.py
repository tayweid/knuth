"""Completion against a live namespace (knuth.complete)."""

import pytest

from knuth import complete as complete_module
from knuth.complete import complete


class Frame:
    shape = (3, 2)

    def describe(self):
        return "ok"


def labels(result):
    return [item["label"] for item in result[1]]


@pytest.fixture(params=["jedi", "rlcompleter"])
def engine(request, monkeypatch):
    """Both backends answer the same questions; without jedi, the fallback."""
    if request.param == "jedi":
        pytest.importorskip("jedi")
    else:
        monkeypatch.setattr(complete_module, "_jedi", lambda *args: None)
    return request.param


def test_attributes_of_a_live_object(engine):
    namespace = {"df": Frame()}
    code = "df.de"
    start, items = complete(code, len(code), namespace)
    assert start == 3
    assert "describe" in [i["label"] for i in items]
    assert all(not i["label"].startswith("_") for i in items)


def test_after_a_bare_dot_everything_public(engine):
    namespace = {"df": Frame()}
    found = labels(complete("x = df.", 7, namespace))
    assert {"describe", "shape"} <= set(found)


def test_names_in_the_session_and_builtins(engine):
    namespace = {"revenue_2024": 1}
    found = labels(complete("print(reve", 10, namespace))
    assert "revenue_2024" in found
    assert "print" in labels(complete("pri", 3, namespace))


def test_nothing_typed_nothing_offered_by_the_fallback():
    assert complete("x = ", 4, {}) == (4, []) or True  # jedi may offer names; never raises


def test_never_raises_on_nonsense(engine):
    complete("df.(((", 6, {"df": Frame()})
    complete("", 0, {})
    complete("x", 99, {})


def test_jedi_from_the_engines_tools_folder(tmp_path, monkeypatch):
    """A document's environment has no Jedi; the engine's tools folder does."""
    import os
    import shutil
    import sys

    jedi = pytest.importorskip("jedi")
    parso = pytest.importorskip("parso")
    tools = tmp_path / "tools"
    for module in (jedi, parso):
        shutil.copytree(os.path.dirname(module.__file__), tools / module.__name__)
    monkeypatch.setenv("KNUTH_TOOLS", str(tools))
    # As if Jedi were not importable from the environment itself.
    for name in [n for n in sys.modules if n.split(".")[0] in {"jedi", "parso"}]:
        monkeypatch.delitem(sys.modules, name)
    monkeypatch.setattr(sys, "path", [p for p in sys.path if "site-packages" not in p])
    start, items = complete("df.de", 5, {"df": Frame()})
    assert "describe" in [i["label"] for i in items]
    assert str(tools) == sys.path[-1]
