"""Percent-format parity and full reproducibility-runner scenarios."""

import json
import subprocess
import sys
from pathlib import Path

import pytest

import knuth.runner as runner
from knuth.artifacts import MANIFEST_NAME, owned_figure_names
from knuth.percent import (
    Cell,
    Document,
    parse_document,
    scratch_code,
    serialize_document,
    set_scratch_code,
)
from knuth.runner import run_file

REPO = Path(__file__).resolve().parents[2]
CORPUS = REPO / "src" / "format" / "corpus"


def test_corpus_parity():
    files = sorted(CORPUS.glob("*.py"))
    assert files, f"corpus not found at {CORPUS}"
    for f in files:
        # newline="" keeps \r\n literal — the bytes the browser sees, not
        # universal-newline translation.
        with f.open(newline="") as stream:
            text = stream.read()
        assert serialize_document(parse_document(text)) == text, f"round-trip: {f.name}"
    for text in ["", "\n", "x = 1", "# %%"]:
        assert serialize_document(parse_document(text)) == text, repr(text)
    print(f"percent port: round-trip parity on {len(files)} corpus files")


def test_crlf_documents_are_canonicalized_to_lf(tmp_path):
    # DECIDED (DESIGN.md): everything knuth run writes is LF. A CRLF file
    # is canonicalized wholesale on its first receipt rewrite — one
    # line-ending diff on first run, byte-stable ever after.
    doc_path = tmp_path / "windows.py"
    doc_path.write_bytes(b"# %%\r\nprint('hi')\r\n")
    quiet = lambda *_: None
    assert run_file(doc_path, echo=quiet) == 0
    after = doc_path.read_bytes()
    assert b"\r" not in after, "canonicalized to LF"
    assert b"#-> hi" in after, after
    assert run_file(doc_path, echo=quiet) == 0
    assert doc_path.read_bytes() == after, "second run must be byte-stable"


def test_corpus_structure_parity():
    # The same expectations src/format/round-trip.test.ts asserts against
    # percent.ts: the two parsers must agree on structure, not just on
    # round-tripping (the CRLF divergence hid in exactly that gap).
    expected = json.loads((CORPUS.parent / "corpus-structure.json").read_text())
    files = sorted(CORPUS.glob("*.py"))
    assert sorted(expected) == [f.name for f in files]
    for f in files:
        with f.open(newline="") as stream:
            doc = parse_document(stream.read())
        signature = {
            "preamble": len(doc.preamble),
            "trailingNewline": doc.trailing_newline,
            "cells": [
                {
                    "kind": c.kind,
                    "marker": c.marker,
                    "source": len(c.source),
                    "output": len(c.output),
                    "trailing": len(c.trailing),
                }
                for c in doc.cells
            ],
        }
        assert signature == expected[f.name], f.name


def test_corpus_crlf_structure():
    # Same structural reading as round-trip.test.ts asserts: CRLF endings
    # still delimit cells, in both implementations.
    with (CORPUS / "crlf.py").open(newline="") as stream:
        doc = parse_document(stream.read())
    assert len(doc.preamble) == 2
    assert [c.kind for c in doc.cells] == ["program", "text", "scratch"]
    assert len(doc.cells[0].output) == 1


def test_corpus_scratch_structure():
    # Same structural reading as round-trip.test.ts asserts: a commented
    # ("#|") scratch body decodes to its original code, "#|"-looking lines
    # inside the code included.
    with (CORPUS / "scratch.py").open(newline="") as stream:
        doc = parse_document(stream.read())
    assert [c.kind for c in doc.cells] == ["text", "program", "scratch"]
    scratch = doc.cells[2]
    assert scratch.output == ["#-> 84"]
    assert scratch_code(scratch) == (
        "probe = x * 2\n\n#| looks like a marker but is just code"
    )


def test_scratch_code_round_trip():
    cell = Cell(kind="scratch", marker="# %% scratch")
    set_scratch_code(cell, "a = 1\n\nb = 2")
    assert cell.source == ["#| a = 1", "#|", "#| b = 2"]
    assert scratch_code(cell) == "a = 1\n\nb = 2"


def test_scratch_code_legacy_passthrough():
    # A line without the "#| " prefix (legacy bare-code scratch) passes
    # through decode unchanged.
    cell = Cell(kind="scratch", marker="# %% scratch", source=["x * 2", "", "y = 3"])
    assert scratch_code(cell) == "x * 2\n\ny = 3"


