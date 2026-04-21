# bsky-ingester

Raw firehose ingester for Bluesky. Connects to [Jetstream](https://docs.bsky.app/blog/jetstream), enriches every post into a flat JSON object, and writes hourly zstd-compressed JSONL files to disk. No filtering, no database — just reliable, resumable capture of the full post stream.

## Setup

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
```

## Run

```bash
python -m ingester
```

The ingester connects to Jetstream, resumes from the last saved cursor if one exists, and writes to `data/raw/YYYY/MM/DD/HH.jsonl.zst`. It auto-reconnects on failure.

Press `Ctrl+C` to stop gracefully.

## Check it's working

```bash
python scripts/tail.py
```

Finds the most recent compressed file and prints a random sample of 20 events.

## Install as a systemd user service

```bash
# Edit the service file if your project path differs from ~/Developer/feed
mkdir -p ~/.config/systemd/user
cp systemd/bsky-ingester.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now bsky-ingester
```

Check status:

```bash
systemctl --user status bsky-ingester
journalctl --user -u bsky-ingester -f
```

## Storage

Compressed output is roughly **500 MB/day** (~3 GB/day uncompressed). Plan storage accordingly — a month of data is ~15 GB compressed.

## Tests

```bash
pytest
```

## What's next

This ingester captures raw data. A separate filtering pipeline will read these files and apply topic/keyword/AI scoring to curate a personalized feed.
