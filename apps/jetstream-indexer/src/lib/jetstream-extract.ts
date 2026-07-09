// Pure derivation: Jetstream commit events -> typed records, or null to skip.
// No I/O, no SDK dependencies — just shape transformation.

// ----- Jetstream event types -----

export type JetstreamCommitEvent = {
  did: string
  time_us: number
  kind: 'commit'
  commit: {
    operation: 'create' | 'update' | 'delete'
    collection: string
    rkey: string
    cid?: string
    rev?: string
    record?: unknown
  }
}

export type JetstreamIdentityEvent = {
  did: string
  time_us: number
  kind: 'identity'
  identity: { did: string; handle?: string; seq?: number; time?: string }
}

export type JetstreamAccountEvent = {
  did: string
  time_us: number
  kind: 'account'
  account: { did: string; active: boolean; status?: string }
}

export type JetstreamEvent =
  | JetstreamCommitEvent
  | JetstreamIdentityEvent
  | JetstreamAccountEvent

// ----- AT Proto record shapes (lexicon-typed, optional fields permissive) -----

type StrongRef = { uri: string; cid: string }
type BlobRef = { $type?: string; ref?: { $link?: string }; mimeType?: string; size?: number }

type FacetFeature =
  | { $type: 'app.bsky.richtext.facet#mention'; did: string }
  | { $type: 'app.bsky.richtext.facet#link'; uri: string }
  | { $type: 'app.bsky.richtext.facet#tag'; tag: string }

type Facet = {
  index?: { byteStart: number; byteEnd: number }
  features?: FacetFeature[]
}

type EmbedImages = {
  $type: 'app.bsky.embed.images'
  images: Array<{ image?: BlobRef; alt?: string; aspectRatio?: { width: number; height: number } }>
}
type EmbedVideo = {
  $type: 'app.bsky.embed.video'
  video?: BlobRef
  alt?: string
  aspectRatio?: { width: number; height: number }
  presentation?: 'default' | 'gif'
  captions?: Array<{ lang: string; file: BlobRef }>
}
type EmbedExternal = {
  $type: 'app.bsky.embed.external'
  external: { uri: string; title?: string; description?: string; thumb?: BlobRef }
}
type EmbedRecord = {
  $type: 'app.bsky.embed.record'
  record: StrongRef
}
type EmbedRecordWithMedia = {
  $type: 'app.bsky.embed.recordWithMedia'
  record: { record: StrongRef }
  media: EmbedImages | EmbedVideo | EmbedExternal
}
type Embed = EmbedImages | EmbedVideo | EmbedExternal | EmbedRecord | EmbedRecordWithMedia

type SelfLabels = {
  $type?: 'com.atproto.label.defs#selfLabels'
  values?: Array<{ val: string }>
}

export type FeedPostRecord = {
  $type?: 'app.bsky.feed.post'
  text?: string
  createdAt?: string
  langs?: string[]
  tags?: string[]
  facets?: Facet[]
  reply?: { root: StrongRef; parent: StrongRef }
  embed?: Embed
  labels?: SelfLabels
}

export type FeedLikeRecord = {
  $type?: 'app.bsky.feed.like'
  subject?: StrongRef
  createdAt?: string
}

export type FeedRepostRecord = {
  $type?: 'app.bsky.feed.repost'
  subject?: StrongRef
  createdAt?: string
}

export type ActorProfileRecord = {
  $type?: 'app.bsky.actor.profile'
  displayName?: string
  description?: string
  avatar?: BlobRef
  banner?: BlobRef
  labels?: SelfLabels
  joinedViaStarterPack?: StrongRef
  pinnedPost?: StrongRef
  createdAt?: string
}

// ----- Extracted record shapes (what we hand to consumers) -----

export type PostRecord = {
  uri: string
  did: string
  rkey: string
  text: string
  created_at: string
  created_at_us: number
  ingested_at_us: number
  langs: string[]

  is_reply: boolean
  reply_parent_uri: string | null
  reply_parent_did: string | null
  reply_root_uri: string | null
  is_self_thread: boolean

  embed_type: string | null
  image_alts: string[]
  image_count: number
  video_alt: string | null
  is_gif: boolean
  external_uri: string | null
  external_title: string | null
  external_desc: string | null
  quote_uri: string | null
  quote_did: string | null

  has_images: boolean
  has_video: boolean
  has_quote: boolean
  has_external_link: boolean

  hashtags: string[]
  mention_dids: string[]
  links: string[]
  domains: string[]
  self_labels: string[]
  raw_facets: Facet[] | null
}

export type LikeRecord = {
  actor_did: string
  rkey: string
  subject_uri: string
  time_us: number
}

export type RepostRecord = LikeRecord

export type ProfileRecord = {
  did: string
  display_name: string | null
  description: string | null
  avatar_cid: string | null
  banner_cid: string | null
  profile_rev: string | null
  time_us: number
}

