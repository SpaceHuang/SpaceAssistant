import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { threadId } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import { encodeProjectionScopeKey } from '../../domain/scopeKey'
import { materializeProjectionFinalViewInWorker } from './projectionFinalViewWorkerClient'
import { createSessionProjectionBlobStore } from './sessionProjectionBlobStore'
import { createPagedChatBodyStore, type PagedChatBodyManifest } from './pagedChatBodyStore'

describe('projection final view worker client', () => {
  let roots: string[] = []
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))) })

  it('materializes and serializes an output chain off the main thread', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'projection-final-view-worker-'))
    roots.push(root)
    const scopeKey = encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: 3 })
    const identity = { sessionId: 'worker-session', sessionGeneration: 'worker-generation', scopeKey,
      specVersion: 3, sourceIdentityJson: JSON.stringify({ historyWatermark: { sessionSeq: 1 } }) }
    const blobName = 'projection-123e4567-e89b-12d3-a456-426614174000.blob'
    const blob = JSON.stringify({ formatVersion: 2, ...identity, fromSequence: 0, nextSequence: 1, events: [],
      outputManifest: { formatVersion: 1, parent: null, operations: [{ type: 'append', messages: [
        { id: 'worker-output', role: 'user', content: 'hello' }
      ] }] } })
    await fs.writeFile(path.join(root, blobName), blob, { mode: 0o600 })
    const output = { locator: blobName, byteLength: Buffer.byteLength(blob), payloadDigest: createHash('sha256').update(blob).digest('hex') }

    const result = await materializeProjectionFinalViewInWorker({ root, output, identity, historyWatermarkJson: { sessionSeq: 1 } })

    expect(result.workerThreadId).toBeGreaterThan(0)
    expect(result.workerThreadId).not.toBe(threadId)
    expect(JSON.parse(result.payload)).toMatchObject({ messages: [{ id: 'worker-output', role: 'user', content: 'hello' }] })
    expect(result.byteLength).toBe(Buffer.byteLength(result.payload))
    expect(result.payloadDigest).toHaveLength(64)
  })

  it('writes a large final view in the worker and returns only its verified blob reference', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'projection-final-view-large-worker-'))
    roots.push(root)
    const scopeKey = encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: 3 })
    const identity = { sessionId: 'worker-large-session', sessionGeneration: 'worker-generation', scopeKey,
      specVersion: 3, sourceIdentityJson: JSON.stringify({ historyWatermark: { sessionSeq: 1 } }) }
    const blobName = 'projection-123e4567-e89b-12d3-a456-426614174001.blob'
    const blob = JSON.stringify({ formatVersion: 2, ...identity, fromSequence: 0, nextSequence: 1, events: [],
      outputManifest: { formatVersion: 1, parent: null, operations: [{ type: 'append', messages: [
        { id: 'large-worker-output', role: 'user', content: 'x'.repeat(300 * 1024) }
      ] }] } })
    await fs.writeFile(path.join(root, blobName), blob, { mode: 0o600 })
    const output = { locator: blobName, byteLength: Buffer.byteLength(blob), payloadDigest: createHash('sha256').update(blob).digest('hex') }

    const result = await materializeProjectionFinalViewInWorker({ root, output, identity, historyWatermarkJson: { sessionSeq: 1 } })

    expect(result.workerThreadId).toBeGreaterThan(0)
    expect(result.payload).toBeUndefined()
    expect(result.stagedBlob).toMatchObject({ byteLength: expect.any(Number), payloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/) })
    const bytes = await fs.readFile(path.join(root, result.stagedBlob!.tempLocator))
    expect(bytes.byteLength).toBe(result.stagedBlob!.byteLength)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(result.stagedBlob!.payloadDigest)
    expect(JSON.parse(bytes.toString('utf8')).messages[0].content).toHaveLength(300 * 1024)
  })

  it('builds v4 body blocks and locator directories in the worker for atomic owner publication', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'projection-paged-final-view-worker-'))
    roots.push(root)
    const blobs = createSessionProjectionBlobStore(root)
    const scopeKey = encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: 4 })
    const sourceIdentityJson = JSON.stringify({ formatVersion: 1, sessionGeneration: 'worker-generation', sourceRevision: 2,
      messageRevision: 0, historyWatermark: { sessionSeq: 1 }, historyStreams: Array.from({ length: 20_000 }, (_, index) => `stream-${String(index).padStart(8, '0')}`) })
    const identity = { sessionId: 'worker-paged-session', sessionGeneration: 'worker-generation', scopeKey,
      specVersion: 4, sourceIdentityJson }
    const outputName = 'projection-123e4567-e89b-12d3-a456-426614174004.blob'
    const blob = JSON.stringify({ formatVersion: 2, ...identity, fromSequence: 0, nextSequence: 2, events: [],
      outputManifest: { formatVersion: 1, parent: null, operations: [{ type: 'append', messages: [
        { id: 'worker-output-b', role: 'assistant', content: 'second', timestamp: 2 },
        { id: 'worker-output-a', role: 'user', content: 'first', timestamp: 1 },
      ] }] } })
    await fs.writeFile(path.join(root, outputName), blob, { mode: 0o600 })
    const output = { locator: outputName, byteLength: Buffer.byteLength(blob), payloadDigest: createHash('sha256').update(blob).digest('hex') }

    const published = await blobs.withWorkerStaging(async (promote) => {
      const result = await materializeProjectionFinalViewInWorker({ root, output, identity, historyWatermarkJson: { sessionSeq: 1 } })
      expect(result.pagedArtifacts?.stagedBlobs.length).toBeGreaterThanOrEqual(3)
      expect(result.stagedBlob).toBeUndefined()
      const promoted = []
      for (const staged of result.pagedArtifacts!.stagedBlobs) promoted.push(await promote({ tempLocator: staged.tempLocator,
        locator: staged.locator, byteLength: staged.byteLength, payloadDigest: staged.payloadDigest }))
      return { result, promoted }
    })
    await published.promoted[0]?.release()
    const manifestBlob = published.result.pagedArtifacts!.blobReferences.find(({ kind }) => kind === 'body-manifest')
    expect(published.result.payload).toBeUndefined()
    expect(manifestBlob?.byteLength).toBeGreaterThan(256 * 1024)
    const manifest = JSON.parse(await blobs.readVerified(manifestBlob!)) as PagedChatBodyManifest
    const store = createPagedChatBodyStore(blobs)
    await expect(store.readPage({ manifest, beforeSequence: 2, limit: 2 })).resolves.toMatchObject([
      { id: 'worker-output-b', content: 'second' }, { id: 'worker-output-a', content: 'first' },
    ])
    expect(published.result.pagedArtifacts!.blobReferences.map(({ locator }) => locator)).toContain(manifest.sequenceRoot.locator)
  })

  it('publishes a valid zero-artifact manifest for an empty v4 conversation', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'projection-empty-final-view-worker-'))
    roots.push(root)
    const scopeKey = encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: 4 })
    const sourceIdentityJson = JSON.stringify({ sessionGeneration: 'worker-generation', sourceRevision: 0,
      messageRevision: 0, historyWatermark: null })
    const identity = { sessionId: 'worker-empty-session', sessionGeneration: 'worker-generation', scopeKey,
      specVersion: 4, sourceIdentityJson }
    const locator = 'projection-123e4567-e89b-12d3-a456-426614174005.blob'
    const blob = JSON.stringify({ formatVersion: 2, ...identity, fromSequence: 0, nextSequence: 0, events: [],
      outputManifest: { formatVersion: 1, parent: null, operations: [] } })
    await fs.writeFile(path.join(root, locator), blob, { mode: 0o600 })
    const result = await materializeProjectionFinalViewInWorker({ root,
      output: { locator, byteLength: Buffer.byteLength(blob), payloadDigest: createHash('sha256').update(blob).digest('hex') },
      identity, historyWatermarkJson: null })
    expect(result.pagedArtifacts?.stagedBlobs).toEqual([])
    expect(result.pagedArtifacts?.blobReferences).toEqual([])
    const manifest = JSON.parse(result.payload!) as PagedChatBodyManifest
    const blobs = createSessionProjectionBlobStore(root)
    await expect(createPagedChatBodyStore(blobs).readPage({ manifest, beforeSequence: 0, limit: 20 })).resolves.toEqual([])
  })

  it('terminates an active final view worker before settling an aborted build', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'projection-final-view-abort-'))
    roots.push(root)
    const scopeKey = encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: 3 })
    const identity = { sessionId: 'worker-abort-session', sessionGeneration: 'worker-generation', scopeKey,
      specVersion: 3, sourceIdentityJson: JSON.stringify({ historyWatermark: { sessionSeq: 1 } }) }
    const locator = 'projection-123e4567-e89b-12d3-a456-426614174002.blob'
    const blob = JSON.stringify({ formatVersion: 2, ...identity, fromSequence: 0, nextSequence: 1, events: [],
      outputManifest: { formatVersion: 1, parent: null, operations: [{ type: 'append', messages: [
        { id: 'abort-view-output', role: 'user', content: 'x'.repeat(32 * 1024) }
      ] }] } })
    await fs.writeFile(path.join(root, locator), blob, { mode: 0o600 })
    const output = { locator, byteLength: Buffer.byteLength(blob), payloadDigest: createHash('sha256').update(blob).digest('hex') }
    const controller = new AbortController()
    const work = materializeProjectionFinalViewInWorker({ root, output, identity, historyWatermarkJson: null, signal: controller.signal })
    controller.abort()

    await expect(work).rejects.toThrow('PROJECTION_FINAL_VIEW_WORKER_ABORTED')
  })
})
