"""Percent-format (.py) document model — Python port of src/format/percent.ts,
same semantics, kept honest by round-tripping the same corpus in tests.

Cells open with "# %%" ("#%%" tolerated, marker preserved verbatim);
"# %% [markdown]" is a text cell; "# %% scratch" (exact token) is a scratch
cell; anything else is a program cell. Outputs are machine-managed "#->"
comment lines forming the trailing run of their cell. Scratch bodies are
stored commented ("#| " prefix) so plain `python file.py` runs only
program cells; "#|" can never match MARKER, so the encoding is lossless.
"""

import re
from dataclasses import dataclass, field

MARKER = re.compile(r"^# ?%%(.*)$")
OUTPUT_PREFIX = "#->"
SCRATCH_PREFIX = "#| "
SCRATCH_BLANK = "#|"


@dataclass
class Cell:
    kind: str  # 'program' | 'scratch' | 'text'
    marker: str
    source: list = field(default_factory=list)
    output: list = field(default_factory=list)
    trailing: list = field(default_factory=list)


@dataclass
class Document:
    preamble: list = field(default_factory=list)
    cells: list = field(default_factory=list)
    trailing_newline: bool = True


def _cell_kind(marker_rest):
    rest = marker_rest.strip()
    if rest.startswith("[markdown]"):
        return "text"
    if rest == "scratch":
        return "scratch"
    return "program"


def _split_body(body):
    end = len(body)
    while end > 0 and body[end - 1].strip() == "":
        end -= 1
    start = end
    while start > 0 and body[start - 1].startswith(OUTPUT_PREFIX):
        start -= 1
    if start == end:
        return body, [], []
    return body[:start], body[start:end], body[end:]


def parse_document(text):
    if text == "":
        return Document(trailing_newline=False)
    lines = text.split("\n")
    trailing_newline = lines[-1] == ""
    if trailing_newline:
        lines.pop()

    doc = Document(trailing_newline=trailing_newline)
    current = None  # (marker, rest, body)

    def close():
        if current is None:
            return
        marker, rest, body = current
        source, output, trailing = _split_body(body)
        doc.cells.append(Cell(_cell_kind(rest), marker, source, output, trailing))

    for line in lines:
        m = MARKER.match(line)
        if m:
            close()
            current = (line, m.group(1), [])
        elif current is not None:
            current[2].append(line)
        else:
            doc.preamble.append(line)
    close()
    return doc


def serialize_document(doc):
    lines = list(doc.preamble)
    for c in doc.cells:
        lines.append(c.marker)
        lines.extend(c.source)
        lines.extend(c.output)
        lines.extend(c.trailing)
    if not lines:
        return ""
    return "\n".join(lines) + ("\n" if doc.trailing_newline else "")


def cell_code(cell):
    return "\n".join(cell.source)


def scratch_code(cell):
    """A scratch cell's code, "#| " comment prefix stripped. A line without
    the prefix (legacy bare-code scratch) passes through unchanged."""

    def decode(line):
        if line == SCRATCH_BLANK:
            return ""
        if line.startswith(SCRATCH_PREFIX):
            return line[len(SCRATCH_PREFIX):]
        return line

    return "\n".join(decode(line) for line in cell.source)


def set_scratch_code(cell, code):
    """Replace a scratch cell's body (canonical "#| " prefixing, blank
    lines as "#|"); empty code clears the source lines entirely."""
    cell.source = [] if code == "" else [
        SCRATCH_BLANK if line == "" else f"{SCRATCH_PREFIX}{line}" for line in code.split("\n")
    ]


def set_output(cell, text):
    """Replace a cell's output block (canonical "#-> " prefixing); None
    clears it. Blank separator lines between cells stay put."""
    if text is None:
        cell.output = []
        cell.source.extend(cell.trailing)
        cell.trailing = []
        return
    if not cell.output:
        end = len(cell.source)
        while end > 0 and cell.source[end - 1].strip() == "":
            end -= 1
        cell.trailing = cell.source[end:]
        cell.source = cell.source[:end]
    cell.output = [
        OUTPUT_PREFIX if line == "" else f"{OUTPUT_PREFIX} {line}" for line in text.split("\n")
    ]
