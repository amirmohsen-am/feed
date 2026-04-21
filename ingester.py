"""Bluesky firehose ingester — connects to Jetstream, enriches post events,
and writes them as compressed JSONL partitioned by hour."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import websockets
import zstandard as zstd

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

JETSTREAM_URL = "wss://jetstream2.us-east.bsky.network/subscribe"
WANTED_COLLECTIONS = "app.bsky.feed.post"
DATA_DIR = Path("data")
RAW_DIR = DATA_DIR / "raw"
CURSOR_PATH = DATA_DIR / "cursor.txt"
CURSOR_TMP = DATA_DIR / "cursor.tmp"
FLUSH_EVERY = 1000
ZSTD_LEVEL = 3
RECONNECT_DELAY = 5

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

log = logging.getLogger("ingester")


def setup_logging() -> None:
    """Configure logging to stdout and data/ingester.log."""
    log.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s")

    stdout = logging.StreamHandler()
    stdout.setFormatter(fmt)
    log.addHandler(stdout)

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    fh = logging.FileHandler(DATA_DIR / "ingester.log")
    fh.setFormatter(fmt)
    log.addHandler(fh)


# ---------------------------------------------------------------------------
# Cursor
# ---------------------------------------------------------------------------


def load_cursor() -> int | None:
    """Read cursor (time_us) from disk, or None if not present."""
    try:
        return int(CURSOR_PATH.read_text().strip())
    except (FileNotFoundError, ValueError):
        return None


def save_cursor(time_us: int) -> None:
    """Atomically persist cursor to disk."""
    CURSOR_TMP.write_text(str(time_us))
    os.replace(CURSOR_TMP, CURSOR_PATH)


# ---------------------------------------------------------------------------
# Enrichment
# ---------------------------------------------------------------------------


def enrich(event: dict[str, Any]) -> dict[str, Any]:
    """Flatten a Jetstream commit event into a uniform dict for storage."""
    commit = event.get("commit") or {}
    record = commit.get("record") or {}
    embed = record.get("embed") or {}
    embed_type = embed.get("$type", "")
    reply = record.get("reply") or {}

    text: str = record.get("text") or ""

    # Images
    has_images = False
    image_count = 0
    if embed_type == "app.bsky.embed.images":
        has_images = True
        image_count = len(embed.get("images") or [])
    elif embed_type == "app.bsky.embed.recordWithMedia":
        media = (embed.get("media") or {})
        if media.get("$type") == "app.bsky.embed.images":
            has_images = True
            image_count = len(media.get("images") or [])

    # Quote
    quote_uri: str | None = None
    if embed_type == "app.bsky.embed.record":
        quote_uri = (embed.get("record") or {}).get("uri")
    elif embed_type == "app.bsky.embed.recordWithMedia":
        quote_uri = ((embed.get("record") or {}).get("record") or {}).get("uri")

    # External link
    has_external_link = embed_type == "app.bsky.embed.external"
    external_domain: str | None = None
    if has_external_link:
        ext_uri = (embed.get("external") or {}).get("uri") or ""
        if ext_uri:
            try:
                external_domain = urlparse(ext_uri).netloc or None
            except Exception:
                external_domain = None

    # Reply
    reply_root: str | None = None
    reply_parent: str | None = None
    root = reply.get("root")
    parent = reply.get("parent")
    if isinstance(root, dict):
        reply_root = root.get("uri")
    if isinstance(parent, dict):
        reply_parent = parent.get("uri")

    return {
        "did": event.get("did") or "",
        "rkey": commit.get("rkey") or "",
        "cid": commit.get("cid") or "",
        "time_us": event.get("time_us") or 0,
        "created_at": record.get("createdAt") or "",
        "collection": commit.get("collection") or "",
        "operation": commit.get("operation") or "",
        "text": text,
        "langs": record.get("langs") or [],
        "reply_root": reply_root,
        "reply_parent": reply_parent,
        "quote_uri": quote_uri,
        "has_images": has_images,
        "image_count": image_count,
        "has_external_link": has_external_link,
        "external_domain": external_domain,
        "text_length": len(text),
        "raw": event,
    }


# ---------------------------------------------------------------------------
# Rotating writer
# ---------------------------------------------------------------------------


class RotatingWriter:
    """Writes enriched events to hourly zstd-compressed JSONL files."""

    def __init__(self, base_dir: Path = RAW_DIR, level: int = ZSTD_LEVEL) -> None:
        self.base_dir = base_dir
        self.level = level
        self._current_key: str | None = None
        self._fh: Any = None
        self._compressor: Any = None
        self._count = 0

    @staticmethod
    def _hour_key(time_us: int) -> str:
        """Return 'YYYY/MM/DD/HH' from a microsecond timestamp."""
        dt = datetime.fromtimestamp(time_us / 1_000_000, tz=timezone.utc)
        return dt.strftime("%Y/%m/%d/%H")

    def _open(self, key: str) -> None:
        """Open a new compressed file for the given hour key."""
        self._close()
        path = self.base_dir / key
        path.parent.mkdir(parents=True, exist_ok=True)
        out_path = Path(str(path) + ".jsonl.zst")
        # Append mode so we don't clobber data on restart within the same hour
        self._fh = open(out_path, "ab")
        cctx = zstd.ZstdCompressor(level=self.level)
        self._compressor = cctx.stream_writer(self._fh, closefd=False)
        self._current_key = key
        self._count = 0
        log.info("Opened %s", out_path)

    def _close(self) -> None:
        """Close the current file if open."""
        if self._compressor is not None:
            self._compressor.close()
            self._compressor = None
        if self._fh is not None:
            self._fh.close()
            self._fh = None
        self._current_key = None

    def write(self, obj: dict[str, Any]) -> None:
        """Write one enriched event. Rotates file on hour boundary."""
        key = self._hour_key(obj.get("time_us") or 0)
        if key != self._current_key:
            self._open(key)

        line = json.dumps(obj, separators=(",", ":")) + "\n"
        self._compressor.write(line.encode())
        self._count += 1

    def maybe_flush(self) -> bool:
        """Flush if we've accumulated FLUSH_EVERY events. Returns True if flushed."""
        if self._count >= FLUSH_EVERY and self._compressor is not None:
            self._compressor.flush(zstd.FLUSH_FRAME)
            self._fh.flush()
            self._count = 0
            return True
        return False

    def close(self) -> None:
        """Clean shutdown."""
        self._close()


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------


