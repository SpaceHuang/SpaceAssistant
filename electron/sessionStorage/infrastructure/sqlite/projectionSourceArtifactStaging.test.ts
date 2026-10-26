import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { threadId } from 'node:worker_threads'
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
})
