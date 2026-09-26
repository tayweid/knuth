"""Documents by path: the engine reads, writes, stats, and renames for the
page (files.py), and the kernel writes the folder contract (contract.py)."""

import json
import os

import pytest

from knuth import contract, files
from knuth.limits import MAX_DOCUMENT_BYTES


def test_open_reads_a_document_and_reports_its_mtime(tmp_path):
    path = tmp_path / "analysis.py"
    path.write_text("# %%\nx = 1\n", encoding="utf-8")
    reply = files.open_document(str(path))
    assert reply["text"] == "# %%\nx = 1\n"
    assert reply["name"] == "analysis.py"
    assert reply["path"] == str(path)
    assert reply["modified"] == int(path.stat().st_mtime * 1000)
    assert "unsaved" not in reply


def test_open_refuses_relative_paths_and_non_files(tmp_path):
    assert "absolute" in files.open_document("analysis.py")["error"]
    assert "does not exist" in files.open_document(str(tmp_path / "nope.py"))["error"]
    assert "not a file" in files.open_document(str(tmp_path))["error"]
    assert files.open_document("")["error"]
    assert files.open_document(None)["error"]
    assert "NUL" in files.open_document("/tmp/a\0b")["error"]


def test_open_refuses_binary_and_oversized_files(tmp_path):
    binary = tmp_path / "blob.py"
    binary.write_bytes(b"\xff\xfe\x00 not text")
    assert "UTF-8" in files.open_document(str(binary))["error"]
    huge = tmp_path / "huge.py"
    with open(huge, "wb") as handle:
        handle.truncate(MAX_DOCUMENT_BYTES + 1)
    assert "larger than" in files.open_document(str(huge))["error"]


def test_open_converts_a_notebook_into_an_unsaved_sibling(tmp_path):
    notebook = tmp_path / "nb.ipynb"
    notebook.write_text(json.dumps({
        "nbformat": 4,
        "cells": [{"cell_type": "code", "source": ["x = 1\n"]}],
    }))
    reply = files.open_document(str(notebook))
    assert reply["unsaved"] is True
    assert reply["path"] == str(tmp_path / "nb.py")
    assert reply["name"] == "nb.py"
    assert "x = 1" in reply["text"]
    assert reply["modified"] is None
    assert notebook.exists()  # never touched
    assert not (tmp_path / "nb.py").exists()  # never written by open


def test_open_names_a_broken_notebook(tmp_path):
    notebook = tmp_path / "nb.ipynb"
    notebook.write_text("{not json")
    assert "not a notebook" in files.open_document(str(notebook))["error"]


def test_save_writes_atomically_and_creates(tmp_path):
    path = tmp_path / "new.py"
    reply = files.save_document(str(path), "# %%\ny = 2\n")
    assert path.read_text(encoding="utf-8") == "# %%\ny = 2\n"
    assert reply["modified"] == int(path.stat().st_mtime * 1000)
    assert list(tmp_path.glob(".new.py.*.tmp")) == []


def test_save_keeps_crlf_bytes_as_given(tmp_path):
    """The page owns line endings; the engine writes what it is handed."""
    path = tmp_path / "crlf.py"
    files.save_document(str(path), "# %%\r\nx = 1\r\n")
    assert path.read_bytes() == b"# %%\r\nx = 1\r\n"


def test_save_refuses_bad_input(tmp_path):
    assert "absolute" in files.save_document("x.py", "")["error"]
    assert "string" in files.save_document(str(tmp_path / "x.py"), 3)["error"]
    assert "not a file" in files.save_document(str(tmp_path), "")["error"]


def test_stat_reports_mtime_or_none(tmp_path):
    path = tmp_path / "a.py"
    assert files.stat_document(str(path)) == {"path": str(path), "modified": None}
    path.write_text("x")
    assert files.stat_document(str(path))["modified"] == int(path.stat().st_mtime * 1000)
    assert "absolute" in files.stat_document("a.py")["error"]


def test_rename_stays_in_the_folder(tmp_path):
    path = tmp_path / "old.py"
    path.write_text("x")
    reply = files.rename_document(str(path), "new.py")
    assert reply["path"] == str(tmp_path / "new.py") and reply["name"] == "new.py"
    assert (tmp_path / "new.py").read_text() == "x" and not path.exists()
    (tmp_path / "taken.py").write_text("y")
    assert "already exists" in files.rename_document(str(tmp_path / "new.py"), "taken.py")["error"]
    assert "file name" in files.rename_document(str(tmp_path / "new.py"), "../x.py")["error"]
    assert "file name" in files.rename_document(str(tmp_path / "new.py"), "sub/x.py")["error"]
    assert "does not exist" in files.rename_document(str(tmp_path / "gone.py"), "z.py")["error"]
    assert files.rename_document(str(tmp_path / "new.py"), "  ")["error"]


def test_write_contract_is_shared_and_owns_only_what_it_wrote(tmp_path):
    (tmp_path / "figs").mkdir()
    (tmp_path / "figs" / "theirs.svg").write_text("<svg/>")
    contract.write_contract(tmp_path, {"a": 1}, {"mine": "<svg>1</svg>"})
    assert json.loads((tmp_path / "values.json").read_text()) == {"a": 1}
    assert (tmp_path / "figs" / "mine.svg").read_text() == "<svg>1</svg>"

    contract.write_contract(tmp_path, {}, {"other": "<svg>2</svg>"})
    assert not (tmp_path / "figs" / "mine.svg").exists()  # ours, now stale
    assert (tmp_path / "figs" / "theirs.svg").exists()  # never ours
    assert (tmp_path / "figs" / "other.svg").exists()
    assert list(tmp_path.glob(".*.tmp")) == []


def test_write_contract_extra_files_land_in_the_same_generation(tmp_path):
    document = tmp_path / "paper.py"
    contract.write_contract(tmp_path, {}, {}, extra=[(document, "# %%\n")])
    assert document.read_text() == "# %%\n"


def test_write_contract_refuses_unsafe_figure_names(tmp_path):
    with pytest.raises(ValueError):
        contract.write_contract(tmp_path, {}, {"../escape": "<svg/>"})
    assert not (tmp_path / "values.json").exists()
    assert list(tmp_path.glob(".*.tmp")) == []
