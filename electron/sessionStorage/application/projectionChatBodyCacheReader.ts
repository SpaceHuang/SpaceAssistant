import { projectionPayloadDigest } from '../domain/projectionBuild'
import { PROJECTION_SPECS } from '../domain/projectionSpec'
import { projectionScopeKind } from '../domain/scopeKey'

export type ProjectionChatBodyMessage = Readonly<{ id: string; role: 'user' | 'assistant'; content: string; timestamp: number }>
export type ProjectionChatBodyCacheSnapshot = Readonly<{
  sessionId: string
  sessionGeneration: string
  currentSessionGeneration: string
  scopeKey: string
  specVersion: number
  status: 'valid' | 'invalid' | 'rebuilding' | 'rejected'
  cachePresent: boolean
  sourceIdentityJson: string | null
  stateSourceIdentityJson: string | null
  currentSourceIdentityJson: string | null
  payloadGeneration: string | null
  payloadDigest: string | null
  validatedRangeJson: string | null
  statePayloadGeneration: string | null
  statePayloadDigest: string | null
  stateValidatedRangeJson: string | null
  inlinePayload?: string
  blobLocator?: string
  blobByteLength?: number
}>

export type ProjectionChatBodyCacheReadStore = Readonly<{
  /** Reads state, cache manifest, session generation, and recomputed source identity in one DB snapshot. */
  readSnapshot(sessionId: string, scopeKey: string): ProjectionChatBodyCacheSnapshot | null
  /** Invalidates only the exact publication observed by this reader. */
  invalidateObserved(input: Readonly<{
    sessionId: string; scopeKey: string; sessionGeneration: string; cachePresent: boolean; sourceIdentityJson: string | null
    payloadGeneration: string | null; payloadDigest: string | null; validatedRangeJson: string | null
    stateSourceIdentityJson: string; statePayloadGeneration: string; statePayloadDigest: string; stateValidatedRangeJson: string
  }>): boolean
}>
export type ProjectionChatBodyBlobReader = Readonly<{
  readVerified(input: Readonly<{ locator: string; byteLength: number; payloadDigest: string }>): Promise<string>
}>
export type ProjectionChatBodyCacheResult = Readonly<{ kind: 'ready'; messages: readonly ProjectionChatBodyMessage[] }> | Readonly<{ kind: 'miss' }>

function samePublication(left: ProjectionChatBodyCacheSnapshot, right: ProjectionChatBodyCacheSnapshot): boolean {
  return left.sessionId === right.sessionId && left.sessionGeneration === right.sessionGeneration &&
    left.currentSessionGeneration === right.currentSessionGeneration &&
    left.scopeKey === right.scopeKey && left.specVersion === right.specVersion && left.status === 'valid' && right.status === 'valid' &&
    left.sourceIdentityJson === right.sourceIdentityJson && left.currentSourceIdentityJson === right.currentSourceIdentityJson &&
    left.stateSourceIdentityJson === right.stateSourceIdentityJson &&
    left.payloadGeneration === right.payloadGeneration && left.payloadDigest === right.payloadDigest &&
    left.validatedRangeJson === right.validatedRangeJson && left.inlinePayload === right.inlinePayload &&
    left.statePayloadGeneration === right.statePayloadGeneration && left.statePayloadDigest === right.statePayloadDigest &&
    left.stateValidatedRangeJson === right.stateValidatedRangeJson &&
    left.blobLocator === right.blobLocator && left.blobByteLength === right.blobByteLength
}

function parsePayload(payload: string, snapshot: ProjectionChatBodyCacheSnapshot): readonly ProjectionChatBodyMessage[] | null {
  let value: unknown
  try { value = JSON.parse(payload) } catch { return null }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const envelope = value as Record<string, unknown>
  if (Object.keys(envelope).sort().join(',') !== 'formatVersion,historyWatermarkJson,messages,scopeKey,sessionGeneration,sessionId,sourceIdentityJson,specVersion' ||
    envelope.formatVersion !== 1 || envelope.scopeKey !== snapshot.scopeKey || envelope.specVersion !== snapshot.specVersion ||
    envelope.sessionId !== snapshot.sessionId || envelope.sessionGeneration !== snapshot.sessionGeneration ||
    envelope.sourceIdentityJson !== snapshot.sourceIdentityJson) return null
  let source: { historyWatermark?: unknown }
  try { source = JSON.parse(snapshot.sourceIdentityJson!) as typeof source } catch { return null }
  if (JSON.stringify(envelope.historyWatermarkJson) !== JSON.stringify(source.historyWatermark ?? null) || !Array.isArray(envelope.messages)) return null
  const ids = new Set<string>()
  const messages: ProjectionChatBodyMessage[] = []
  for (const item of envelope.messages) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const message = item as Record<string, unknown>
    if (Object.keys(message).sort().join(',') !== [...PROJECTION_SPECS.chatBodyV1.outputFields].sort().join(',') || typeof message.id !== 'string' || !message.id ||
      ids.has(message.id) || (message.role !== 'user' && message.role !== 'assistant') || typeof message.content !== 'string' ||
      !Number.isSafeInteger(message.timestamp)) return null
    ids.add(message.id)
    messages.push(Object.freeze({ id: message.id, role: message.role, content: message.content, timestamp: message.timestamp as number }))
  }
  return Object.freeze(messages)
}

