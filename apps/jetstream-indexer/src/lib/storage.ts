// Parquet archive — our internal replay log. Covers ALL Jetstream collections
// we care about: posts, likes, reposts, profiles, identity. Layout:
//
//   gs://{bucket}/jetstream/{kind}/dt=YYYY-MM-DD/{kind}-{tag}-{ts}.parquet

import { Storage } from '@google-cloud/storage'
import { parquetWriteBuffer } from 'hyparquet-writer'
import type { Config } from '../config.js'
import type {
  IdentityRecord,
  LikeRecord,
  PostRecord,
  ProfileRecord,
  RepostRecord,
} from './jetstream-extract.js'

const today = (): string => new Date().toISOString().slice(0, 10)

let _storage: Storage | null = null
const getStorage = (cfg: Config): Storage => {
  if (_storage) return _storage
  _storage = new Storage({ projectId: cfg.gcpProject })
  return _storage
}

const upload = async (
  cfg: Config,
  key: string,
  buf: Uint8Array | ArrayBuffer,
): Promise<string> => {
  // parquetWriteBuffer returns ArrayBuffer; @google-cloud/storage's .save() wants
  // a Buffer. Buffer.from accepts both ArrayBuffer and Uint8Array.
  const body = buf instanceof ArrayBuffer ? Buffer.from(new Uint8Array(buf)) : Buffer.from(buf)
  await getStorage(cfg)
    .bucket(cfg.gcsBucket)
    .file(key)
    .save(body, { contentType: 'application/octet-stream' })
  return `gs://${cfg.gcsBucket}/${key}`
}

const kindPrefix = (kind: string, dt = today()): string => `jetstream/${kind}/dt=${dt}/`

const objectKey = (kind: string, tag: string): string =>
  `${kindPrefix(kind)}${kind}-${tag}-${Date.now()}.parquet`

const joinList = (xs: string[]): string => xs.join(',')

// ----- Posts -----

export const writePosts = async (
  cfg: Config,
  posts: PostRecord[],
  tag = 'batch',
): Promise<string> => {
  if (posts.length === 0) return ''
  const buf = parquetWriteBuffer({
    columnData: [
      { name: 'uri', data: posts.map((p) => p.uri), type: 'STRING' },
      { name: 'did', data: posts.map((p) => p.did), type: 'STRING' },
      { name: 'rkey', data: posts.map((p) => p.rkey), type: 'STRING' },
      { name: 'text', data: posts.map((p) => p.text), type: 'STRING' },
      { name: 'created_at', data: posts.map((p) => p.created_at), type: 'STRING' },
      { name: 'created_at_us', data: posts.map((p) => BigInt(p.created_at_us)), type: 'INT64' },
      { name: 'ingested_at_us', data: posts.map((p) => BigInt(p.ingested_at_us)), type: 'INT64' },
      { name: 'langs', data: posts.map((p) => joinList(p.langs)), type: 'STRING' },

      { name: 'is_reply', data: posts.map((p) => p.is_reply), type: 'BOOLEAN' },
      { name: 'reply_parent_uri', data: posts.map((p) => p.reply_parent_uri ?? ''), type: 'STRING' },
      { name: 'reply_parent_did', data: posts.map((p) => p.reply_parent_did ?? ''), type: 'STRING' },
      { name: 'reply_root_uri', data: posts.map((p) => p.reply_root_uri ?? ''), type: 'STRING' },
      { name: 'is_self_thread', data: posts.map((p) => p.is_self_thread), type: 'BOOLEAN' },

      { name: 'embed_type', data: posts.map((p) => p.embed_type ?? ''), type: 'STRING' },
      { name: 'image_alts', data: posts.map((p) => joinList(p.image_alts)), type: 'STRING' },
      { name: 'image_count', data: posts.map((p) => p.image_count), type: 'INT32' },
      { name: 'video_alt', data: posts.map((p) => p.video_alt ?? ''), type: 'STRING' },
      { name: 'is_gif', data: posts.map((p) => p.is_gif), type: 'BOOLEAN' },
      { name: 'external_uri', data: posts.map((p) => p.external_uri ?? ''), type: 'STRING' },
      { name: 'external_title', data: posts.map((p) => p.external_title ?? ''), type: 'STRING' },
      { name: 'external_desc', data: posts.map((p) => p.external_desc ?? ''), type: 'STRING' },
      { name: 'quote_uri', data: posts.map((p) => p.quote_uri ?? ''), type: 'STRING' },
      { name: 'quote_did', data: posts.map((p) => p.quote_did ?? ''), type: 'STRING' },

      { name: 'has_images', data: posts.map((p) => p.has_images), type: 'BOOLEAN' },
      { name: 'has_video', data: posts.map((p) => p.has_video), type: 'BOOLEAN' },
      { name: 'has_quote', data: posts.map((p) => p.has_quote), type: 'BOOLEAN' },
      { name: 'has_external_link', data: posts.map((p) => p.has_external_link), type: 'BOOLEAN' },

      { name: 'hashtags', data: posts.map((p) => joinList(p.hashtags)), type: 'STRING' },
      { name: 'mention_dids', data: posts.map((p) => joinList(p.mention_dids)), type: 'STRING' },
      { name: 'links', data: posts.map((p) => joinList(p.links)), type: 'STRING' },
      { name: 'domains', data: posts.map((p) => joinList(p.domains)), type: 'STRING' },
      { name: 'self_labels', data: posts.map((p) => joinList(p.self_labels)), type: 'STRING' },
      {
        name: 'raw_facets_json',
        data: posts.map((p) => (p.raw_facets ? JSON.stringify(p.raw_facets) : '')),
        type: 'STRING',
      },
    ],
  })
  return upload(cfg, objectKey('posts', tag), buf)
}

