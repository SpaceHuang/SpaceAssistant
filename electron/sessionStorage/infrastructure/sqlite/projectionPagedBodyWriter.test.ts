import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPagedChatBodyStore, type PagedChatBodyManifest } from './pagedChatBodyStore'
import { createSessionProjectionBlobStore } from './sessionProjectionBlobStore'
import { writeProjectionPagedBody } from './projectionPagedBodyWriter'

describe('projection paged body worker writer', () => {
  let root: string | undefined
  afterEach(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); root = undefined })

  it('streams ordered bodies into promotable blocks and directories readable by the paged store', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'projection-paged-writer-'))
    const blobs = createSessionProjectionBlobStore(root)
    const sourceIdentityJson = JSON.stringify({ formatVersion: 1, sessionGeneration: 'generation-a', sourceRevision: 7,
      messageRevision: 3, historyWatermark: [12, 12, 'event-12', 'invocation-a'] })
    const written = await blobs.withWorkerStaging(async (promote, stage) => {
      async function* messages() {
        for (let sequence = 0; sequence < 140; sequence += 1) yield {
          id: `message-${String(sequence).padStart(3, '0')}`, role: sequence % 2 ? 'assistant' as const : 'user' as const,
          content: `body-${sequence}-` + 'x'.repeat(sequence === 70 ? 280 * 1024 : 8), timestamp: sequence,
        }
      }
      const result = await writeProjectionPagedBody({ root: stage.root, messages: messages(), sessionId: 'session-a',
        sessionGeneration: 'generation-a', specVersion: 4, sourceRevision: 7, messageRevision: 3,
        sourceIdentityJson, historyWatermarkJson: JSON.stringify([12, 12, 'event-12', 'invocation-a']) })
      const promoted = []
      for (const blob of result.stagedBlobs) promoted.push(await promote({ tempLocator: blob.tempLocator, locator: blob.locator,
        byteLength: blob.byteLength, payloadDigest: blob.payloadDigest }))
      return { result, promoted }
    })
    await written.promoted[0]?.release()
    const manifest = JSON.parse(written.result.manifest) as PagedChatBodyManifest
    const store = createPagedChatBodyStore(blobs)
    await expect(store.readPage({ manifest, beforeSequence: 140, limit: 25 })).resolves.toHaveLength(25)
    await expect(store.readByIds({ manifest, messageIds: ['message-000', 'message-070', 'message-139'] }))
      .resolves.toMatchObject([{ id: 'message-000' }, { id: 'message-070', content: expect.stringContaining('x'.repeat(100)) }, { id: 'message-139' }])
    expect(written.result.blobReferences).toHaveLength(written.result.stagedBlobs.length)
    expect(manifest.sourceRevision).toBe(7)
  })

  it('rejects duplicate message IDs and removes the unpromoted worker artifacts', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'projection-paged-writer-duplicate-'))
    const blobs = createSessionProjectionBlobStore(root)
    await expect(blobs.withWorkerStaging(async (_promote, stage) => {
      async function* messages() {
        yield { id: 'duplicate', role: 'user' as const, content: 'first', timestamp: 1 }
        yield { id: 'duplicate', role: 'assistant' as const, content: 'second', timestamp: 2 }
      }
      return writeProjectionPagedBody({ root: stage.root, messages: messages(), sessionId: 'session-a', sessionGeneration: 'generation-a',
        specVersion: 4, sourceRevision: 1, messageRevision: 0,
        sourceIdentityJson: JSON.stringify({ sessionGeneration: 'generation-a', sourceRevision: 1, messageRevision: 0, historyWatermark: null }),
        historyWatermarkJson: 'null' })
    })).rejects.toThrow('PAGED_CHAT_DUPLICATE_MESSAGE_ID')
    expect((await fs.readdir(root)).filter((name) => name.endsWith('.tmp') || name.endsWith('.blob'))).toEqual([])
  })
})
