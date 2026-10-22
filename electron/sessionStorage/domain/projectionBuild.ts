export type ProjectionBuildChunkReceipt = Readonly<{
  sessionId: string
  sessionGeneration: string
  scopeKey: string
  specVersion: number
  sourceIdentityJson: string
  processGeneration: number
  rebuildToken: string
  fromSequence: number
  nextSequence: number
  rowCount: number
  byteLength: number
  payloadDigest: string
  blobLocator: string
}>

export type ProjectionBuildLimits = Readonly<{ maxRows: number; maxBytes: number }>
export type ProjectionBuildOutputManifestRef = Readonly<{ locator: string; byteLength: number; payloadDigest: string }>
export type ProjectionStableIdIndexManifestRef = Readonly<{ locator: string; byteLength: number; payloadDigest: string; itemCount: number; sessionId: string; scopeKey: string; sourceIdentityJson: string }>

/** Stable UTF-8 SHA-256 receipt check shared without exposing runtime filesystem or database details. */
export async function projectionPayloadDigest(payload: string): Promise<string> {
  const bytes = new TextEncoder().encode(payload)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
}

export type ProjectionBuildCheckpoint = Readonly<{
  formatVersion: 1
  sessionId: string
  sessionGeneration: string
  scopeKey: string
  specVersion: number
  sourceIdentityJson: string
  processGeneration: number
  rebuildToken: string
  nextSequence: number
  processedRows: number
  processedBytes: number
  historyReducerStateJson: string | null
  outputManifest: ProjectionBuildOutputManifestRef | null
  stableIdIndexManifest: ProjectionStableIdIndexManifestRef | null
}>

export function createProjectionBuildCheckpoint(input: Omit<ProjectionBuildCheckpoint, 'formatVersion' | 'nextSequence' | 'processedRows' | 'processedBytes' | 'historyReducerStateJson' | 'outputManifest' | 'stableIdIndexManifest'> & { startSequence: number; historyReducerStateJson?: string | null }): ProjectionBuildCheckpoint {
  if (!input.sessionId || !input.sessionGeneration || !input.scopeKey || !input.sourceIdentityJson ||
    !Number.isSafeInteger(input.specVersion) || input.specVersion < 1 ||
    !Number.isSafeInteger(input.processGeneration) || input.processGeneration < 0 ||
    !input.rebuildToken || input.startSequence !== 0) {
    throw new Error('INVALID_PROJECTION_BUILD_CHECKPOINT')
  }
  const { startSequence, ...identity } = input
  return Object.freeze({ formatVersion: 1, ...identity, nextSequence: startSequence, processedRows: 0, processedBytes: 0,
    historyReducerStateJson: input.historyReducerStateJson ?? null, outputManifest: null, stableIdIndexManifest: null })
}

