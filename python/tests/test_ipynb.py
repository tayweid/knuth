"""Notebook import: .ipynb in, percent-format .py out, nothing clobbered."""

import json

import pytest

from knuth.ipynb import import_files, notebook_to_document
from knuth.percent import parse_document, serialize_document


def notebook(*cells, nbformat=4):
    return json.dumps({"nbformat": nbformat, "nbformat_minor": 5, "cells": list(cells)})


def code(*lines, outputs=()):
    return {
        "cell_type": "code",
        "execution_count": 3,
        "source": [line + "\n" for line in lines],
        "outputs": list(outputs),
    }


def markdown(*lines):
    return {"cell_type": "markdown", "source": [line + "\n" for line in lines]}


def test_notebook_becomes_percent_document():
    doc, commented = notebook_to_document(notebook(
        markdown("# Demo", "", "Prose *here*."),
        code("%matplotlib inline", "import math", "!pip install nothing", "x = 1"),
        {"cell_type": "raw", "source": "raw text\npasses through"},
        code("print(x)", outputs=[{"output_type": "stream", "text": ["1\n"]}]),
    ))
    text = serialize_document(doc)
    reparsed = parse_document(text)
    assert serialize_document(reparsed) == text, "import output must round-trip"
    assert [c.kind for c in reparsed.cells] == ["text", "program", "program", "program"]

    # Markdown gets the canonical prose prefix; blanks become bare '#'.
    assert reparsed.cells[0].source[:3] == ["# # Demo", "#", "# Prose *here*."]
    # Magic and shell lines are commented out; real code is untouched.
    assert reparsed.cells[1].source[:4] == [
        "# %matplotlib inline",
        "import math",
        "# !pip install nothing",
        "x = 1",
    ]
    assert commented == 4, commented  # two magic lines, two raw lines
    # Raw cells arrive fully commented.
    assert reparsed.cells[2].source[:2] == ["# raw text", "# passes through"]
    # Outputs are dropped: knuth run regenerates receipts.
    assert reparsed.cells[3].output == []
    assert "1\\n" not in text and "stream" not in text


def test_marker_lookalikes_cannot_split_cells():
    # A commented magic ('# %%time'), a literal '# %%' comment in code, and
    # markdown prose starting '%%' would all parse as cell markers if
    # emitted verbatim; the importer must keep one notebook cell one cell.
    doc, _ = notebook_to_document(notebook(
        code("%%time", "# %% not a marker", "y = 2"),
        markdown("%%sql is a magic"),
    ))
    reparsed = parse_document(serialize_document(doc))
    assert [c.kind for c in reparsed.cells] == ["program", "text"]
    assert len(reparsed.cells) == 2, [c.marker for c in reparsed.cells]


def test_source_as_single_string():
    doc, _ = notebook_to_document(notebook(code("x = 1")) .replace(
        json.dumps(["x = 1\n"]), json.dumps("x = 1\n")))
    assert parse_document(serialize_document(doc)).cells[0].source[0] == "x = 1"


@pytest.mark.parametrize(
    "text, message",
    [
        ("not json", "invalid JSON"),
        (json.dumps({"cells": {}}), "no cells list"),
        (notebook(nbformat=3), "unsupported nbformat 3"),
        (notebook({"cell_type": "widget", "source": []}), "unknown cell type"),
    ],
)
def test_things_that_are_not_notebooks_are_refused(text, message):
    with pytest.raises(ValueError, match=message):
        notebook_to_document(text)


def test_convert_request_rides_the_same_converter():
    """The app's convert request (server.py) answers with this converter."""
    from knuth.server import _convert_response

    msg = _convert_response({"id": 9, "text": notebook(code("%time 1", "y = 2"))})
    assert msg == {
        "type": "converted",
        "id": 9,
        "text": "# %%\n# %time 1\ny = 2\n",
        "commented": 1,
    }

    refusal = _convert_response({"id": 10, "text": "not json"})
    assert refusal["type"] == "converted" and refusal["id"] == 10, refusal
    assert "invalid JSON" in refusal["error"] and "text" not in refusal, refusal


def test_import_files_converts_and_never_overwrites(tmp_path):
    lines = []
    echo = lines.append
    nb = tmp_path / "analysis.ipynb"
    nb.write_text(notebook(code("x = 40 + 2")))

    assert import_files([nb], echo=echo) == 0
    target = tmp_path / "analysis.py"
    written = target.read_bytes()
    assert written == b"# %%\nx = 40 + 2\n"
    assert "analysis.ipynb -> analysis.py (1 cells)" in lines[-1]

    # A second import must refuse to clobber the (possibly edited) .py.
    assert import_files([nb], echo=echo) == 1
    assert "refusing to overwrite" in lines[-1]
    assert target.read_bytes() == written

    # Missing and malformed files fail the run but do not stop the batch.
    bad = tmp_path / "broken.ipynb"
    bad.write_text("{}")
    nb2 = tmp_path / "second.ipynb"
    nb2.write_text(notebook(code("y = 1")))
    assert import_files([tmp_path / "ghost.ipynb", bad, nb2], echo=echo) == 1
    assert (tmp_path / "second.py").exists()
