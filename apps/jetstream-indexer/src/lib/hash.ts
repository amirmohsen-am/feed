// UUID v5 (deterministic, name-based) for vector point IDs.

const NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8' // RFC 4122 URL namespace; reused as our app namespace

const parseUuid = (uuid: string): Uint8Array => {
  const hex = uuid.replace(/-/g, '')
  const bytes = new Uint8Array(16)
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

const formatUuid = (bytes: Uint8Array): string => {
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const NAMESPACE_BYTES = parseUuid(NAMESPACE)

export const uriToPointId = async (uri: string): Promise<string> => {
  const nameBytes = new TextEncoder().encode(uri)
  const buf = new Uint8Array(NAMESPACE_BYTES.length + nameBytes.length)
  buf.set(NAMESPACE_BYTES, 0)
  buf.set(nameBytes, NAMESPACE_BYTES.length)

  const hash = new Uint8Array(await crypto.subtle.digest('SHA-1', buf)).slice(0, 16)
  hash[6] = (hash[6]! & 0x0f) | 0x50
  hash[8] = (hash[8]! & 0x3f) | 0x80
  return formatUuid(hash)
}
