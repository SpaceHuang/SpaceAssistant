import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { encodeProjectionScopeKey } from '../domain/scopeKey'
import { readProjectionChatBodyCache, readProjectionChatBodyCacheManifest, type ProjectionChatBodyCacheSnapshot } from './projectionChatBodyCacheReader'

const sourceIdentityJson = JSON.stringify({ formatVersion: 1, sessionGeneration: 'g1', messageRevision: 4, historyWatermark: null })
const scopeKey = encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: 1 })
const messages = [{ id: 'm1', role: 'user', content: 'hello', timestamp: 10 }]
function snapshot(payload = JSON.stringify({ formatVersion: 1, scopeKey, specVersion: 1, sessionId: 's1',
  sessionGeneration: 'g1', sourceIdentityJson, historyWatermarkJson: null, messages })): ProjectionChatBodyCacheSnapshot {
  const payloadDigest = createHash('sha256').update(payload).digest('hex')
  const validatedRangeJson = JSON.stringify({ formatVersion: 1, specVersion: 1, sourceIdentityJson,
    fromSequence: 0, nextSequence: 1, payloadDigest, blobByteLength: Buffer.byteLength(payload) })
  return { sessionId: 's1', sessionGeneration: 'g1', currentSessionGeneration: 'g1', scopeKey, specVersion: 1, status: 'valid', sourceIdentityJson,
    stateSourceIdentityJson: sourceIdentityJson, currentSourceIdentityJson: sourceIdentityJson,
    payloadGeneration: `projection-${payloadDigest}`, payloadDigest, validatedRangeJson,
    statePayloadGeneration: `projection-${payloadDigest}`, statePayloadDigest: payloadDigest,
    stateValidatedRangeJson: validatedRangeJson, inlinePayload: payload }
}

describe('verified chatBodyV1 cache reader', () => {
  it('reuses one synchronous source snapshot when checking a ready manifest', () => {
    const current = snapshot()
    const store = { readSnapshot: vi.fn().mockReturnValue(current), invalidateObserved: vi.fn() }
    expect(readProjectionChatBodyCacheManifest({ sessionId: 's1', sessionGeneration: 'g1', scopeKey, specVersion: 1 }, store))
      .toMatchObject({ kind: 'ready', snapshot: current })
    expect(store.readSnapshot).toHaveBeenCalledOnce()
    expect(store.invalidateObserved).not.toHaveBeenCalled()
  })
  it('returns the DTO only when the payload and manifest agree with a fresh source snapshot', async () => {
    const current = snapshot()
    const store = { readSnapshot: vi.fn().mockReturnValue(current), invalidateObserved: vi.fn() }
    await expect(readProjectionChatBodyCache({ sessionId: 's1', sessionGeneration: 'g1', scopeKey, specVersion: 1 }, store))
      .resolves.toMatchObject({ kind: 'ready', messages, sourceIdentityJson, sessionGeneration: 'g1' })
    expect(store.readSnapshot).toHaveBeenCalledTimes(2)
    expect(store.invalidateObserved).not.toHaveBeenCalled()
  })

  it('rejects a source that moved while an external blob was being read', async () => {
    const current = snapshot()
    const movedIdentity = JSON.stringify({ formatVersion: 1, sessionGeneration: 'g1', messageRevision: 5, historyWatermark: null })
    const moved = { ...current, sourceIdentityJson: movedIdentity, currentSourceIdentityJson: movedIdentity }
    const store = { readSnapshot: vi.fn().mockReturnValueOnce(current).mockReturnValueOnce(moved), invalidateObserved: vi.fn() }
    const blobs = { readVerified: vi.fn().mockResolvedValue(current.inlinePayload!) }
    await expect(readProjectionChatBodyCache({ sessionId: 's1', sessionGeneration: 'g1', scopeKey, specVersion: 1 }, store, blobs))
      .resolves.toEqual({ kind: 'miss' })
    expect(store.invalidateObserved).not.toHaveBeenCalled()
  })

  it('CAS-invalidates the exact publication when its blob is missing or fails verification', async () => {
    const current = snapshot()
    const digest = createHash('sha256').update(current.inlinePayload!).digest('hex')
    const blobSnapshot: ProjectionChatBodyCacheSnapshot = { ...current, inlinePayload: undefined, blobLocator: 'cache/blob',
      blobByteLength: Buffer.byteLength(current.inlinePayload!), payloadDigest: digest, payloadGeneration: `projection-${digest}`,
      validatedRangeJson: JSON.stringify({ formatVersion: 1, specVersion: 1, sourceIdentityJson, fromSequence: 0,
        nextSequence: 1, payloadDigest: digest, blobByteLength: Buffer.byteLength(current.inlinePayload!) }) }
    const store = { readSnapshot: vi.fn().mockReturnValue(blobSnapshot), invalidateObserved: vi.fn().mockReturnValue(false) }
    const blobs = { readVerified: vi.fn().mockRejectedValue(new Error('PROJECTION_BLOB_MISSING')) }
    await expect(readProjectionChatBodyCache({ sessionId: 's1', sessionGeneration: 'g1', scopeKey, specVersion: 1 }, store, blobs))
      .resolves.toEqual({ kind: 'miss' })
    expect(store.invalidateObserved).toHaveBeenCalledOnce()
    expect(store.invalidateObserved).toHaveBeenCalledWith(expect.objectContaining({ payloadGeneration: blobSnapshot.payloadGeneration,
      payloadDigest: digest, validatedRangeJson: blobSnapshot.validatedRangeJson }))
  })

  it('CAS-invalidates a corrupt observed publication and rejects non-chatBody payload shapes', async () => {
    const current = snapshot()
    const corrupt = { ...current, inlinePayload: current.inlinePayload!.replace('hello', 'tampered') }
    const store = { readSnapshot: vi.fn().mockReturnValue(corrupt), invalidateObserved: vi.fn().mockReturnValue(true) }
    await expect(readProjectionChatBodyCache({ sessionId: 's1', sessionGeneration: 'g1', scopeKey, specVersion: 1 }, store))
      .resolves.toEqual({ kind: 'miss' })
    expect(store.invalidateObserved).toHaveBeenCalledWith(expect.objectContaining({ payloadGeneration: current.payloadGeneration,
      payloadDigest: current.payloadDigest, sourceIdentityJson }))

    const extraFieldPayload = JSON.stringify({ formatVersion: 1, scopeKey, specVersion: 1, sessionId: 's1', sessionGeneration: 'g1',
      sourceIdentityJson, historyWatermarkJson: null, messages: [{ ...messages[0], extra: true }] })
    const malformed = snapshot(extraFieldPayload)
    const malformedStore = { readSnapshot: vi.fn().mockReturnValue(malformed), invalidateObserved: vi.fn() }
    await expect(readProjectionChatBodyCache({ sessionId: 's1', sessionGeneration: 'g1', scopeKey, specVersion: 1 }, malformedStore))
      .resolves.toEqual({ kind: 'miss' })
    expect(malformedStore.invalidateObserved).toHaveBeenCalledOnce()
  })
})
