"""Tests for RotatingWriter and cursor persistence."""

import json
import os
from pathlib import Path

from ingester import RotatingWriter, save_cursor, load_cursor, CURSOR_PATH, CURSOR_TMP
from reader import read_jsonl_zst


def test_rotating_writer_single_hour(tmp_path: Path):
    """Write several events in the same hour, verify one file is created and readable."""
    writer = RotatingWriter(base_dir=tmp_path)
    # 2024-01-15 03:xx UTC
    time_us = 1705287600_000_000  # 2024-01-15T03:00:00Z

    for i in range(5):
        writer.write({
            "did": f"did:plc:test{i}",
            "text": f"Post {i}",
            "time_us": time_us + i * 1_000_000,
        })
    writer.close()

    files = list(tmp_path.rglob("*.jsonl.zst"))
    assert len(files) == 1
    assert "2024/01/15/03" in str(files[0])

    events = list(read_jsonl_zst(files[0]))
    assert len(events) == 5
    assert events[0]["did"] == "did:plc:test0"
    assert events[4]["text"] == "Post 4"


def test_rotating_writer_hour_boundary(tmp_path: Path):
    """Write events that cross an hour boundary, verify two files are created."""
    writer = RotatingWriter(base_dir=tmp_path)

    # End of hour: 2024-01-15 03:59:59 UTC
    time_us_h3 = 1705291199_000_000
    # Start of next hour: 2024-01-15 04:00:01 UTC
    time_us_h4 = 1705291201_000_000

    writer.write({"text": "hour 3", "time_us": time_us_h3})
    writer.write({"text": "hour 4", "time_us": time_us_h4})
    writer.close()

    files = sorted(tmp_path.rglob("*.jsonl.zst"))
    assert len(files) == 2

    events_h3 = list(read_jsonl_zst(files[0]))
    events_h4 = list(read_jsonl_zst(files[1]))
    assert len(events_h3) == 1
    assert len(events_h4) == 1
    assert events_h3[0]["text"] == "hour 3"
    assert events_h4[0]["text"] == "hour 4"


def test_cursor_save_load(tmp_path: Path, monkeypatch):
    """Cursor round-trip: save, load, verify atomic replace."""
    cursor_path = tmp_path / "cursor.txt"
    cursor_tmp = tmp_path / "cursor.tmp"

    monkeypatch.setattr("ingester.CURSOR_PATH", cursor_path)
    monkeypatch.setattr("ingester.CURSOR_TMP", cursor_tmp)

    # No file yet
    assert load_cursor() is None

    save_cursor(1700000000000000)
    assert load_cursor() == 1700000000000000

    # Overwrite
    save_cursor(1700000001000000)
    assert load_cursor() == 1700000001000000

    # tmp file should not exist after atomic replace
    assert not cursor_tmp.exists()


def test_cursor_missing_file(tmp_path: Path, monkeypatch):
    """load_cursor() returns None when file doesn't exist."""
    monkeypatch.setattr("ingester.CURSOR_PATH", tmp_path / "nonexistent.txt")
    assert load_cursor() is None


def test_cursor_corrupt_file(tmp_path: Path, monkeypatch):
    """load_cursor() returns None for non-integer content."""
    bad = tmp_path / "cursor.txt"
    bad.write_text("not-a-number\n")
    monkeypatch.setattr("ingester.CURSOR_PATH", bad)
    assert load_cursor() is None