function validManifest(snapshot: ProjectionChatBodyCacheSnapshot): boolean {
  if (!snapshot.sourceIdentityJson || snapshot.sourceIdentityJson !== snapshot.stateSourceIdentityJson ||
    snapshot.sourceIdentityJson !== snapshot.currentSourceIdentityJson ||
    snapshot.payloadGeneration !== snapshot.statePayloadGeneration || snapshot.payloadDigest !== snapshot.statePayloadDigest ||
    snapshot.validatedRangeJson !== snapshot.stateValidatedRangeJson ||
    !snapshot.payloadGeneration || !snapshot.payloadDigest || !/^[a-f0-9]{64}$/.test(snapshot.payloadDigest) ||
    !snapshot.validatedRangeJson || (snapshot.inlinePayload === undefined) === (snapshot.blobLocator === undefined)) return false
  if (snapshot.blobLocator !== undefined && (!snapshot.blobLocator.trim() || !Number.isSafeInteger(snapshot.blobByteLength) || snapshot.blobByteLength! < 1)) return false
  let range: Record<string, unknown>
  try { range = JSON.parse(snapshot.validatedRangeJson) as Record<string, unknown> } catch { return false }
  return range.formatVersion === 1 && range.specVersion === snapshot.specVersion && range.sourceIdentityJson === snapshot.sourceIdentityJson &&
    range.fromSequence === 0 && Number.isSafeInteger(range.nextSequence) && (range.nextSequence as number) >= 0 &&
    range.payloadDigest === snapshot.payloadDigest && Number.isSafeInteger(range.blobByteLength) && (range.blobByteLength as number) > 0 &&
    (snapshot.inlinePayload === undefined || new TextEncoder().encode(snapshot.inlinePayload).byteLength === range.blobByteLength) &&
    (snapshot.blobByteLength === undefined || snapshot.blobByteLength === range.blobByteLength) &&
    snapshot.payloadGeneration === `projection-${snapshot.payloadDigest}`
}

function invalidateObserved(snapshot: ProjectionChatBodyCacheSnapshot, store: ProjectionChatBodyCacheReadStore): void {
  if (snapshot.status !== 'valid' || !snapshot.stateSourceIdentityJson || snapshot.stateSourceIdentityJson !== snapshot.currentSourceIdentityJson ||
    !snapshot.statePayloadGeneration || !snapshot.statePayloadDigest || !snapshot.stateValidatedRangeJson ||
    (snapshot.cachePresent && (!snapshot.sourceIdentityJson || !snapshot.payloadGeneration || !snapshot.payloadDigest || !snapshot.validatedRangeJson))) return
  store.invalidateObserved({ sessionId: snapshot.sessionId, scopeKey: snapshot.scopeKey, sessionGeneration: snapshot.sessionGeneration,
    cachePresent: snapshot.cachePresent,
    sourceIdentityJson: snapshot.sourceIdentityJson, payloadGeneration: snapshot.payloadGeneration, payloadDigest: snapshot.payloadDigest,
    validatedRangeJson: snapshot.validatedRangeJson, stateSourceIdentityJson: snapshot.stateSourceIdentityJson,
    statePayloadGeneration: snapshot.statePayloadGeneration, statePayloadDigest: snapshot.statePayloadDigest,
    stateValidatedRangeJson: snapshot.stateValidatedRangeJson })
}

export async function readProjectionChatBodyCache(
  input: Readonly<{ sessionId: string; sessionGeneration?: string; scopeKey: string; specVersion: number }>,
  store: ProjectionChatBodyCacheReadStore,
  blobs?: ProjectionChatBodyBlobReader
): Promise<ProjectionChatBodyCacheResult> {
  if (projectionScopeKind(input.scopeKey) !== 'chatBodyV1') throw new Error('PROJECTION_SPEC_UNSUPPORTED')
  const initial = store.readSnapshot(input.sessionId, input.scopeKey)
  if (!initial || initial.sessionId !== input.sessionId || initial.sessionGeneration !== initial.currentSessionGeneration ||
    (input.sessionGeneration !== undefined && initial.currentSessionGeneration !== input.sessionGeneration) ||
    initial.scopeKey !== input.scopeKey || initial.specVersion !== input.specVersion || initial.status !== 'valid') return { kind: 'miss' }
  if (!validManifest(initial)) { invalidateObserved(initial, store); return { kind: 'miss' } }
  let payload: string
  try {
    if (initial.inlinePayload !== undefined) payload = initial.inlinePayload
    else {
      if (!blobs || !initial.blobLocator || !initial.blobByteLength || !initial.payloadDigest) return { kind: 'miss' }
      payload = await blobs.readVerified({ locator: initial.blobLocator, byteLength: initial.blobByteLength, payloadDigest: initial.payloadDigest })
    }
    if (new TextEncoder().encode(payload).byteLength !== JSON.parse(initial.validatedRangeJson!).blobByteLength ||
      await projectionPayloadDigest(payload) !== initial.payloadDigest) throw new Error('PROJECTION_CACHE_PAYLOAD_DIGEST_MISMATCH')
  } catch {
    invalidateObserved(initial, store)
    return { kind: 'miss' }
  }
  const messages = parsePayload(payload, initial)
  if (!messages) {
    invalidateObserved(initial, store)
    return { kind: 'miss' }
  }
  const fresh = store.readSnapshot(input.sessionId, input.scopeKey)
  if (!fresh || fresh.currentSessionGeneration !== fresh.sessionGeneration || !samePublication(initial, fresh) ||
    fresh.currentSourceIdentityJson !== initial.sourceIdentityJson) return { kind: 'miss' }
  return Object.freeze({ kind: 'ready', messages })
}
