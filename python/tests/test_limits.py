"""Focused tests for kernel-side output bounding helpers."""

import pytest

import knuth.kernel as kernel


def test_stream_output_is_chunked_and_stopped(monkeypatch):
    monkeypatch.setattr(kernel, "MAX_STREAM_BYTES_PER_RUN", 8)
    monkeypatch.setattr(kernel, "MAX_STREAM_EVENT_CHARS", 3)
    events = []
    state = {"id": 7, "stream_bytes": 0}
    stream = kernel._StreamOut(events.append, state, "stdout")

    with pytest.raises(kernel.OutputLimitExceeded):
        stream.write("abcdefghi")

    assert "".join(event["text"] for event in events) == "abcdefgh"
    assert all(len(event["text"]) <= 3 for event in events)
    assert state["stream_bytes"] == 8


def test_utf8_truncation_never_splits_a_character():
    text, truncated = kernel._truncate_utf8("a\N{LOCK}b", 4)
    assert truncated is True
    assert text == "a"
    assert len(text.encode("utf-8")) <= 4

