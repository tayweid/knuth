"""knuth run: percent-port parity with the TS corpus, then full runner
scenarios. Run with the project venv:
.venv/bin/python python/tests/test_run.py
"""

import json
import shutil
import tempfile
from pathlib import Path

from knuth.percent import parse_document, serialize_document
from knuth.runner import run_file

REPO = Path(__file__).resolve().parents[2]
CORPUS = REPO / "src" / "format" / "corpus"


def test_corpus_parity():
    files = sorted(CORPUS.glob("*.py"))
    assert files, f"corpus not found at {CORPUS}"
    for f in files:
        text = f.read_text()
        assert serialize_document(parse_document(text)) == text, f"round-trip: {f.name}"
    for text in ["", "\n", "x = 1", "# %%"]:
        assert serialize_document(parse_document(text)) == text, repr(text)
    print(f"percent port: round-trip parity on {len(files)} corpus files")


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


def test_runner():
    tmp = Path(tempfile.mkdtemp(prefix="knuth-run-"))
    try:
        (tmp / "data.csv").write_text("1\n2\n3\n")
        doc_path = tmp / "analysis.py"
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

        values = json.loads((tmp / "values.json").read_text())
        assert values["total"] == 6, values
        assert (tmp / "figs" / "fig.svg").exists()
        assert "<svg" in (tmp / "figs" / "fig.svg").read_text()

        # Idempotence: a second run reproduces the same bytes.
        assert run_file(doc_path, echo=quiet) == 0
        assert doc_path.read_text() == after, "second run must be byte-stable"

        # Failure: stops at the error, writes the traceback receipt, leaves
        # later receipts and the previous contract untouched.
        broken_path = tmp / "broken.py"
        broken_path.write_text(BROKEN)
        contract_before = (tmp / "values.json").read_text()
        assert run_file(broken_path, echo=quiet) == 1
        doc = parse_document(broken_path.read_text())
        assert any("RuntimeError: boom" in line for line in doc.cells[1].output)
        assert doc.cells[2].output == ["#-> receipt from an older run"]
        assert (tmp / "values.json").read_text() == contract_before

        # No program cells: refuse.
        empty = tmp / "prose.py"
        empty.write_text("# %% [markdown]\n# words only\n")
        assert run_file(empty, echo=quiet) == 1

        print("runner: all scenarios passed")
    finally:
        shutil.rmtree(tmp)


if __name__ == "__main__":
    test_corpus_parity()
    test_runner()
    print("test_run: all assertions passed")
