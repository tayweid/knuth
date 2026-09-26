"""The document's environment (ENVIRONMENT.md): the PEP 723 header, uv, the
shim that carries the kernel into another interpreter, import installs."""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from knuth import env

HEADER = [
    "# /// script",
    '# requires-python = ">=3.11"',
    "# dependencies = [",
    '#     "pandas==2.3.2",',
    "# ]",
    "#",
    "# [tool.uv]",
    '# exclude-newer = "2026-09-26T00:00:00Z"',
    "# ///",
]
DOC = "\n".join(HEADER) + "\n\n# %%\nimport pandas\n"


def uv_with_managed_python():
    """The integration gate: uv, and a uv-managed Python already on disk (a
    download in a test would be minutes and a network)."""
    if not env.find_uv():
        return False
    return env.run_uv(["python", "find"]).returncode == 0


needs_uv = pytest.mark.skipif(
    not uv_with_managed_python(), reason="needs uv and a uv-managed Python"
)


# --- the header -------------------------------------------------------------


def test_find_header_spans_the_block_and_survives_an_adjacent_cell():
    assert env.find_header(DOC) == (0, 8)
    assert env.header_lines(DOC) == HEADER
    # No blank line before the first cell: `# %%` is a comment line too, and
    # the block still closes at its own `# ///`.
    tight = "\n".join(HEADER) + "\n# %%\nimport pandas\n# ///\n"
    assert env.find_header(tight) == (0, 8)
    assert env.find_header("# %%\nx = 1\n") is None
    assert env.header_lines("") is None
    # An opener with no closer in its comment run is not a header.
    assert env.find_header("# /// script\n# dependencies = []\nx = 1\n# ///\n") is None


def test_parse_header_reads_python_dependencies_and_stamp():
    parsed = env.parse_header(DOC)
    assert parsed == {
        "requires_python": ">=3.11",
        "dependencies": ["pandas==2.3.2"],
        "exclude_newer": "2026-09-26T00:00:00Z",
    }
    assert env.parse_header("x = 1\n") is None
    broken = env.parse_header("# /// script\n# dependencies = [\n# ///\n")
    assert broken["dependencies"] == [] and "TOML" in broken["error"]


def test_new_header_matches_uv_init_and_is_stamped():
    lines = env.new_header(">=3.12", "2026-01-02T00:00:00Z")
    assert lines == [
        "# /// script",
        '# requires-python = ">=3.12"',
        "# dependencies = []",
        "#",
        "# [tool.uv]",
        '# exclude-newer = "2026-01-02T00:00:00Z"',
        "# ///",
    ]
    default = env.new_header()
    parsed = env.parse_header("\n".join(default))
    assert parsed["requires_python"] == env.default_requires_python()
    assert parsed["exclude_newer"].endswith("T00:00:00Z") and len(parsed["exclude_newer"]) == 20
    assert env.default_requires_python() >= ">=3.11"


def test_with_header_prepends_once_and_leaves_the_text_alone():
    text, lines = env.with_header("# %%\nx = 1\n", ">=3.12", "2026-01-02T00:00:00Z")
    assert lines == env.new_header(">=3.12", "2026-01-02T00:00:00Z")
    assert text == "\n".join(lines) + "\n\n# %%\nx = 1\n"
    assert env.with_header(text) == (text, None)
    crlf, lines = env.with_header("# %%\r\nx = 1\r\n", ">=3.12", "2026-01-02T00:00:00Z")
    assert crlf == "\r\n".join(lines) + "\r\n\r\n# %%\r\nx = 1\r\n"
    assert env.header_lines(crlf) == lines and env.find_header(crlf) == (0, 6)
    assert env.parse_header(crlf)["requires_python"] == ">=3.12"
    empty, lines = env.with_header("", ">=3.12", "2026-01-02T00:00:00Z")
    assert empty == "\n".join(lines) + "\n"


def test_pinned_version_normalizes_names():
    assert env.pinned_version(DOC, "pandas") == "2.3.2"
    assert env.pinned_version(DOC, "numpy") is None
    doc = "# /// script\n# dependencies = [\"Scikit_Learn==1.5.0\"]\n# ///\n"
    assert env.pinned_version(doc, "scikit-learn") == "1.5.0"


# --- import installs --------------------------------------------------------


