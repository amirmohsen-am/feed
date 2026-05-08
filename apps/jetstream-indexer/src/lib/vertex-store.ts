import { v1 } from '@google-cloud/aiplatform'
import type { Config } from '../config.js'

const { IndexServiceClient, MatchServiceClient } = v1

export type Point = {
  id: string
  vector: number[]
  payload: {
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
    lang: string | null
  }
}

const indexResource = (cfg: Config): string =>
  `projects/${cfg.gcpProject}/locations/${cfg.gcpLocation}/indexes/${cfg.vertexIndexId}`

const endpointResource = (cfg: Config): string =>
  `projects/${cfg.gcpProject}/locations/${cfg.gcpLocation}/indexEndpoints/${cfg.vertexIndexEndpointId}`

const boolToken = (b: boolean): string => (b ? 'true' : 'false')

// Bluesky's text cap is 300 graphemes / 3000 bytes. We truncate to 9KB as a
// guardrail — Vertex's per-datapoint restrict size cap is ~10KB total and we
// want headroom for our other namespaces.
const MAX_TEXT_BYTES = 9000
const truncateUtf8 = (s: string, maxBytes: number): string => {
  const buf = Buffer.from(s, 'utf8')
  if (buf.byteLength <= maxBytes) return s
  return new TextDecoder('utf-8').decode(buf.subarray(0, maxBytes))
}

const buildDatapointRestricts = (p: Point): {
  restricts: Array<{ namespace: string; allowList: string[] }>
  numericRestricts: Array<{ namespace: string; valueInt: string }>
} => {
  // Vertex datapoints carry no arbitrary metadata, only restricts and numeric
  // restricts — both filterable AND round-tripped through findNeighbors.
  // We exploit that round-trip to ship 'uri' and 'text' alongside the vector
  // so search results carry the full post payload without a separate KV lookup.
  const restricts: Array<{ namespace: string; allowList: string[] }> = [
    { namespace: 'id', allowList: [p.id] },
    { namespace: 'uri', allowList: [p.payload.uri] },
    { namespace: 'text', allowList: [truncateUtf8(p.payload.text, MAX_TEXT_BYTES)] },
    { namespace: 'did', allowList: [p.payload.did] },
    { namespace: 'has_images', allowList: [boolToken(p.payload.has_images)] },
    { namespace: 'has_video', allowList: [boolToken(p.payload.has_video)] },
    { namespace: 'has_quote', allowList: [boolToken(p.payload.has_quote)] },
    { namespace: 'has_external_link', allowList: [boolToken(p.payload.has_external_link)] },
  ]
  if (p.payload.lang) restricts.push({ namespace: 'lang', allowList: [p.payload.lang] })
  if (p.payload.domains.length) restricts.push({ namespace: 'domain', allowList: p.payload.domains })

  // valueInt is int64 — proto JSON expects string for large values.
  const numericRestricts = [
    { namespace: 'created_at_us', valueInt: String(p.payload.created_at_us) },
  ]
  return { restricts, numericRestricts }
}

const chunked = <T>(arr: T[], n: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

const parseMissingIds = (msg: string): Set<string> => {
  // Vertex error detail shape: "<uuid>,<uuid>,...,<uuid> entity does not exist in the dataset"
  const head = msg.split(' entity does not exist')[0] ?? ''
  return new Set(head.split(',').map((s) => s.trim()).filter(Boolean))
}

export class VertexStore {
  private cfg: Config
  private indexClient: InstanceType<typeof IndexServiceClient>
  private matchClient: InstanceType<typeof MatchServiceClient>

  constructor(cfg: Config) {
    if (!cfg.vertexIndexId) throw new Error('VERTEX_INDEX_ID is not set')
    if (!cfg.vertexIndexEndpointId) throw new Error('VERTEX_INDEX_ENDPOINT_ID is not set')
    if (!cfg.vertexIndexEndpointHost) throw new Error('VERTEX_INDEX_ENDPOINT_HOST is not set')
    if (!cfg.vertexDeployedIndexId) throw new Error('VERTEX_DEPLOYED_INDEX_ID is not set')

    this.cfg = cfg
    this.indexClient = new IndexServiceClient({
      apiEndpoint: `${cfg.gcpLocation}-aiplatform.googleapis.com`,
    })
    this.matchClient = new MatchServiceClient({
      apiEndpoint: cfg.vertexIndexEndpointHost,
    })
  }

  async ensureCollection(): Promise<void> {
    // Index/endpoint/deployed-index are provisioned out-of-band by setup-vertex.sh.
    // Just verify the index exists.
    await this.indexClient.getIndex({ name: indexResource(this.cfg) })
  }

  async hasMany(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set()
    const out = new Set<string>()
    for (const batch of chunked(ids, 100)) {
      try {
        const [resp] = await this.matchClient.readIndexDatapoints({
          indexEndpoint: endpointResource(this.cfg),
          deployedIndexId: this.cfg.vertexDeployedIndexId,
          ids: batch,
        })
        for (const dp of resp.datapoints ?? []) {
          if (dp.datapointId) out.add(dp.datapointId)
        }
      } catch (err: any) {
        // Vertex throws NOT_FOUND (gRPC code 5) when *any* of the requested IDs
        // don't exist — it doesn't quietly return the present subset. The error
        // details enumerate the missing IDs as a comma-separated list.
        if (err?.code !== 5) throw err
        const missing = parseMissingIds(err.details ?? err.message ?? '')
        for (const id of batch) if (!missing.has(id)) out.add(id)
      }
    }
    return out
  }

  async upsert(points: Point[]): Promise<void> {
    if (points.length === 0) return
    for (const batch of chunked(points, 100)) {
      const datapoints = batch.map((p) => {
        const { restricts, numericRestricts } = buildDatapointRestricts(p)
        return {
          datapointId: p.id,
          featureVector: p.vector,
          restricts,
          numericRestricts,
        }
      })
      await this.indexClient.upsertDatapoints({
        index: indexResource(this.cfg),
        datapoints,
      })
    }
  }
}