// ----- Likes / reposts -----

const writeEngagement = async (
  cfg: Config,
  kind: 'likes' | 'reposts',
  rows: LikeRecord[],
  tag: string,
): Promise<string> => {
  if (rows.length === 0) return ''
  const buf = parquetWriteBuffer({
    columnData: [
      { name: 'actor_did', data: rows.map((r) => r.actor_did), type: 'STRING' },
      { name: 'rkey', data: rows.map((r) => r.rkey), type: 'STRING' },
      { name: 'subject_uri', data: rows.map((r) => r.subject_uri), type: 'STRING' },
      { name: 'time_us', data: rows.map((r) => BigInt(r.time_us)), type: 'INT64' },
    ],
  })
  return upload(cfg, objectKey(kind, tag), buf)
}

export const writeLikes = (cfg: Config, rows: LikeRecord[], tag = 'batch') =>
  writeEngagement(cfg, 'likes', rows, tag)

export const writeReposts = (cfg: Config, rows: RepostRecord[], tag = 'batch') =>
  writeEngagement(cfg, 'reposts', rows, tag)

// ----- Profiles / identity -----

export const writeProfiles = async (
  cfg: Config,
  rows: ProfileRecord[],
  tag = 'batch',
): Promise<string> => {
  if (rows.length === 0) return ''
  const buf = parquetWriteBuffer({
    columnData: [
      { name: 'did', data: rows.map((r) => r.did), type: 'STRING' },
      { name: 'display_name', data: rows.map((r) => r.display_name ?? ''), type: 'STRING' },
      { name: 'description', data: rows.map((r) => r.description ?? ''), type: 'STRING' },
      { name: 'avatar_cid', data: rows.map((r) => r.avatar_cid ?? ''), type: 'STRING' },
      { name: 'banner_cid', data: rows.map((r) => r.banner_cid ?? ''), type: 'STRING' },
      { name: 'profile_rev', data: rows.map((r) => r.profile_rev ?? ''), type: 'STRING' },
      { name: 'time_us', data: rows.map((r) => BigInt(r.time_us)), type: 'INT64' },
    ],
  })
  return upload(cfg, objectKey('profiles', tag), buf)
}

export const writeIdentity = async (
  cfg: Config,
  rows: IdentityRecord[],
  tag = 'batch',
): Promise<string> => {
  if (rows.length === 0) return ''
  const buf = parquetWriteBuffer({
    columnData: [
      { name: 'did', data: rows.map((r) => r.did), type: 'STRING' },
      { name: 'handle', data: rows.map((r) => r.handle ?? ''), type: 'STRING' },
      { name: 'time_us', data: rows.map((r) => BigInt(r.time_us)), type: 'INT64' },
    ],
  })
  return upload(cfg, objectKey('identity', tag), buf)
}