def test_missing_imports_skips_stdlib_installed_relative_and_broken():
    assert env.missing_imports("import os, json\nfrom pathlib import Path\n") == []
    assert env.missing_imports("import pytest\n") == []  # installed here
    assert env.missing_imports("from . import sibling\n") == []
    assert env.missing_imports("def broken(:\n") == []
    code = (
        "import knuth_surely_missing_a\n"
        "from knuth_surely_missing_b.sub import thing\n"
        "import knuth_surely_missing_a as again\n"
        "def f():\n    import knuth_surely_missing_c\n"
    )
    assert env.missing_imports(code) == [
        "knuth_surely_missing_a",
        "knuth_surely_missing_b",
        "knuth_surely_missing_c",
    ]


def test_distribution_names():
    assert env.distribution_for("sklearn") == "scikit-learn"
    assert env.distribution_for("PIL") == "pillow"
    assert env.distribution_for("pandas") == "pandas"


def test_install_missing_reports_each_step_and_the_new_header(tmp_path, monkeypatch):
    document = tmp_path / "analysis.py"
    document.write_text(DOC)
    events = []
    monkeypatch.setattr(env, "missing_imports", lambda code: ["pandas", "nope"])

    def fake_add(path, distribution):
        assert path == str(document)
        if distribution == "nope":
            return False, "No solution found"
        return True, None

    monkeypatch.setattr(env, "add_dependency", fake_add)
    changed = env.install_missing("import pandas, nope", str(document), events.append, 7)
    assert changed
    assert [e["type"] for e in events] == ["dependency", "dependency", "dependency", "dependency", "header"]
    assert events[0] == {"type": "dependency", "id": 7, "module": "pandas", "distribution": "pandas", "state": "installing"}
    assert events[1]["state"] == "installed" and events[1]["version"] == "2.3.2"
    assert events[3]["state"] == "failed" and "No solution" in events[3]["error"]
    header = events[4]
    assert header["path"] == str(document) and header["lines"] == HEADER
    assert header["modified"] == int(document.stat().st_mtime * 1000)


def test_install_missing_is_silent_when_nothing_is_missing(tmp_path, monkeypatch):
    document = tmp_path / "analysis.py"
    document.write_text(DOC)
    events = []
    monkeypatch.setattr(env, "add_dependency", lambda *a: pytest.fail("must not install"))
    assert not env.install_missing("import os\n", str(document), events.append, 1)
    assert events == []


# --- the environment --------------------------------------------------------


def test_ensure_environment_falls_back_with_a_reason(tmp_path, monkeypatch):
    assert env.ensure_environment(None).reason == "no document"
    plain = tmp_path / "plain.py"
    plain.write_text("# %%\nx = 1\n")
    fallback = env.ensure_environment(str(plain))
    assert not fallback.managed and fallback.python == sys.executable
    assert fallback.reason == "no environment header"
    assert fallback.event()["state"] == "fallback"

    document = tmp_path / "analysis.py"
    document.write_text(DOC)
    monkeypatch.setattr(env, "find_uv", lambda: None)
    assert "uv is not installed" in env.ensure_environment(str(document)).reason
    assert not env.is_candidate(str(document))

    monkeypatch.setattr(env, "find_uv", lambda: "/usr/bin/true")
    assert env.is_candidate(str(document))
    monkeypatch.setattr(
        env,
        "run_uv",
        lambda args, cwd=None: subprocess.CompletedProcess(
            args, 1, "", "Creating script environment at: /x\n  × No solution found\n"
        ),
    )
    failed = env.ensure_environment(str(document))
    assert not failed.managed and failed.reason == "× No solution found"


def test_kernel_environ_isolates_the_shim_and_names_the_document(tmp_path):
    plain = env.kernel_environ(None)
    assert plain["MPLBACKEND"] == "Agg" and env.DOCUMENT_VAR not in plain
    managed = env.kernel_environ(env.Environment(str(tmp_path / "a.py"), sys.executable, True))
    shim = managed["PYTHONPATH"].split(os.pathsep)[0]
    assert shim == env.shim_dir()
    assert managed[env.DOCUMENT_VAR] == str(tmp_path / "a.py")
    assert managed["UV_PYTHON_PREFERENCE"] == "only-managed"
    init = Path(shim) / "knuth" / "__init__.py"
    assert init.read_text() == f"__path__ = [{str(Path(env.__file__).resolve().parent)!r}]\n"


