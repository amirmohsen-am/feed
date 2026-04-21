"""Tests for the enrich() function."""

from ingester import enrich


def _make_event(record: dict, **overrides) -> dict:
    """Build a minimal Jetstream-like event dict."""
    event = {
        "did": "did:plc:abc123",
        "time_us": 1700000000000000,
        "kind": "commit",
        "commit": {
            "rkey": "3k5aaaa",
            "cid": "bafyreiabc",
            "collection": "app.bsky.feed.post",
            "operation": "create",
            "record": record,
        },
    }
    event.update(overrides)
    return event


def test_plain_post():
    record = {
        "text": "Hello world",
        "createdAt": "2024-01-01T00:00:00Z",
        "langs": ["en"],
    }
    out = enrich(_make_event(record))
    assert out["did"] == "did:plc:abc123"
    assert out["rkey"] == "3k5aaaa"
    assert out["cid"] == "bafyreiabc"
    assert out["text"] == "Hello world"
    assert out["text_length"] == 11
    assert out["langs"] == ["en"]
    assert out["reply_root"] is None
    assert out["reply_parent"] is None
    assert out["quote_uri"] is None
    assert out["has_images"] is False
    assert out["image_count"] == 0
    assert out["has_external_link"] is False
    assert out["external_domain"] is None
    assert out["collection"] == "app.bsky.feed.post"
    assert out["operation"] == "create"


def test_reply():
    record = {
        "text": "Replying",
        "createdAt": "2024-01-01T00:00:00Z",
        "reply": {
            "root": {"uri": "at://did:plc:root/app.bsky.feed.post/aaa"},
            "parent": {"uri": "at://did:plc:parent/app.bsky.feed.post/bbb"},
        },
    }
    out = enrich(_make_event(record))
    assert out["reply_root"] == "at://did:plc:root/app.bsky.feed.post/aaa"
    assert out["reply_parent"] == "at://did:plc:parent/app.bsky.feed.post/bbb"


def test_images():
    record = {
        "text": "Look at this",
        "createdAt": "2024-01-01T00:00:00Z",
        "embed": {
            "$type": "app.bsky.embed.images",
            "images": [{"alt": "a"}, {"alt": "b"}, {"alt": "c"}],
        },
    }
    out = enrich(_make_event(record))
    assert out["has_images"] is True
    assert out["image_count"] == 3
    assert out["quote_uri"] is None


def test_quote_post():
    record = {
        "text": "Quoting this",
        "createdAt": "2024-01-01T00:00:00Z",
        "embed": {
            "$type": "app.bsky.embed.record",
            "record": {"uri": "at://did:plc:other/app.bsky.feed.post/xyz"},
        },
    }
    out = enrich(_make_event(record))
    assert out["quote_uri"] == "at://did:plc:other/app.bsky.feed.post/xyz"
    assert out["has_images"] is False


def test_quote_with_media():
    record = {
        "text": "Quote + images",
        "createdAt": "2024-01-01T00:00:00Z",
        "embed": {
            "$type": "app.bsky.embed.recordWithMedia",
            "record": {
                "record": {"uri": "at://did:plc:other/app.bsky.feed.post/xyz"},
            },
            "media": {
                "$type": "app.bsky.embed.images",
                "images": [{"alt": "pic"}],
            },
        },
    }
    out = enrich(_make_event(record))
    assert out["quote_uri"] == "at://did:plc:other/app.bsky.feed.post/xyz"
    assert out["has_images"] is True
    assert out["image_count"] == 1


def test_external_link():
    record = {
        "text": "Check this out",
        "createdAt": "2024-01-01T00:00:00Z",
        "embed": {
            "$type": "app.bsky.embed.external",
            "external": {
                "uri": "https://example.com/article?id=1",
                "title": "Article",
            },
        },
    }
    out = enrich(_make_event(record))
    assert out["has_external_link"] is True
    assert out["external_domain"] == "example.com"


def test_missing_fields():
    """enrich() should handle a near-empty event gracefully."""
    event = {
        "kind": "commit",
        "commit": {"operation": "create"},
    }
    out = enrich(event)
    assert out["did"] == ""
    assert out["text"] == ""
    assert out["text_length"] == 0
    assert out["langs"] == []
    assert out["has_images"] is False
    assert out["reply_root"] is None
    assert out["external_domain"] is None


def test_raw_preserved():
    record = {"text": "test", "createdAt": "2024-01-01T00:00:00Z"}
    event = _make_event(record)
    out = enrich(event)
    assert out["raw"] is event