export type IdentityRecord = {
  did: string
  handle: string | null
  time_us: number
}

// app.bsky.labeler.service is one record per labeler account (rkey always
// 'self'). For directory discovery we only need the DID — profile + like count
// are enriched from the AppView on the read side.
export type LabelerServiceRecord = {
  did: string
  time_us: number
}

// ----- Helpers -----

const safeHostname = (raw: string): string | null => {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

const didFromAtUri = (uri: string): string | null => {
  // at://did:plc:.../app.bsky.feed.post/rkey
  const m = uri.match(/^at:\/\/([^/]+)\//)
  return m?.[1] ?? null
}

const parseCreatedAtUs = (iso: string | undefined, fallback: number): number => {
  if (!iso) return fallback
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms * 1000 : fallback
}

// Postgres rejects NUL (\u0000) in text and jsonb values ("invalid byte
// sequence for encoding \"UTF8\": 0x00"), and one poisoned post fails its
// entire flush batch. Strip NULs from every string in an extracted record.
const stripNul = (s: string): string => (s.includes('\u0000') ? s.replaceAll('\u0000', '') : s)

const deepStripNul = <T>(v: T): T => {
  if (typeof v === 'string') return stripNul(v) as T
  if (Array.isArray(v)) return v.map(deepStripNul) as T
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v)) out[stripNul(k)] = deepStripNul(val)
    return out as T
  }
  return v
}

const dedupCap = (arr: string[], cap: number): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of arr) {
    if (!v) continue
    if (seen.has(v)) continue
    seen.add(v)
    out.push(v)
    if (out.length >= cap) break
  }
  return out
}

// ----- Post extract -----

type EmbedFields = {
  embed_type: string | null
  has_images: boolean
  has_video: boolean
  has_quote: boolean
  has_external_link: boolean
  image_alts: string[]
  image_count: number
  video_alt: string | null
  is_gif: boolean
  external_uri: string | null
  external_title: string | null
  external_desc: string | null
  quote_uri: string | null
  quote_did: string | null
}

const emptyEmbedFields = (): EmbedFields => ({
  embed_type: null,
  has_images: false,
  has_video: false,
  has_quote: false,
  has_external_link: false,
  image_alts: [],
  image_count: 0,
  video_alt: null,
  is_gif: false,
  external_uri: null,
  external_title: null,
  external_desc: null,
  quote_uri: null,
  quote_did: null,
})

const extractEmbedFields = (embed: Embed | undefined): EmbedFields => {
  if (!embed) return emptyEmbedFields()
  const out: EmbedFields = { ...emptyEmbedFields(), embed_type: embed.$type ?? null }

  const applyImages = (e: EmbedImages) => {
    out.has_images = true
    const imgs = e.images ?? []
    out.image_count = imgs.length
    out.image_alts = imgs.map((i) => i.alt ?? '').filter((s) => s.length > 0)
  }
  const applyVideo = (e: EmbedVideo) => {
    out.has_video = true
    out.video_alt = e.alt ?? null
    out.is_gif = e.presentation === 'gif'
  }
  const applyExternal = (e: EmbedExternal) => {
    out.has_external_link = true
    out.external_uri = e.external?.uri ?? null
    out.external_title = e.external?.title ?? null
    out.external_desc = e.external?.description ?? null
  }
  const applyQuote = (uri: string) => {
    out.has_quote = true
    out.quote_uri = uri
    out.quote_did = didFromAtUri(uri)
  }

  if (embed.$type === 'app.bsky.embed.images') applyImages(embed)
  else if (embed.$type === 'app.bsky.embed.video') applyVideo(embed)
  else if (embed.$type === 'app.bsky.embed.external') applyExternal(embed)
  else if (embed.$type === 'app.bsky.embed.record') {
    if (embed.record?.uri) applyQuote(embed.record.uri)
  } else if (embed.$type === 'app.bsky.embed.recordWithMedia') {
    if (embed.record?.record?.uri) applyQuote(embed.record.record.uri)
    if (embed.media?.$type === 'app.bsky.embed.images') applyImages(embed.media)
    else if (embed.media?.$type === 'app.bsky.embed.video') applyVideo(embed.media)
    else if (embed.media?.$type === 'app.bsky.embed.external') applyExternal(embed.media)
  }
  return out
}