async def run() -> None:
    """Connect to Jetstream, process events, write to disk."""
    cursor = load_cursor()
    url = f"{JETSTREAM_URL}?wantedCollections={WANTED_COLLECTIONS}"
    if cursor is not None:
        url += f"&cursor={cursor}"
        log.info("Resuming from cursor %d", cursor)
    else:
        log.info("No cursor found, starting from live tail")

    writer = RotatingWriter()
    latest_time_us = cursor or 0
    total = 0

    try:
        async with websockets.connect(url, max_size=None) as ws:
            log.info("Connected to %s", url)
            async for raw_msg in ws:
                event = json.loads(raw_msg)

                if event.get("kind") != "commit":
                    continue
                commit = event.get("commit") or {}
                if commit.get("operation") != "create":
                    continue

                enriched = enrich(event)
                writer.write(enriched)
                total += 1

                time_us = enriched["time_us"]
                if time_us > latest_time_us:
                    latest_time_us = time_us

                if writer.maybe_flush():
                    save_cursor(latest_time_us)
                    log.info("Flushed — %d events total, cursor=%d", total, latest_time_us)
    finally:
        writer.close()
        if latest_time_us:
            save_cursor(latest_time_us)
            log.info("Saved final cursor %d", latest_time_us)


def main() -> None:
    """Entry point with reconnect loop."""
    setup_logging()
    log.info("Ingester starting")

    while True:
        try:
            asyncio.run(run())
        except KeyboardInterrupt:
            log.info("Shutting down")
            break
        except Exception:
            log.exception("Disconnected, reconnecting in %ds", RECONNECT_DELAY)
            try:
                asyncio.get_event_loop().run_until_complete(
                    asyncio.sleep(RECONNECT_DELAY)
                )
            except Exception:
                import time
                time.sleep(RECONNECT_DELAY)


if __name__ == "__main__":
    main()