/** Reject malformed or internally inconsistent checkpoint bytes before any resume or takeover. */
export function parseProjectionBuildCheckpoint(json: string): ProjectionBuildCheckpoint | null {
  let value: unknown
  try { value = JSON.parse(json) } catch { return null }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const checkpoint = value as Partial<ProjectionBuildCheckpoint>
  if (checkpoint.formatVersion !== 1 || typeof checkpoint.sessionId !== 'string' || !checkpoint.sessionId ||
    typeof checkpoint.sessionGeneration !== 'string' || !checkpoint.sessionGeneration ||
    typeof checkpoint.scopeKey !== 'string' || !checkpoint.scopeKey ||
    !Number.isSafeInteger(checkpoint.specVersion) || (checkpoint.specVersion ?? 0) < 1 ||
    typeof checkpoint.sourceIdentityJson !== 'string' || !checkpoint.sourceIdentityJson ||
    !Number.isSafeInteger(checkpoint.processGeneration) || (checkpoint.processGeneration ?? -1) < 0 ||
    typeof checkpoint.rebuildToken !== 'string' || !checkpoint.rebuildToken ||
    !Number.isSafeInteger(checkpoint.nextSequence) || (checkpoint.nextSequence ?? -1) < 0 ||
    !Number.isSafeInteger(checkpoint.processedRows) || (checkpoint.processedRows ?? -1) < 0 ||
    !Number.isSafeInteger(checkpoint.processedBytes) || (checkpoint.processedBytes ?? -1) < 0 ||
    !(checkpoint.historyReducerStateJson === null || (typeof checkpoint.historyReducerStateJson === 'string' &&
      checkpoint.historyReducerStateJson.length > 0 && new TextEncoder().encode(checkpoint.historyReducerStateJson).byteLength <= 64 * 1024 && isJson(checkpoint.historyReducerStateJson))) ||
    !(checkpoint.outputManifest === null || (checkpoint.outputManifest && typeof checkpoint.outputManifest === 'object' &&
      typeof checkpoint.outputManifest.locator === 'string' && checkpoint.outputManifest.locator.trim() &&
      Number.isSafeInteger(checkpoint.outputManifest.byteLength) && checkpoint.outputManifest.byteLength > 0 &&
      /^[a-f0-9]{64}$/.test(checkpoint.outputManifest.payloadDigest))) ||
    !(checkpoint.stableIdIndexManifest === null || (checkpoint.stableIdIndexManifest && typeof checkpoint.stableIdIndexManifest === 'object' &&
      typeof checkpoint.stableIdIndexManifest.locator === 'string' && checkpoint.stableIdIndexManifest.locator.trim() &&
      Number.isSafeInteger(checkpoint.stableIdIndexManifest.byteLength) && checkpoint.stableIdIndexManifest.byteLength > 0 &&
      /^[a-f0-9]{64}$/.test(checkpoint.stableIdIndexManifest.payloadDigest) && Number.isSafeInteger(checkpoint.stableIdIndexManifest.itemCount) &&
      checkpoint.stableIdIndexManifest.itemCount >= 0 && checkpoint.stableIdIndexManifest.sessionId === checkpoint.sessionId &&
      checkpoint.stableIdIndexManifest.scopeKey === checkpoint.scopeKey && checkpoint.stableIdIndexManifest.sourceIdentityJson === checkpoint.sourceIdentityJson)) ||
    ((checkpoint.nextSequence === 0) !== (checkpoint.outputManifest === null)) ||
    ((checkpoint.processedRows === 0) !== (checkpoint.nextSequence === 0)) ||
    checkpoint.processedRows !== checkpoint.nextSequence ||
    ((checkpoint.processedBytes === 0) !== (checkpoint.nextSequence === 0))) return null
  return Object.freeze({ ...checkpoint, outputManifest: checkpoint.outputManifest ? Object.freeze({ ...checkpoint.outputManifest }) : null,
    stableIdIndexManifest: checkpoint.stableIdIndexManifest ? Object.freeze({ ...checkpoint.stableIdIndexManifest }) : null }) as ProjectionBuildCheckpoint
}

