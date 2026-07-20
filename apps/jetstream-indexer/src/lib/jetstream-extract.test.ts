// Run: npm test  (node:test via tsx — no extra deps)
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractPost, type JetstreamCommitEvent } from './jetstream-extract.js'

const postEvent = (record: unknown): JetstreamCommitEvent => ({
  did: 'did:plc:test',
  time_us: 1_700_000_000_000_000,
  kind: 'commit',
  commit: { operation: 'create', collection: 'app.bsky.feed.post', rkey: 'abc123', record },
})

test('extractPost extracts a normal string-text post', () => {
  const r = extractPost(postEvent({ text: 'hello world', createdAt: '2026-07-20T00:00:00.000Z' }))
  assert.equal(r?.text, 'hello world')
})

// Regression: the 2026-07-17 crash loop. Jetstream delivers raw, unvalidated
// user records; a non-string `text` made `.trim()` throw and crash-looped the
// worker. extractPost must never throw on a malformed record — it returns null
// (text-empty with no embed) instead.
test('extractPost does not throw on non-string text', () => {
  for (const bad of [123, { foo: 'bar' }, ['a', 'b'], true, null]) {
    assert.doesNotThrow(() => extractPost(postEvent({ text: bad })))
    assert.equal(extractPost(postEvent({ text: bad })), null, `text=${JSON.stringify(bad)}`)
  }
})

test('extractPost keeps a non-string-text post if it has an embed', () => {
  const r = extractPost(
    postEvent({
      text: 42,
      embed: { $type: 'app.bsky.embed.images', images: [{ image: {}, alt: 'a cat' }] },
    }),
  )
  assert.notEqual(r, null)
  assert.equal(r?.text, '')
})