def test_kernel_side_modules_need_only_the_standard_library():
    """The kernel runs in the document's environment, which has none of the
    engine's packages: -S hides site-packages, the shim supplies knuth."""
    result = subprocess.run(
        [
            sys.executable, "-S", "-c",
            "import knuth.kernel, knuth.session, knuth.contract, knuth.artifacts, "
            "knuth.limits, knuth.env, knuth.cli, knuth.runner, knuth.percent; "
            "print(knuth.kernel.__file__)",
        ],
        env={**os.environ, "PYTHONPATH": env.shim_dir()},
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == str(Path(env.__file__).resolve().parent / "kernel.py")


@needs_uv
def test_uv_builds_the_environment_and_pins_what_it_adds(tmp_path):
    document = tmp_path / "analysis.py"
    document.write_text(
        "# /// script\n"
        '# requires-python = ">=3.11"\n'
        "# dependencies = []\n"
        "#\n"
        "# [tool.uv]\n"
        '# exclude-newer = "2026-09-26T00:00:00Z"\n'
        "# ///\n\n# %%\nimport tomli_w\n"
    )
    environment = env.ensure_environment(str(document))
    assert environment.managed, environment.reason
    assert not env.same_interpreter(environment.python)

    ok, reason = env.add_dependency(str(document), "tomli-w")
    assert ok, reason
    parsed = env.parse_header(document.read_text())
    assert len(parsed["dependencies"]) == 1
    assert parsed["dependencies"][0].startswith("tomli-w==")
    assert parsed["exclude_newer"] == "2026-09-26T00:00:00Z", "uv kept the stamp"
    assert env.pinned_version(document.read_text(), "tomli-w") is not None

    # The kernel imports it there, through the shim, without knuth installed.
    result = subprocess.run(
        [environment.python, "-c", "import tomli_w, knuth.kernel; print('ok')"],
        env=env.kernel_environ(environment),
        capture_output=True,
        text=True,
    )
    assert result.stdout.strip() == "ok", result.stderr


@needs_uv
def test_knuth_env_prints_the_interpreter(tmp_path):
    document = tmp_path / "analysis.py"
    document.write_text("# /// script\n# requires-python = \">=3.11\"\n# dependencies = []\n# ///\n# %%\n")
    result = subprocess.run(
        [sys.executable, "-m", "knuth", "env", str(document)],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert Path(result.stdout.strip()).exists()
    plain = tmp_path / "plain.py"
    plain.write_text("# %%\n")
    result = subprocess.run(
        [sys.executable, "-m", "knuth", "env", str(plain)], capture_output=True, text=True
    )
    assert result.returncode == 1 and "no environment header" in result.stderr


# --- add_pin: uv's header edit, reproduced ---------------------------------

REQUIRES = '# requires-python = ">=3.11"\n'
STAMP = '#\n# [tool.uv]\n# exclude-newer = "2026-09-26T00:00:00Z"\n# ///\n'

# (document before, (name, version), document after), each `after` taken
# from what `uv add --script --frozen name==version` wrote on 2026-09-26.
PIN_CASES = [
    (  # an empty list becomes the multi-line form; the text below is untouched
        "# /// script\n" + REQUIRES + "# dependencies = []\n" + STAMP + "\n# %%\nx = 1\n",
        ("tomli-w", "1.2.0"),
        "# /// script\n" + REQUIRES + '# dependencies = [\n#     "tomli-w==1.2.0",\n# ]\n' + STAMP + "\n# %%\nx = 1\n",
    ),
    (  # an inline array expands; sorted insert; a cell right after the header stays put
        "# /// script\n" + REQUIRES + '# dependencies = ["rich==15.0.0"]\n' + STAMP + "# %%\nx = 1\n",
        ("attrs", "25.3.0"),
        "# /// script\n" + REQUIRES + '# dependencies = [\n#     "attrs==25.3.0",\n#     "rich==15.0.0",\n# ]\n' + STAMP + "# %%\nx = 1\n",
    ),
    (  # sorted list: insert in order
        "# /// script\n" + REQUIRES + '# dependencies = [\n#     "pandas==2.3.2",\n#     "rich==15.0.0",\n# ]\n' + STAMP + "\n# %%\n",
        ("numpy", "2.3.3"),
        "# /// script\n" + REQUIRES + '# dependencies = [\n#     "numpy==2.3.3",\n#     "pandas==2.3.2",\n#     "rich==15.0.0",\n# ]\n' + STAMP + "\n# %%\n",
    ),
    (  # an existing entry is replaced in place
        "# /// script\n" + REQUIRES + '# dependencies = [\n#     "numpy==2.3.3",\n#     "pandas==2.3.2",\n# ]\n' + STAMP + "\n# %%\n",
        ("pandas", "2.2.0"),
        "# /// script\n" + REQUIRES + '# dependencies = [\n#     "numpy==2.3.3",\n#     "pandas==2.2.0",\n# ]\n' + STAMP + "\n# %%\n",
    ),
    (  # the written name is normalized
        "# /// script\n" + REQUIRES + '# dependencies = [\n#     "pandas==2.3.2",\n# ]\n' + STAMP + "\n# %%\n",
        ("Tomli_W", "1.2.0"),
        "# /// script\n" + REQUIRES + '# dependencies = [\n#     "pandas==2.3.2",\n#     "tomli-w==1.2.0",\n# ]\n' + STAMP + "\n# %%\n",
    ),
    (  # no stamp, no requires-python: only the array changes
        "# /// script\n# dependencies = []\n# ///\n# %%\n",
        ("tomli-w", "1.2.0"),
        '# /// script\n# dependencies = [\n#     "tomli-w==1.2.0",\n# ]\n# ///\n# %%\n',
    ),
    (  # an unsorted list gets the new entry appended, others untouched
        "# /// script\n" + REQUIRES + '# dependencies = [\n#     "rich==15.0.0",\n#     "Attrs>=25",\n#     "pandas[performance]>=2.2",\n# ]\n# ///\n# %%\n',
        ("numpy", "2.3.3"),
        "# /// script\n" + REQUIRES + '# dependencies = [\n#     "rich==15.0.0",\n#     "Attrs>=25",\n#     "pandas[performance]>=2.2",\n#     "numpy==2.3.3",\n# ]\n# ///\n# %%\n',
    ),
    (  # replacing keeps extras
        "# /// script\n" + REQUIRES + '# dependencies = [\n#     "rich==15.0.0",\n#     "pandas[performance]>=2.2",\n# ]\n# ///\n# %%\n',
        ("pandas", "2.3.2"),
        "# /// script\n" + REQUIRES + '# dependencies = [\n#     "rich==15.0.0",\n#     "pandas[performance]==2.3.2",\n# ]\n# ///\n# %%\n',
    ),
    (  # a marker survives, quotes escaped as TOML wants them
        "# /// script\n" + REQUIRES + '# dependencies = [\n#     "rich==15.0.0; sys_platform == \\"darwin\\"",\n# ]\n# ///\n# %%\n',
        ("attrs", "25.3.0"),
        "# /// script\n" + REQUIRES + '# dependencies = [\n#     "attrs==25.3.0",\n#     "rich==15.0.0; sys_platform == \\"darwin\\"",\n# ]\n# ///\n# %%\n',
    ),
]


@pytest.mark.parametrize("before, pin, after", PIN_CASES, ids=[str(i) for i in range(len(PIN_CASES))])
def test_add_pin_writes_what_uv_writes(before, pin, after):
    new_text, lines = env.add_pin(before, *pin)
    assert new_text == after
    assert lines == env.header_lines(after)
    assert env.pinned_version(new_text, pin[0]) == pin[1]


def test_add_pin_keeps_crlf_and_refuses_without_a_header():
    before = "# /// script\r\n# dependencies = []\r\n# ///\r\n# %%\r\nx = 1\r\n"
    new_text, lines = env.add_pin(before, "tomli-w", "1.2.0")
    assert new_text == '# /// script\r\n# dependencies = [\r\n#     "tomli-w==1.2.0",\r\n# ]\r\n# ///\r\n# %%\r\nx = 1\r\n'
    assert lines == ["# /// script", "# dependencies = [", '#     "tomli-w==1.2.0",', "# ]", "# ///"]
    assert env.add_pin("# %%\nx = 1\n", "tomli-w", "1.2.0") is None
    assert env.add_pin("# /// script\n# dependencies = [\n# ///\n", "tomli-w", "1.2.0") is None


def test_add_pin_adds_a_missing_dependencies_key():
    new_text, _ = env.add_pin("# /// script\n" + REQUIRES + "# ///\n", "attrs", "25.3.0")
    assert new_text == "# /// script\n" + REQUIRES + '# dependencies = [\n#     "attrs==25.3.0",\n# ]\n# ///\n'


@needs_uv
@pytest.mark.parametrize("before, pin, after", PIN_CASES, ids=[str(i) for i in range(len(PIN_CASES))])
def test_add_pin_matches_uv_today(tmp_path, before, pin, after):
    """The parity check behind the recorded expectations: the same edit made
    by the uv on this machine. --frozen skips resolving, so no network."""
    document = tmp_path / "doc.py"
    document.write_text(before, newline="")
    result = env.run_uv(["add", "--script", str(document), "--frozen", f"{pin[0]}=={pin[1]}"])
    assert result.returncode == 0, result.stderr
    assert document.read_text(newline="") == env.add_pin(before, *pin)[0]
