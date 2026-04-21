"""Streaming reader for zstd-compressed JSONL files."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterator

import zstandard as zstd


def read_jsonl_zst(path: str | Path) -> Iterator[dict[str, Any]]:
    """Yield decoded JSON objects from a .jsonl.zst file without loading
    the whole thing into memory. Handles chunk boundaries falling mid-line."""
    dctx = zstd.ZstdDecompressor()
    buf = ""
    with open(path, "rb") as fh:
        reader = dctx.stream_reader(fh)
        while True:
            chunk = reader.read(65536)
            if not chunk:
                break
            buf += chunk.decode()
            while "\n" in buf:
                line, buf = buf.split("\n", 1)
                line = line.strip()
                if line:
                    yield json.loads(line)
    # Handle trailing content without a final newline
    buf = buf.strip()
    if buf:
        yield json.loads(buf)