def test_scratch_code_with_pipe_in_code():
    # Code that itself looks like "#|" round-trips: encode prepends its own
    # prefix, decode strips exactly one, so the code text comes back whole.
    cell = Cell(kind="scratch", marker="# %% scratch")
    set_scratch_code(cell, "#| not a marker\nreal_code = 1")
    assert cell.source == ["#| #| not a marker", "#| real_code = 1"]
    assert scratch_code(cell) == "#| not a marker\nreal_code = 1"


def test_set_scratch_code_empty_clears_source():
    cell = Cell(kind="scratch", marker="# %% scratch", source=["#| leftover"])
    set_scratch_code(cell, "")
    assert cell.source == []


def test_legacy_scratch_body_is_canonicalized_by_run(tmp_path):
    # DECIDED: the same rewrite that lays down receipts also canonicalizes
    # every scratch cell's body to its commented "#|" form — same doctrine
    # as the CRLF canonicalization above.
    doc_path = tmp_path / "legacy.py"
    doc_path.write_text(
        "# %%\n"
        "x = 1\n"
        "print(x)\n"
        "\n"
        "# %% scratch\n"
        "x * 2\n"
        "#-> stale scratch receipt\n"
    )
    quiet = lambda *_: None
    assert run_file(doc_path, echo=quiet) == 0
    after = doc_path.read_text()
    doc = parse_document(after)
    program, scratch = doc.cells
    assert program.output == ["#-> 1"], program.output
    assert scratch.source == ["#| x * 2"], scratch.source
    assert scratch.output == ["#-> stale scratch receipt"], scratch.output

    # Idempotence: a second run reproduces the same bytes (the body is
    # already in "#|" form, so decode-then-encode is a no-op).
    assert run_file(doc_path, echo=quiet) == 0
    assert doc_path.read_text() == after, "second run must be byte-stable"


def test_scratch_body_does_not_execute_under_plain_python(tmp_path):
    # The whole point of the "#|" convention: `python file.py` runs the
    # program cells but never the scratch body.
    marker_file = tmp_path / "scratch_ran.txt"
    program = Cell(kind="program", marker="# %%", source=["print('program ran')"])
    scratch = Cell(kind="scratch", marker="# %% scratch")
    set_scratch_code(scratch, f"open({str(marker_file)!r}, 'w').write('scratch ran')")
    doc = Document(cells=[program, scratch])
    doc_path = tmp_path / "plain.py"
    doc_path.write_text(serialize_document(doc))

    result = subprocess.run(
        [sys.executable, str(doc_path)], capture_output=True, text=True
    )
    assert result.returncode == 0, result.stderr
    assert "program ran" in result.stdout
    assert not marker_file.exists(), "scratch body executed under plain python"


DOC = """\
# %% [markdown]
# # Demo analysis

# %%
with open('data.csv') as f:
    total = sum(int(line) for line in f)

# %% scratch
total * 2
#-> stale scratch receipt stays

# %%
print('total is', total)
total

# %%
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
ax.plot([1, 2], [1, total])
"""

BROKEN = """\
# %%
x = 1

# %%
raise RuntimeError('boom')

# %%
y = 2
#-> receipt from an older run
"""


