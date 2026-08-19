"""Percent-format parity and full reproducibility-runner scenarios."""

import json
from pathlib import Path

import pytest

import knuth.runner as runner
from knuth.artifacts import MANIFEST_NAME, owned_figure_names
from knuth.percent import parse_document, serialize_document
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


def test_corpus_crlf_structure():
    # Same structural reading as round-trip.test.ts asserts: CRLF endings
    # still delimit cells, in both implementations.
    with (CORPUS / "crlf.py").open(newline="") as stream:
        doc = parse_document(stream.read())
    assert len(doc.preamble) == 2
    assert [c.kind for c in doc.cells] == ["program", "text", "scratch"]
    assert len(doc.cells[0].output) == 1


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
