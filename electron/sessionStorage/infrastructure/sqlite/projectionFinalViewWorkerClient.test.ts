import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { threadId } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import { encodeProjectionScopeKey } from '../../domain/scopeKey'
import { materializeProjectionFinalViewInWorker } from './projectionFinalViewWorkerClient'

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
})
