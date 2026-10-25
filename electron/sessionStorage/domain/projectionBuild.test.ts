import { describe, expect, it } from 'vitest'
import { acceptProjectionBuildChunk, attachProjectionPendingHistoryChunk, attachProjectionStableIdIndexManifest, createProjectionBuildCheckpoint,
  MAX_SEGMENTED_PROJECTION_EVENT_BYTES, MAX_STAGED_PROJECTION_CHUNK_BYTES, parseProjectionBuildCheckpoint, takeoverProjectionBuildCheckpoint } from './projectionBuild'
import type { ProjectionBuildChunkReceipt, ProjectionBuildLimits } from './projectionBuild'

const limits: ProjectionBuildLimits = { maxRows: 2, maxBytes: 64 }
const initial = () => createProjectionBuildCheckpoint({
  sessionId: 'session-a', sessionGeneration: 'generation-a', scopeKey: 'scope-a', specVersion: 1,
  sourceIdentityJson: '{"revision":1}', processGeneration: 4, rebuildToken: 'token-a', startSequence: 0,
  historyReducerStateJson: '{"formatVersion":1}',
})
const chunk = (patch: Partial<ProjectionBuildChunkReceipt> = {}): ProjectionBuildChunkReceipt => ({
  sessionId: 'session-a', sessionGeneration: 'generation-a', scopeKey: 'scope-a', specVersion: 1,
  sourceIdentityJson: '{"revision":1}', processGeneration: 4, rebuildToken: 'token-a',
  fromSequence: 0, nextSequence: 2, rowCount: 2, byteLength: 32, payloadDigest: 'a'.repeat(64), blobLocator: 'chunk-a.blob',
  ...patch,
})

