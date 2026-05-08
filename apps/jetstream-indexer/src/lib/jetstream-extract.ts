// Pure derivation: Jetstream commit-create event -> our PostRecord, or null
// to skip. No I/O, no SDK dependencies — just shape transformation.

import type { PostRecord } from './storage.js'

type FeedPostRecord = {
  text?: string
  createdAt?: string
  langs?: string[]
  reply?: unknown
  embed?: { $type?: string; external?: { uri?: string }; media?: { $type?: string } }
  facets?: Array<{ features?: Array<{ $type?: string; uri?: string }> }>
}

export type JetstreamCreateEvent = {
  did: string
  time_us: number
  commit: {
    operation: string
    collection: string
    rkey: string
    record?: FeedPostRecord
  }
}

const safeHostname = (raw: string): string | null => {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

export const extractDomains = (record: FeedPostRecord): string[] => {
  const out = new Set<string>()
  for (const f of record.facets ?? []) {
    for (const feat of f.features ?? []) {
      if (feat?.$type === 'app.bsky.richtext.facet#link' && feat.uri) {
        const h = safeHostname(feat.uri)
        if (h) out.add(h)
      }
    }
  }
  const externalUri = record.embed?.external?.uri
  if (externalUri) {
    const h = safeHostname(externalUri)
    if (h) out.add(h)
  }
  return [...out]
}

export const extractMediaFlags = (record: FeedPostRecord) => {
  const t = record.embed?.$type
  let has_images = false
  let has_video = false
  let has_quote = false
  let has_external_link = false

  if (t === 'app.bsky.embed.images') has_images = true
  else if (t === 'app.bsky.embed.video') has_video = true
  else if (t === 'app.bsky.embed.external') has_external_link = true
  else if (t === 'app.bsky.embed.record') has_quote = true
  else if (t === 'app.bsky.embed.recordWithMedia') {
    has_quote = true
    const mt = record.embed?.media?.$type
    if (mt === 'app.bsky.embed.images') has_images = true
    else if (mt === 'app.bsky.embed.video') has_video = true
    else if (mt === 'app.bsky.embed.external') has_external_link = true
  }
  return { has_images, has_video, has_quote, has_external_link }
}

export const extractPost = (event: JetstreamCreateEvent): PostRecord | null => {
  const c = event.commit
  if (c.operation !== 'create') return null
  if (c.collection !== 'app.bsky.feed.post') return null
  const r = c.record
  if (!r) return null
  if (r.reply) return null
  const text = (r.text ?? '').trim()
  if (!text) return null

  const createdAtIso = r.createdAt ?? new Date(event.time_us / 1000).toISOString()
  const created_at_us = (() => {
    const parsed = Date.parse(createdAtIso)
    if (!Number.isFinite(parsed)) return event.time_us
    return parsed * 1000
  })()

  const flags = extractMediaFlags(r)
  const domains = extractDomains(r)

  return {
    uri: `at://${event.did}/${c.collection}/${c.rkey}`,
    did: event.did,
    text,
    created_at: createdAtIso,
    created_at_us,
    has_images: flags.has_images,
    has_video: flags.has_video,
    has_quote: flags.has_quote,
    has_external_link: flags.has_external_link,
    domains,
    reply_to: null,
    lang: r.langs?.[0] ?? null,
  }
}