/** Accept a worker-produced chunk only after its payload has been persisted and its digest verified. */
export function acceptProjectionBuildChunk(
  checkpoint: ProjectionBuildCheckpoint,
  chunk: ProjectionBuildChunkReceipt,
  limits: ProjectionBuildLimits,
  historyReducerStateJson: string = checkpoint.historyReducerStateJson ?? '',
  stableIdIndexManifest: ProjectionStableIdIndexManifestRef | null = checkpoint.stableIdIndexManifest,
  outputBlobByteLength: number = chunk.byteLength
): ProjectionBuildCheckpoint | null {
  if (chunk.sessionId !== checkpoint.sessionId || chunk.sessionGeneration !== checkpoint.sessionGeneration ||
    chunk.scopeKey !== checkpoint.scopeKey || chunk.specVersion !== checkpoint.specVersion ||
    chunk.sourceIdentityJson !== checkpoint.sourceIdentityJson || chunk.processGeneration !== checkpoint.processGeneration ||
    chunk.rebuildToken !== checkpoint.rebuildToken || chunk.fromSequence !== checkpoint.nextSequence ||
    !Number.isSafeInteger(chunk.nextSequence) || chunk.nextSequence <= chunk.fromSequence ||
    !Number.isSafeInteger(chunk.rowCount) || chunk.rowCount < 1 || chunk.rowCount > limits.maxRows || chunk.nextSequence - chunk.fromSequence !== chunk.rowCount ||
    !Number.isSafeInteger(chunk.byteLength) || chunk.byteLength < 1 || chunk.byteLength > limits.maxBytes ||
    !Number.isSafeInteger(limits.maxRows) || limits.maxRows < 1 || !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1 ||
    !/^[a-f0-9]{64}$/.test(chunk.payloadDigest) || !chunk.blobLocator.trim() || !historyReducerStateJson ||
    new TextEncoder().encode(historyReducerStateJson).byteLength > 64 * 1024 || !isJson(historyReducerStateJson) ||
    !Number.isSafeInteger(outputBlobByteLength) || outputBlobByteLength < 1 ||
    (stableIdIndexManifest !== null && (!stableIdIndexManifest.locator.trim() || stableIdIndexManifest.sessionId !== checkpoint.sessionId ||
      stableIdIndexManifest.scopeKey !== checkpoint.scopeKey || stableIdIndexManifest.sourceIdentityJson !== checkpoint.sourceIdentityJson ||
      !Number.isSafeInteger(stableIdIndexManifest.byteLength) ||
      stableIdIndexManifest.byteLength < 1 || !/^[a-f0-9]{64}$/.test(stableIdIndexManifest.payloadDigest) ||
      !Number.isSafeInteger(stableIdIndexManifest.itemCount) || stableIdIndexManifest.itemCount < 0))) return null
  const processedRows = checkpoint.processedRows + chunk.rowCount
  const processedBytes = checkpoint.processedBytes + chunk.byteLength
  if (!Number.isSafeInteger(processedRows) || !Number.isSafeInteger(processedBytes)) return null
  return Object.freeze({ ...checkpoint, nextSequence: chunk.nextSequence, processedRows, processedBytes,
    historyReducerStateJson,
    stableIdIndexManifest: stableIdIndexManifest ? Object.freeze({ ...stableIdIndexManifest }) : null,
    outputManifest: Object.freeze({ locator: chunk.blobLocator, byteLength: outputBlobByteLength, payloadDigest: chunk.payloadDigest }) })
}

/** Transfer a durable checkpoint to a newer process generation without changing its source fence or cursor. */
export function takeoverProjectionBuildCheckpoint(
  checkpoint: ProjectionBuildCheckpoint,
  input: Readonly<{ processGeneration: number; rebuildToken: string; sourceIdentityJson: string }>
): ProjectionBuildCheckpoint | null {
  if (!Number.isSafeInteger(input.processGeneration) || input.processGeneration <= checkpoint.processGeneration ||
    !input.rebuildToken.trim() || input.rebuildToken === checkpoint.rebuildToken ||
    input.sourceIdentityJson !== checkpoint.sourceIdentityJson) return null
  return Object.freeze({ ...checkpoint, processGeneration: input.processGeneration, rebuildToken: input.rebuildToken })
}

/** Record a verified external stable-ID index without retaining its entries in checkpoint JSON. */
export function attachProjectionStableIdIndexManifest(
  checkpoint: ProjectionBuildCheckpoint,
  manifest: ProjectionStableIdIndexManifestRef
): ProjectionBuildCheckpoint | null {
  if (!manifest.locator.trim() || manifest.sessionId !== checkpoint.sessionId || manifest.scopeKey !== checkpoint.scopeKey ||
    manifest.sourceIdentityJson !== checkpoint.sourceIdentityJson || !Number.isSafeInteger(manifest.byteLength) || manifest.byteLength < 1 ||
    !/^[a-f0-9]{64}$/.test(manifest.payloadDigest) || !Number.isSafeInteger(manifest.itemCount) || manifest.itemCount < 0) return null
  return Object.freeze({ ...checkpoint, stableIdIndexManifest: Object.freeze({ ...manifest }) })
}

function isJson(value: string): boolean {
  try { JSON.parse(value); return true } catch { return false }
}
