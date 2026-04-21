#!/usr/bin/env python3
"""Print a random sample of events from the most recent compressed JSONL file."""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path

# Allow running from project root
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from reader import read_jsonl_zst

RAW_DIR = Path("data/raw")
SAMPLE_SIZE = 20


def find_latest() -> Path | None:
    """Find the most recently modified .jsonl.zst file."""
    files = sorted(RAW_DIR.rglob("*.jsonl.zst"), key=lambda p: p.stat().st_mtime)
    return files[-1] if files else None


def main() -> None:
    path = find_latest()
    if path is None:
        print("No .jsonl.zst files found under data/raw/")
        sys.exit(1)

    print(f"Reading {path}\n")
    events = list(read_jsonl_zst(path))
    print(f"Total events in file: {len(events)}\n")

    sample = random.sample(events, min(SAMPLE_SIZE, len(events)))
    for i, event in enumerate(sample, 1):
        # Print without the bulky raw field
        display = {k: v for k, v in event.items() if k != "raw"}
        print(f"--- [{i}] ---")
        print(json.dumps(display, indent=2, ensure_ascii=False))
        print()


if __name__ == "__main__":
    main()