def test_runner(tmp_path):
    (tmp_path / "data.csv").write_text("1\n2\n3\n")
    doc_path = tmp_path / "analysis.py"
    doc_path.write_text(DOC)

    quiet = lambda *_: None
    assert run_file(doc_path, echo=quiet) == 0

    after = doc_path.read_text()
    doc = parse_document(after)
    kinds = [c.kind for c in doc.cells]
    assert kinds == ["text", "program", "scratch", "program", "program"], kinds
    assert doc.cells[1].output == [], "assignment-only cell has no output"
    assert doc.cells[2].output == ["#-> stale scratch receipt stays"], doc.cells[2].output
    assert doc.cells[3].output == ["#-> total is 6", "#-> 6"], doc.cells[3].output
    # Figure receipt: the cell that bound fig references its path.
    assert doc.cells[4].output[-1] == "#-> figs/fig.svg", doc.cells[4].output

    values = json.loads((tmp_path / "values.json").read_text())
    assert values["total"] == 6, values
    assert (tmp_path / "figs" / "fig.svg").exists()
    assert "<svg" in (tmp_path / "figs" / "fig.svg").read_text()
    assert not (tmp_path / "figs" / "ax.svg").exists(), "one canonical file per figure"

    # Idempotence: a second run reproduces the same bytes.
    assert run_file(doc_path, echo=quiet) == 0
    assert doc_path.read_text() == after, "second run must be byte-stable"

    # Failure: stops at the error, writes the traceback receipt, leaves
    # later receipts and the previous contract untouched.
    broken_path = tmp_path / "broken.py"
    broken_path.write_text(BROKEN)
    contract_before = (tmp_path / "values.json").read_text()
    assert run_file(broken_path, echo=quiet) == 1
    doc = parse_document(broken_path.read_text())
    assert any("RuntimeError: boom" in line for line in doc.cells[1].output)
    assert doc.cells[2].output == ["#-> receipt from an older run"]
    assert (tmp_path / "values.json").read_text() == contract_before

    # No program cells: refuse.
    empty = tmp_path / "prose.py"
    empty.write_text("# %% [markdown]\n# words only\n")
    assert run_file(empty, echo=quiet) == 1

    # A plain script (no markers) runs whole as the implicit cell
    # zero, produces artifacts, and comes back byte-identical.
    script = tmp_path / "scene.py"
    script_text = '#!/usr/bin/env python\nanswer = 6 * 7\nprint("hi")\n'
    script.write_text(script_text)
    assert run_file(script, echo=quiet) == 0
    assert script.read_text() == script_text, "markerless script must stay untouched"
    values = json.loads((tmp_path / "values.json").read_text())
    assert values["answer"] == 42, values

    # Preamble plus cells: the preamble runs first, cells see its names.
    mixed = tmp_path / "mixed.py"
    mixed.write_text("base = 10\n\n# %%\nresult = base + 1\nresult\n")
    assert run_file(mixed, echo=quiet) == 0
    doc = parse_document(mixed.read_text())
    assert doc.preamble[0] == "base = 10", doc.preamble
    assert doc.cells[0].output == ["#-> 11"], doc.cells[0].output


def test_runner_owns_only_manifested_figures(tmp_path):
    document = tmp_path / "figures.py"
    document.write_text(
        "# %%\n"
        "import matplotlib\n"
        "matplotlib.use('Agg')\n"
        "import matplotlib.pyplot as plt\n"
        "plot = plt.figure()\n"
    )
    quiet = lambda *_: None
    assert run_file(document, echo=quiet) == 0
    generated = tmp_path / "figs" / "plot.svg"
    assert generated.exists()
    assert owned_figure_names((tmp_path / MANIFEST_NAME).read_text()) == {"plot"}

    user_svg = tmp_path / "figs" / "user-owned.svg"
    user_svg.write_text("<svg><!-- mine --></svg>")
    document.write_text("# %%\nanswer = 42\n")
    assert run_file(document, echo=quiet) == 0
    assert not generated.exists(), "a stale Knuth-owned SVG should be removed"
    assert user_svg.exists(), "an unmanifested user SVG must never be deleted"
    assert owned_figure_names((tmp_path / MANIFEST_NAME).read_text()) == set()

    # Migration: a project with no ownership manifest keeps every old SVG.
    legacy = tmp_path / "legacy"
    (legacy / "figs").mkdir(parents=True)
    legacy_svg = legacy / "figs" / "old.svg"
    legacy_svg.write_text("<svg/>")
    legacy_doc = legacy / "analysis.py"
    legacy_doc.write_text("# %%\nvalue = 1\n")
    assert run_file(legacy_doc, echo=quiet) == 0
    assert legacy_svg.exists()


def test_atomic_write_never_exposes_a_partial_destination(tmp_path, monkeypatch):
    destination = tmp_path / "receipt.py"
    destination.write_text("last complete bytes\n")

    def interrupted_replace(source, target):
        assert Path(target).read_text() == "last complete bytes\n"
        raise OSError("simulated interruption before replace")

    monkeypatch.setattr(runner.os, "replace", interrupted_replace)
    with pytest.raises(OSError, match="simulated interruption"):
        runner._atomic_write(destination, "new complete bytes\n")

    assert destination.read_text() == "last complete bytes\n"
    assert list(tmp_path.glob(".receipt.py.*.tmp")) == []
