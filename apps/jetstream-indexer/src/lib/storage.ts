import { Storage } from '@google-cloud/storage'
import { parquetWriteBuffer } from 'hyparquet-writer'
import type { Config } from '../config.js'

export type PostRecord = {
  uri: string
  did: string
  text: string
  created_at: string
  created_at_us: number
  has_images: boolean
  has_video: boolean
  has_quote: boolean
  has_external_link: boolean
  domains: string[]
  reply_to: string | null
  lang: string | null
}

export type EmbeddingRecord = {
  uri: string
  embedding: number[]
}

const today = (): string => new Date().toISOString().slice(0, 10)

let _storage: Storage | null = null
const getStorage = (cfg: Config): Storage => {
  if (_storage) return _storage
  _storage = new Storage({ projectId: cfg.gcpProject })
  return _storage
}

const packFloat32 = (vec: number[]): Buffer => {
  const arr = new Float32Array(vec)
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)
}

const postsPrefix = (dt = today()): string => `posts/dt=${dt}/`
const embeddingsPrefix = (cfg: Config, dt = today()): string =>
  `embeddings/model=${cfg.embedModel}/task=retrieval-document/dim=${cfg.embedDim}/dt=${dt}/`

const joinDomains = (d: string[]): string => d.join(',')

export const writePosts = async (cfg: Config, posts: PostRecord[], batchTag = 'batch'): Promise<string> => {
  const buf = parquetWriteBuffer({
    columnData: [
      { name: 'uri', data: posts.map((p) => p.uri), type: 'STRING' },
      { name: 'did', data: posts.map((p) => p.did), type: 'STRING' },
      { name: 'text', data: posts.map((p) => p.text), type: 'STRING' },
      { name: 'created_at', data: posts.map((p) => p.created_at), type: 'STRING' },
      { name: 'created_at_us', data: posts.map((p) => BigInt(p.created_at_us)), type: 'INT64' },
      { name: 'has_images', data: posts.map((p) => p.has_images), type: 'BOOLEAN' },
      { name: 'has_video', data: posts.map((p) => p.has_video), type: 'BOOLEAN' },
      { name: 'has_quote', data: posts.map((p) => p.has_quote), type: 'BOOLEAN' },
      { name: 'has_external_link', data: posts.map((p) => p.has_external_link), type: 'BOOLEAN' },
      { name: 'domains', data: posts.map((p) => joinDomains(p.domains)), type: 'STRING' },
      { name: 'reply_to', data: posts.map((p) => p.reply_to ?? ''), type: 'STRING' },
      { name: 'lang', data: posts.map((p) => p.lang ?? ''), type: 'STRING' },
    ],
  })
  const key = `${postsPrefix()}posts-${batchTag}-${Date.now()}.parquet`
  await getStorage(cfg)
    .bucket(cfg.gcsBucket)
    .file(key)
    .save(Buffer.from(buf), { contentType: 'application/octet-stream' })
  return `gs://${cfg.gcsBucket}/${key}`
}

export const writeEmbeddings = async (
  cfg: Config,
  embeddings: EmbeddingRecord[],
  batchTag = 'batch',
): Promise<string> => {
  const buf = parquetWriteBuffer({
    columnData: [
      { name: 'uri', data: embeddings.map((e) => e.uri), type: 'STRING' },
      {
        name: 'embedding',
        data: embeddings.map((e) => packFloat32(e.embedding)),
        type: 'BYTE_ARRAY',
      },
    ],
  })
  const key = `${embeddingsPrefix(cfg)}embeddings-${batchTag}-${Date.now()}.parquet`
  await getStorage(cfg)
    .bucket(cfg.gcsBucket)
    .file(key)
    .save(Buffer.from(buf), { contentType: 'application/octet-stream' })
  return `gs://${cfg.gcsBucket}/${key}`
}
