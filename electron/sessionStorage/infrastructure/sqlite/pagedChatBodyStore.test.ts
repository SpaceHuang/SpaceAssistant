import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTempDatabase } from '../../../database/testHelpers'
import { createSessionProjectionBlobStore } from './sessionProjectionBlobStore'
import { createPagedChatBodyStore } from './pagedChatBodyStore'

describe('paged chat body store', () => {
  let temp: ReturnType<typeof createTempDatabase> | undefined
  let root: string | undefined
  afterEach(async () => {
    temp?.cleanup()
    temp = undefined
    if (root) await fs.rm(root, { recursive: true, force: true })
    root = undefined
  })

  async function createStore() {
    temp = createTempDatabase('paged-chat-body-')
    root = path.join(os.tmpdir(), `paged-chat-body-blobs-${Date.now()}-${Math.random()}`)
    const blobs = createSessionProjectionBlobStore(root)
    return { blobs, store: createPagedChatBodyStore(blobs) }
  }

  function messages(count: number) {
    return Array.from({ length: count }, (_, sequence) => ({ id: `message-${sequence.toString().padStart(5, '0')}`,
      role: sequence % 2 ? 'assistant' as const : 'user' as const, content: `body-${sequence}`, timestamp: sequence }))
  }

  function writeInput(sessionId: string, sourceRevision: number, bodies = messages(40)) {
    const sessionGeneration = `generation-${sessionId}`
    const historyWatermarkJson = JSON.stringify([sourceRevision])
    return { sessionId, sessionGeneration, specVersion: 3, sourceRevision, messageRevision: sourceRevision,
      sourceIdentityJson: JSON.stringify({ formatVersion: 1, sessionGeneration, messageRevision: sourceRevision,
        historyWatermark: JSON.parse(historyWatermarkJson) }), historyWatermarkJson, messages: bodies }
  }

  function updateManifest(manifest: Awaited<ReturnType<ReturnType<typeof createPagedChatBodyStore>['write']>>['manifest'],
    updates: Record<string, unknown>) {
    const { manifestDigest: _oldDigest, ...current } = manifest
    const payload = { ...current, ...updates }
    return { ...payload, manifestDigest: createHash('sha256').update(JSON.stringify(payload)).digest('hex') } as typeof manifest
  }

  it('reads a page and a message ID through bounded directory paths, without loading unrelated body blocks', async () => {
    const { blobs, store } = await createStore()
    const staged = await store.write(writeInput('session-a', 7, messages(1_000)))
    const readVerified = vi.spyOn(blobs, 'readVerified')
    try {
      await staged.release()
      const page = await store.readPage({ manifest: staged.manifest, beforeSequence: 900, limit: 20 })
      expect(page.map(({ id }) => id)).toEqual(messages(1_000).slice(880, 900).map(({ id }) => id))
      expect(readVerified.mock.calls.length).toBeLessThanOrEqual(12)

      readVerified.mockClear()
      await expect(store.readByIds({ manifest: staged.manifest, messageIds: ['message-00997', 'message-00003'] }))
        .resolves.toEqual([messages(1_000)[997], messages(1_000)[3]])
      expect(readVerified.mock.calls.length).toBeLessThanOrEqual(8)
    } finally {
      await staged.release()
    }
  })

  it('isolates an oversized message and rejects duplicate message IDs or sequences before writing', async () => {
    const { blobs, store } = await createStore()
    const input = messages(3)
    input[1] = { ...input[1]!, content: 'x'.repeat(300 * 1024) }
    const staged = await store.write(writeInput('session-large', 1, input))
    const readVerified = vi.spyOn(blobs, 'readVerified')
    try {
      await staged.release()
      await expect(store.readByIds({ manifest: staged.manifest, messageIds: [input[1]!.id] })).resolves.toEqual([input[1]])
      const payloads = await Promise.all(readVerified.mock.results.map(async ({ value }) => value as Promise<string>))
      const largeBlocks = payloads.flatMap((payload) => {
        const envelope = JSON.parse(payload) as { kind?: string; entries?: unknown[] }
        const entries = envelope.entries as Array<{ message?: { content?: string } }> | undefined
        if (envelope.kind !== 'body-block' || !entries) return []
        const serializedBytes = Buffer.byteLength(payload, 'utf8')
        if (entries.some((entry) => entry.message?.content?.length === 300 * 1024)) return [{ count: entries.length, bytes: serializedBytes, oversize: true }]
        expect(serializedBytes).toBeLessThanOrEqual(256 * 1024)
        return [{ count: entries.length, bytes: serializedBytes, oversize: false }]
      })
      expect(largeBlocks.filter(({ oversize }) => oversize)).toEqual([{ count: 1, bytes: expect.any(Number), oversize: true }])
    } finally {
      await staged.release()
    }

    await expect(store.write(writeInput('session-duplicate', 1, [messages(2)[0]!, { ...messages(2)[1]!, id: messages(2)[0]!.id }])))
      .rejects.toThrow('PAGED_CHAT_BODY_DUPLICATE_ID')
    await expect(store.write(writeInput('session-duplicate-sequence', 1, [{ ...messages(2)[0]!, sequence: 0 }, { ...messages(2)[1]!, sequence: 0 }])))
      .rejects.toThrow('PAGED_CHAT_BODY_DUPLICATE_SEQUENCE')
    const mismatchedSource = writeInput('session-source-drift', 1)
    await expect(store.write({ ...mismatchedSource,
      sourceIdentityJson: JSON.stringify({ ...JSON.parse(mismatchedSource.sourceIdentityJson), sessionGeneration: 'other-generation' }) }))
      .rejects.toThrow('PAGED_CHAT_BODY_WRITE_SOURCE_IDENTITY_INVALID')
  })

  it('rejects corrupt directory, missing body block, invalid range, and mismatched manifest identity', async () => {
    const { blobs, store } = await createStore()
    const staged = await store.write(writeInput('session-corrupt', 2))
    try {
      await staged.release()
      await fs.writeFile(path.join(root!, staged.manifest.sequenceRoot.locator), 'corrupt')
      await expect(store.readPage({ manifest: staged.manifest, beforeSequence: 20, limit: 10 }))
        .rejects.toMatchObject({ code: 'PROJECTION_BLOB_CORRUPT' })
    } finally {
      await staged.release()
    }

    const second = await store.write(writeInput('session-corrupt', 2))
    const readVerified = vi.spyOn(blobs, 'readVerified')
    try {
      await second.release()
      await expect(store.readPage({ manifest: { ...second.manifest, sourceRevision: 3 }, beforeSequence: 20, limit: 10 }))
        .rejects.toThrow('PAGED_CHAT_BODY_MANIFEST_INVALID')
      await expect(store.readPage({ manifest: second.manifest, beforeSequence: 20, limit: 0 })).rejects.toThrow('PAGED_CHAT_BODY_RANGE_INVALID')
      await store.readPage({ manifest: second.manifest, beforeSequence: 40, limit: 40 })
      const results = await Promise.all(readVerified.mock.results.map(async ({ value }) => value as Promise<string>))
      const targetIndex = results.findIndex((payload) => {
        const envelope = JSON.parse(payload) as { kind?: string }
        return envelope.kind === 'body-block'
      })
      expect(targetIndex).toBeGreaterThanOrEqual(0)
      const targetPayload = JSON.parse(results[targetIndex]!) as { entries: Array<{ sequence: number }> }
      const targetLocator = readVerified.mock.calls[targetIndex]![0].locator
      await fs.rm(path.join(root!, targetLocator))
      await expect(store.readPage({ manifest: second.manifest,
        beforeSequence: targetPayload.entries.at(-1)!.sequence + 1, limit: targetPayload.entries.length }))
        .rejects.toMatchObject({ code: 'PROJECTION_BLOB_MISSING' })
    } finally {
      await second.release()
    }
  })

  it('rejects truncated or wrongly indexed body blocks and out-of-bounds message locators', async () => {
    const { blobs, store } = await createStore()
    const staged = await store.write(writeInput('session-locator', 5))
    await staged.release()
    const sequenceDirectory = JSON.parse(await blobs.readVerified(staged.manifest.sequenceRoot)) as {
      entries: Array<{ blob: { locator: string; byteLength: number; payloadDigest: string } }>
    }
    const firstBlock = sequenceDirectory.entries[0]!.blob
    const firstBlockPath = path.join(root!, firstBlock.locator)
    const originalBlock = await fs.readFile(firstBlockPath)
    await fs.writeFile(firstBlockPath, originalBlock.subarray(0, originalBlock.byteLength - 1))
    await expect(store.readPage({ manifest: staged.manifest, beforeSequence: 8, limit: 8 }))
      .rejects.toMatchObject({ code: 'PROJECTION_BLOB_CORRUPT' })
    await fs.writeFile(firstBlockPath, originalBlock)

    const wrongDigest = { ...firstBlock, payloadDigest: 'a'.repeat(64) }
    const wrongSequenceDirectory = { ...sequenceDirectory,
      entries: sequenceDirectory.entries.map((entry, index) => index === 0 ? { ...entry, blob: wrongDigest } : entry) }
    const wrongSequenceBlob = await blobs.write(JSON.stringify(wrongSequenceDirectory))
    await wrongSequenceBlob.release()
    const wrongDigestManifest = updateManifest(staged.manifest, { sequenceRoot: wrongSequenceBlob })
    await expect(store.readPage({ manifest: wrongDigestManifest, beforeSequence: 8, limit: 8 }))
      .rejects.toMatchObject({ code: 'PROJECTION_BLOB_CORRUPT' })

    const invalidIdDirectory = { formatVersion: 1, kind: 'id-directory', first: 'out-of-bounds', last: 'out-of-bounds',
      entries: [{ first: 'out-of-bounds', last: 'out-of-bounds', id: 'out-of-bounds', sequence: 0, index: 999, blob: firstBlock }] }
    const invalidIdBlob = await blobs.write(JSON.stringify(invalidIdDirectory))
    await invalidIdBlob.release()
    const invalidLocatorManifest = updateManifest(staged.manifest, { idRoot: invalidIdBlob })
    await expect(store.readByIds({ manifest: invalidLocatorManifest, messageIds: ['out-of-bounds'] }))
      .rejects.toThrow('PAGED_CHAT_BODY_LOCATOR_INVALID')
  })
})
