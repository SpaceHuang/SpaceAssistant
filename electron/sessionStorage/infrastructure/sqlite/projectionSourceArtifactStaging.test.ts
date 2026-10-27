import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { threadId } from 'node:worker_threads'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProjectionHistoryChunkEvent, ProjectionMessageFact } from '../../domain/projectionSource'
import { createSessionProjectionBlobStore } from './sessionProjectionBlobStore'
import { reduceAndPublishProjectionInvocationChatBodySourcesInWorker } from './projectionHistoryReducerWorkerClient'

describe('projection source artifact worker staging', () => {
  let root: string | undefined
  afterEach(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); root = undefined })

  it('keeps a large body inside the Worker and returns only promoted blob references', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'projection-source-worker-staging-'))
    const blobs = createSessionProjectionBlobStore(root)
    const content = `${'large body 🚀,"\n'.repeat(80_000)}tail`
    const events: ProjectionHistoryChunkEvent[] = [
      { invocationId: 'staging-invocation', turnId: 'staging-invocation', sequence: 1, eventId: 'staging-1', idempotencyKey: 'staging-1',
        schemaVersion: 1, kind: 'invocation-context-committed', sessionSequence: 1, commitOrder: 1, createdAt: 1,
        payloadJson: JSON.stringify({ messages: [{ id: 'staging-message', role: 'user', content, timestamp: 1 }] }) },
      { invocationId: 'staging-invocation', turnId: 'staging-invocation', sequence: 2, eventId: 'staging-2', idempotencyKey: 'staging-2',
        schemaVersion: 1, kind: 'invocation-completed', sessionSequence: 2, commitOrder: 2, createdAt: 2,
        payloadJson: JSON.stringify({ status: 'completed' }) },
    ]
    const facts: ProjectionMessageFact[] = [{ id: 'staging-message', role: 'user', timestamp: 1, sequence: 0, queueScope: 'desktop',
      contentStorageState: 'legacy', writeMode: null, storedContent: content }]
    const result = await reduceAndPublishProjectionInvocationChatBodySourcesInWorker({ events, messageFacts: facts, blobs,
      context: { sessionId: 'staging-session', sessionGeneration: '1', sourceRevision: 2,
        sourceIdentityJson: JSON.stringify({ sessionGeneration: '1', sourceRevision: 2, messageRevision: null, historyWatermark: [2, 2, 'staging-2', 'staging-invocation'] }),
        historyWatermarkJson: JSON.stringify([2, 2, 'staging-2', 'staging-invocation']), reducerSpecVersion: 1 },
      publish: async (source, artifacts) => {
        expect(source.workerThreadId).toBeGreaterThan(0)
        expect(source.workerThreadId).not.toBe(threadId)
        expect(source.messages[0]?.content).toBeUndefined()
        expect(artifacts?.fragmentsByMessage.get('staging-message')).toBeDefined()
        const reference = artifacts!.fragmentsByMessage.get('staging-message')!
        const payload = JSON.parse(await fs.readFile(path.join(root!, reference.locator), 'utf8'))
        return { bodyLength: payload.message.content.length, locator: reference.locator }
      } })

    expect(result.bodyLength).toBe(content.length)
    expect(result.locator).toMatch(/^projection-[0-9a-f-]{36}\.blob$/)
  })

  it('reduces a segmented source body larger than 32 MiB in the Worker without main-process hydration', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'projection-source-segmented-worker-'))
    const blobs = createSessionProjectionBlobStore(root)
    const content = 'x'.repeat(33 * 1024 * 1024)
    const messageJson = JSON.stringify({ id: 'segmented-source-message', role: 'user', content, timestamp: 1 })
    const fragmentCount = 3
    const fragmentSize = Math.ceil(messageJson.length / fragmentCount)
    const messageSegments = []
    for (let fragmentIndex = 0; fragmentIndex < fragmentCount; fragmentIndex += 1) {
      const bytes = Buffer.from(messageJson.slice(fragmentIndex * fragmentSize, (fragmentIndex + 1) * fragmentSize))
      const locator = `projection-${randomUUID()}.blob`
      await fs.writeFile(path.join(root, locator), bytes, { mode: 0o600 })
      messageSegments.push({ locator, byteLength: bytes.byteLength,
        payloadDigest: createHash('sha256').update(bytes).digest('hex'), itemCount: fragmentIndex === 0 ? 1 : 0,
        encoding: 'json-item-fragment', firstItemIndex: 0, fragmentIndex, fragmentCount })
    }
    const event: ProjectionHistoryChunkEvent = { invocationId: 'segmented-source-invocation', turnId: 'segmented-source-turn',
      sequence: 1, eventId: 'segmented-source-context', idempotencyKey: 'segmented-source-context', schemaVersion: 1,
      kind: 'invocation-context-committed', sessionSequence: 1, commitOrder: 1, createdAt: 1, payloadJson: '{}',
      payload: { kind: 'source-segmented-history-event', root, messageCount: 1, messageSegments, factCount: 0,
        factSegments: [], extraPayload: {} } }
    const facts: ProjectionMessageFact[] = [{ id: 'segmented-source-message', role: 'user', timestamp: 1, sequence: 0,
      queueScope: 'desktop', contentStorageState: 'canonical-backed-dual-write', writeMode: 'canonical', storedContent: '',
      storedContentLength: content.length, storedContentDigest: createHash('sha256').update(content).digest('hex') }]

    const result = await reduceAndPublishProjectionInvocationChatBodySourcesInWorker({ events: [event], messageFacts: facts, blobs,
      context: { sessionId: 'segmented-session', sessionGeneration: '1', sourceRevision: 1,
        sourceIdentityJson: JSON.stringify({ sessionGeneration: '1', sourceRevision: 1, historyWatermark: [1, 1, event.eventId, event.invocationId] }),
        historyWatermarkJson: JSON.stringify([1, 1, event.eventId, event.invocationId]), reducerSpecVersion: 1 },
      publish: async (source, artifacts) => {
        expect(source.messages.map(({ id, sequence }) => [id, sequence])).toEqual([['segmented-source-message', 0]])
        const fragment = artifacts?.fragmentsByMessage.get('segmented-source-message')
        expect(fragment).toBeDefined()
        const payload = JSON.parse(await fs.readFile(path.join(root!, fragment!.locator), 'utf8'))
        return { bodyLength: payload.message.content.length, bodyDigest: createHash('sha256').update(payload.message.content).digest('hex') }
      } })

    expect(result.bodyLength).toBe(content.length)
    expect(result.bodyDigest).toBe(createHash('sha256').update(content).digest('hex'))
  })
})