describe('projection build checkpoint reducer', () => {
  it('accepts bounded chunks only for the exact lease, scope, spec, and source fence', () => {
    const accepted = acceptProjectionBuildChunk(initial(), chunk(), limits)
    expect(accepted).toMatchObject({ nextSequence: 2, processedRows: 2, processedBytes: 32,
      outputManifest: { locator: 'chunk-a.blob', byteLength: 32, payloadDigest: 'a'.repeat(64) } })
    for (const mutation of [
      { sourceIdentityJson: '{"revision":2}' }, { sessionGeneration: 'generation-b' }, { scopeKey: 'scope-b' },
      { specVersion: 2 }, { processGeneration: 5 }, { rebuildToken: 'stale-token' },
    ]) expect(acceptProjectionBuildChunk(initial(), chunk(mutation), limits)).toBeNull()
  })

  it('requires a forward keyset cursor and enforces row, byte, digest, and locator bounds', () => {
    const state = acceptProjectionBuildChunk(initial(), chunk(), limits)!
    expect(acceptProjectionBuildChunk(state, chunk({ fromSequence: 0, nextSequence: 3 }), limits)).toBeNull()
    expect(acceptProjectionBuildChunk(initial(), chunk({ nextSequence: 0 }), limits)).toBeNull()
    expect(acceptProjectionBuildChunk(initial(), chunk({ rowCount: 3 }), limits)).toBeNull()
    expect(acceptProjectionBuildChunk(initial(), chunk({ byteLength: 65 }), limits)).toBeNull()
    expect(acceptProjectionBuildChunk(initial(), chunk({ payloadDigest: 'not-a-digest' }), limits)).toBeNull()
    expect(acceptProjectionBuildChunk(initial(), chunk({ blobLocator: '' }), limits)).toBeNull()
  })

  it('fences stale process callbacks and requires exact checkpoint ownership for takeover', () => {
    const state = acceptProjectionBuildChunk(initial(), chunk(), limits)!
    expect(takeoverProjectionBuildCheckpoint(state, { processGeneration: 4, rebuildToken: 'token-b', sourceIdentityJson: state.sourceIdentityJson })).toBeNull()
    expect(takeoverProjectionBuildCheckpoint(state, { processGeneration: 5, rebuildToken: 'token-b', sourceIdentityJson: '{"revision":2}' })).toBeNull()
    const takenOver = takeoverProjectionBuildCheckpoint(state, { processGeneration: 5, rebuildToken: 'token-b', sourceIdentityJson: state.sourceIdentityJson })!
    expect(takenOver).toMatchObject({ processGeneration: 5, rebuildToken: 'token-b', nextSequence: 2,
      outputManifest: state.outputManifest })
    expect(acceptProjectionBuildChunk(takenOver, chunk({ fromSequence: 2, nextSequence: 3, rowCount: 1 }), limits)).toBeNull()
  })

  it('keeps durable checkpoint size bounded as accepted source chunks grow', () => {
    let checkpoint = initial()
    for (let index = 0; index < 128; index += 1) {
      const next = checkpoint.nextSequence + 2
      checkpoint = acceptProjectionBuildChunk(checkpoint, chunk({ fromSequence: checkpoint.nextSequence,
        nextSequence: next, blobLocator: `chunk-${index}.blob` }), limits, JSON.stringify({ cursor: next }))!
    }
    expect(JSON.stringify(checkpoint).length).toBeLessThan(1024)
    expect(checkpoint.nextSequence).toBe(256)
    expect(checkpoint.processedRows).toBe(256)
  })

  it('parses only internally consistent persisted checkpoint JSON', () => {
    const state = acceptProjectionBuildChunk(initial(), chunk(), limits)!
    expect(parseProjectionBuildCheckpoint(JSON.stringify(state))).toEqual(state)
    expect(parseProjectionBuildCheckpoint(JSON.stringify({ ...state, processedRows: 99 }))).toBeNull()
    expect(parseProjectionBuildCheckpoint(JSON.stringify({ ...state, formatVersion: 2 }))).toBeNull()
    expect(parseProjectionBuildCheckpoint(JSON.stringify({ ...state, historyReducerStateJson: '{broken' }))).toBeNull()
    expect(parseProjectionBuildCheckpoint('{bad json')).toBeNull()
  })

  it('accepts an identity-bound reducer state blob reference and rejects conflicting state sources', () => {
    const state = acceptProjectionBuildChunk(initial(), chunk(), limits)!
    const ref = { locator: 'projection-00000000-0000-4000-8000-000000000111.blob', byteLength: 70_000,
      payloadDigest: 'c'.repeat(64), sessionId: state.sessionId, scopeKey: state.scopeKey,
      sourceIdentityJson: state.sourceIdentityJson }
    const externalized = acceptProjectionBuildChunk(initial(), chunk(), limits, null, null, 32, ref)!
    expect(externalized).toMatchObject({ historyReducerStateJson: null, historyReducerStateBlob: ref })
    expect(parseProjectionBuildCheckpoint(JSON.stringify(externalized))).toEqual(externalized)
    expect(parseProjectionBuildCheckpoint(JSON.stringify({ ...externalized,
      historyReducerStateBlob: { ...ref, sourceIdentityJson: '{"revision":2}' } }))).toBeNull()
    expect(parseProjectionBuildCheckpoint(JSON.stringify({ ...state, historyReducerStateBlob: ref }))).toBeNull()
  })

  it('persists a source-bound pending chunk at the committed cursor until reducer acceptance', () => {
    const checkpoint = initial()
    const pending = { locator: 'projection-00000000-0000-4000-8000-000000000222.blob', byteLength: 70_000,
      payloadDigest: 'd'.repeat(64), sessionId: checkpoint.sessionId, scopeKey: checkpoint.scopeKey,
      sourceIdentityJson: checkpoint.sourceIdentityJson, fromSequence: 0, nextSequence: 1, rowCount: 1,
      sourceBytes: 70_000, hasMore: true }
    const staged = attachProjectionPendingHistoryChunk(checkpoint, pending)!
    expect(staged).toMatchObject({ nextSequence: 0, pendingHistoryChunkBlob: pending })
    expect(parseProjectionBuildCheckpoint(JSON.stringify(staged))).toEqual(staged)
    expect(attachProjectionPendingHistoryChunk(staged, pending)).toBeNull()
    expect(parseProjectionBuildCheckpoint(JSON.stringify({ ...staged,
      pendingHistoryChunkBlob: { ...pending, fromSequence: 1 } }))).toBeNull()
    expect(parseProjectionBuildCheckpoint(JSON.stringify({ ...staged,
      pendingHistoryChunkBlob: { ...pending, sourceIdentityJson: '{"source":2}' } }))).toBeNull()
    expect(attachProjectionPendingHistoryChunk(checkpoint, { ...pending, byteLength: MAX_STAGED_PROJECTION_CHUNK_BYTES + 1 })).toBeNull()
    expect(parseProjectionBuildCheckpoint(JSON.stringify({ ...staged,
      pendingHistoryChunkBlob: { ...pending, sourceBytes: MAX_STAGED_PROJECTION_CHUNK_BYTES + 1 } }))).not.toBeNull()
    expect(parseProjectionBuildCheckpoint(JSON.stringify({ ...staged,
      pendingHistoryChunkBlob: { ...pending, sourceBytes: MAX_SEGMENTED_PROJECTION_EVENT_BYTES + 1 } }))).toBeNull()
    const largeReceipt = chunk({ fromSequence: 0, nextSequence: 1, rowCount: 1, byteLength: 70_000 })
    expect(acceptProjectionBuildChunk(staged, largeReceipt, limits, '{}', null, 32, null)).toBeNull()
    const accepted = acceptProjectionBuildChunk(staged, largeReceipt, limits, '{}', null, 32, null, true)!
    expect(accepted).toMatchObject({ nextSequence: 1, pendingHistoryChunkBlob: null })
  })

  it('persists only a bounded reference to the resumable stable-ID index manifest', () => {
    const checkpoint = initial()
    const indexed = attachProjectionStableIdIndexManifest(checkpoint, { locator: 'stable-index.blob', byteLength: 2048,
      payloadDigest: 'b'.repeat(64), itemCount: 128, sessionId: checkpoint.sessionId, scopeKey: checkpoint.scopeKey,
      sourceIdentityJson: checkpoint.sourceIdentityJson })!
    expect(parseProjectionBuildCheckpoint(JSON.stringify(indexed))).toEqual(indexed)
    expect(JSON.stringify(indexed)).not.toContain('message-id-127')
    expect(attachProjectionStableIdIndexManifest(checkpoint, { locator: '', byteLength: 0,
      payloadDigest: 'bad', itemCount: -1, sessionId: checkpoint.sessionId, scopeKey: checkpoint.scopeKey,
      sourceIdentityJson: checkpoint.sourceIdentityJson })).toBeNull()
  })
})