const extractFacetFields = (
  facets: Facet[] | undefined,
  recordTags: string[] | undefined,
): {
  hashtags: string[]
  mention_dids: string[]
  links: string[]
  domains: string[]
  raw_facets: Facet[] | null
} => {
  const hashtags: string[] = []
  const mentions: string[] = []
  const links: string[] = []
  const domains: string[] = []

  for (const f of facets ?? []) {
    for (const feat of f.features ?? []) {
      if (feat.$type === 'app.bsky.richtext.facet#mention') mentions.push(feat.did)
      else if (feat.$type === 'app.bsky.richtext.facet#link') {
        links.push(feat.uri)
        const h = safeHostname(feat.uri)
        if (h) domains.push(h)
      } else if (feat.$type === 'app.bsky.richtext.facet#tag') {
        hashtags.push(feat.tag.toLowerCase())
      }
    }
  }
  for (const t of recordTags ?? []) hashtags.push(t.toLowerCase())

  return {
    hashtags: dedupCap(hashtags, 20),
    mention_dids: dedupCap(mentions, 20),
    links: dedupCap(links, 20),
    domains: dedupCap(domains, 20),
    raw_facets: facets && facets.length > 0 ? facets : null,
  }
}

const extractSelfLabels = (labels: SelfLabels | undefined): string[] => {
  if (!labels?.values) return []
  return dedupCap(
    labels.values.map((v) => v.val).filter((v): v is string => typeof v === 'string'),
    10,
  )
}

const isPostCreate = (ev: JetstreamCommitEvent): boolean =>
  ev.commit.operation === 'create' && ev.commit.collection === 'app.bsky.feed.post'

export const extractPost = (ev: JetstreamCommitEvent): PostRecord | null => {
  if (!isPostCreate(ev)) return null
  const r = ev.commit.record as FeedPostRecord | undefined
  if (!r) return null
  const text = (r.text ?? '').trim()
  // Allow text-empty posts only if they have an embed (image-only posts).
  if (!text && !r.embed) return null

  const reply = r.reply
  const reply_parent_uri = reply?.parent?.uri ?? null
  const reply_root_uri = reply?.root?.uri ?? null
  const reply_parent_did = reply_parent_uri ? didFromAtUri(reply_parent_uri) : null
  const is_reply = !!reply_parent_uri
  const is_self_thread = is_reply && reply_parent_did === ev.did

  const embed = extractEmbedFields(r.embed)
  const facets = extractFacetFields(r.facets, r.tags)
  const self_labels = extractSelfLabels(r.labels)

  const created_at = r.createdAt ?? new Date(ev.time_us / 1000).toISOString()
  const created_at_us = parseCreatedAtUs(r.createdAt, ev.time_us)

  return deepStripNul({
    uri: `at://${ev.did}/${ev.commit.collection}/${ev.commit.rkey}`,
    did: ev.did,
    rkey: ev.commit.rkey,
    text,
    created_at,
    created_at_us,
    ingested_at_us: ev.time_us,
    langs: r.langs ?? [],

    is_reply,
    reply_parent_uri,
    reply_parent_did,
    reply_root_uri,
    is_self_thread,

    ...embed,
    ...facets,
    self_labels,
  })
}

// ----- Like / repost extract -----

const extractEngagement = (
  ev: JetstreamCommitEvent,
  expectedCollection: 'app.bsky.feed.like' | 'app.bsky.feed.repost',
): LikeRecord | null => {
  if (ev.commit.operation !== 'create') return null
  if (ev.commit.collection !== expectedCollection) return null
  const r = ev.commit.record as FeedLikeRecord | FeedRepostRecord | undefined
  const uri = r?.subject?.uri
  if (!uri) return null
  return { actor_did: ev.did, rkey: ev.commit.rkey, subject_uri: uri, time_us: ev.time_us }
}

export const extractLike = (ev: JetstreamCommitEvent): LikeRecord | null =>
  extractEngagement(ev, 'app.bsky.feed.like')

export const extractRepost = (ev: JetstreamCommitEvent): RepostRecord | null =>
  extractEngagement(ev, 'app.bsky.feed.repost')

// ----- Profile / identity extract -----

export const extractProfile = (ev: JetstreamCommitEvent): ProfileRecord | null => {
  if (ev.commit.collection !== 'app.bsky.actor.profile') return null
  if (ev.commit.operation === 'delete') return null
  const r = ev.commit.record as ActorProfileRecord | undefined
  if (!r) return null
  return deepStripNul({
    did: ev.did,
    display_name: r.displayName ?? null,
    description: r.description ?? null,
    avatar_cid: r.avatar?.ref?.$link ?? null,
    banner_cid: r.banner?.ref?.$link ?? null,
    profile_rev: ev.commit.rev ?? null,
    time_us: ev.time_us,
  })
}

export const extractLabelerService = (ev: JetstreamCommitEvent): LabelerServiceRecord | null => {
  if (ev.commit.collection !== 'app.bsky.labeler.service') return null
  if (ev.commit.operation === 'delete') return null
  return { did: ev.did, time_us: ev.time_us }
}

export const extractIdentity = (ev: JetstreamIdentityEvent): IdentityRecord => deepStripNul({
  did: ev.did,
  handle: ev.identity.handle ?? null,
  time_us: ev.time_us,
})
