import { GoogleGenAI } from '@google/genai'
import type { Config } from '../config.js'

export type EmbedTaskType = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY' | 'SEMANTIC_SIMILARITY'

let _client: GoogleGenAI | null = null
const getClient = (cfg: Config): GoogleGenAI => {
  if (_client) return _client
  _client = new GoogleGenAI({
    vertexai: true,
    project: cfg.gcpProject,
    location: cfg.gcpLocation,
  })
  return _client
}

export const embedTexts = async (
  cfg: Config,
  texts: string[],
  taskType: EmbedTaskType,
): Promise<number[][]> => {
  if (texts.length === 0) return []
  const client = getClient(cfg)
  const result = await client.models.embedContent({
    model: cfg.embedModel,
    contents: texts,
    config: {
      taskType,
      outputDimensionality: cfg.embedDim,
    },
  })
  const embeddings = result.embeddings ?? []
  if (embeddings.length !== texts.length) {
    throw new Error(`embedding count mismatch: got ${embeddings.length}, expected ${texts.length}`)
  }
  return embeddings.map((e) => {
    if (!e.values) throw new Error('embedding missing values')
    return e.values
  })
}
