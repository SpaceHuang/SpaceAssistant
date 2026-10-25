import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { threadId } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import { encodeProjectionScopeKey } from '../../domain/scopeKey'
import type { PreparedChatBodyView } from '../../public/model'
import { readPreparedChatBodiesInWorker, searchPreparedChatBodiesInWorker } from './projectionChatBodyCacheWorkerClient'

describe('projection chat body cache worker client', () => {
  let roots: string[] = []
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))) })

  it('verifies a bounded inline cache on the caller thread without starting a worker', async () => {
    const sessionId = 'inline-chat-session'
    const sessionGeneration = 'inline-chat-generation'
    const scopeKey = encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: 3 })
    const sourceIdentityJson = JSON.stringify({ historyWatermark: { sessionSeq: 1 }, messageRevision: 2 })
    const envelope = { formatVersion: 1, scopeKey, specVersion: 3, sessionId, sessionGeneration, sourceIdentityJson,
      historyWatermarkJson: { sessionSeq: 1 }, messages: [
        { id: 'inline-requested', role: 'assistant', content: 'selected body', timestamp: 3 },
        { id: 'inline-unselected', role: 'user', content: 'other body', timestamp: 2 }
      ] }
    const inlinePayload = JSON.stringify(envelope)
    const bytes = Buffer.from(inlinePayload)
    const payloadDigest = createHash('sha256').update(bytes).digest('hex')
    const validatedRangeJson = JSON.stringify({ formatVersion: 1, specVersion: 3, sourceIdentityJson,
      fromSequence: 0, nextSequence: 2, payloadDigest, blobByteLength: bytes.byteLength })
    const view: PreparedChatBodyView = { sessionId, sessionGeneration, scopeKey, specVersion: 3, sourceIdentityJson,
      payloadGeneration: `projection-${payloadDigest}`, payloadDigest, validatedRangeJson,
      cachePresent: true, stateSourceIdentityJson: sourceIdentityJson, statePayloadGeneration: `projection-${payloadDigest}`,
      statePayloadDigest: payloadDigest, stateValidatedRangeJson: validatedRangeJson, inlinePayload }

    const result = await readPreparedChatBodiesInWorker({ root: '', view, messageIds: ['inline-requested'] })

    expect(result.workerThreadId).toBe(0)
    expect(result.messages).toEqual([{ id: 'inline-requested', role: 'assistant', content: 'selected body', timestamp: 3 }])
    const search = await searchPreparedChatBodiesInWorker({ root: '', view, query: 'body', limit: 1, candidateFacts: [] })
    expect(search.workerThreadId).toBe(0)
    expect(search.messages).toEqual([{ id: 'inline-requested', role: 'assistant', content: 'selected body', timestamp: 3 }])
    await expect(searchPreparedChatBodiesInWorker({ root: '', view, query: 'body', limit: 1,
      candidateFacts: [{ id: 'canonical-missing-candidate', role: 'user', timestamp: 99 }] }))
      .rejects.toThrow('PROJECTION_CHAT_BODY_CACHE_CANDIDATE_SOURCE_MISMATCH')
    await expect(readPreparedChatBodiesInWorker({ root: '', view: { ...view,
      inlinePayload: inlinePayload.replace('selected body', 'tampered body') }, messageIds: ['inline-requested'] }))
      .rejects.toThrow('PROJECTION_CHAT_BODY_CACHE_DIGEST_MISMATCH')
  })

  it('verifies a large cache payload in a worker and returns only requested bodies', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'projection-chat-body-cache-worker-'))
    roots.push(root)
    const sessionId = 'worker-chat-session'
    const sessionGeneration = 'worker-chat-generation'
    const scopeKey = encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: 3 })
    const sourceIdentityJson = JSON.stringify({ historyWatermark: { sessionSeq: 4 }, messageRevision: 2 })
    const envelope = { formatVersion: 1, scopeKey, specVersion: 3, sessionId, sessionGeneration, sourceIdentityJson,
      historyWatermarkJson: { sessionSeq: 4 }, messages: [
        { id: 'requested', role: 'assistant', content: 'selected body', timestamp: 3 },
        { id: 'large-unselected', role: 'user', content: `selected body ${'x'.repeat(300 * 1024)}`, timestamp: 2 }
      ] }
    const payload = JSON.stringify(envelope)
    const bytes = Buffer.from(payload)
    const payloadDigest = createHash('sha256').update(bytes).digest('hex')
    const blobLocator = 'projection-123e4567-e89b-12d3-a456-426614174000.blob'
    await fs.writeFile(path.join(root, blobLocator), bytes, { mode: 0o600 })
    const view: PreparedChatBodyView = {
      sessionId, sessionGeneration, scopeKey, specVersion: 3, sourceIdentityJson,
      payloadGeneration: `projection-${payloadDigest}`, payloadDigest,
      validatedRangeJson: JSON.stringify({ formatVersion: 1, specVersion: 3, sourceIdentityJson,
        fromSequence: 0, nextSequence: 4, payloadDigest, blobByteLength: bytes.byteLength }),
      cachePresent: true, stateSourceIdentityJson: sourceIdentityJson,
      statePayloadGeneration: `projection-${payloadDigest}`, statePayloadDigest: payloadDigest,
      stateValidatedRangeJson: JSON.stringify({ formatVersion: 1, specVersion: 3, sourceIdentityJson,
        fromSequence: 0, nextSequence: 4, payloadDigest, blobByteLength: bytes.byteLength }),
      blobLocator, blobByteLength: bytes.byteLength
    }

    const result = await readPreparedChatBodiesInWorker({ root, view, messageIds: ['requested'] })

    expect(result.workerThreadId).toBeGreaterThan(0)
    expect(result.workerThreadId).not.toBe(threadId)
    expect(result.messages).toEqual([{ id: 'requested', role: 'assistant', content: 'selected body', timestamp: 3 }])
    const repeatedSelection = await readPreparedChatBodiesInWorker({ root, view, messageIds: ['requested'] })
    expect(repeatedSelection.workerThreadId).toBe(result.workerThreadId)
    expect(repeatedSelection.messages).toEqual(result.messages)
    const search = await searchPreparedChatBodiesInWorker({ root, view, query: 'selected', limit: 1, candidateFacts: [] })
    expect(search.workerThreadId).toBeGreaterThan(0)
    expect(search.workerThreadId).not.toBe(threadId)
    expect(search.messages).toEqual([{ id: 'requested', role: 'assistant', content: 'selected body', timestamp: 3 }])
    const repeatedSearch = await searchPreparedChatBodiesInWorker({ root, view, query: 'selected', limit: 2, candidateFacts: [] })
    expect(repeatedSearch.workerThreadId).toBe(search.workerThreadId)
    expect(repeatedSearch.messages.map(({ id }) => id)).toEqual(['requested', 'large-unselected'])
    await expect(searchPreparedChatBodiesInWorker({ root, view, query: 'selected', limit: 1,
      candidateFacts: [{ id: 'missing-canonical-candidate', role: 'user', timestamp: 7 }] }))
      .rejects.toThrow('PROJECTION_CHAT_BODY_CACHE_CANDIDATE_SOURCE_MISMATCH')
  })

  it('streams a cache larger than the search worker LRU and returns bounded results', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'projection-chat-body-cache-stream-worker-'))
    roots.push(root)
    const sessionId = 'stream-worker-chat-session'
    const sessionGeneration = 'stream-worker-chat-generation'
    const scopeKey = encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: 3 })
    const sourceIdentityJson = JSON.stringify({ historyWatermark: { sessionSeq: 500 }, messageRevision: 2 })
    const messages = Array.from({ length: 70 }, (_, index) => ({
      id: `stream-${index}`, role: index % 2 ? 'user' as const : 'assistant' as const,
      content: `${index === 0 ? 'needle' : 'other'} ${'x'.repeat(256 * 1024)}`, timestamp: index
    }))
    const envelope = { formatVersion: 1, scopeKey, specVersion: 3, sessionId, sessionGeneration, sourceIdentityJson,
      historyWatermarkJson: { sessionSeq: 500 }, messages }
    const bytes = Buffer.from(JSON.stringify(envelope))
    expect(bytes.byteLength).toBeGreaterThan(16 * 1024 * 1024)
    const payloadDigest = createHash('sha256').update(bytes).digest('hex')
    const blobLocator = 'projection-123e4567-e89b-12d3-a456-426614174000.blob'
    await fs.writeFile(path.join(root, blobLocator), bytes, { mode: 0o600 })
    const validatedRangeJson = JSON.stringify({ formatVersion: 1, specVersion: 3, sourceIdentityJson,
      fromSequence: 0, nextSequence: messages.length, payloadDigest, blobByteLength: bytes.byteLength })
    const view: PreparedChatBodyView = { sessionId, sessionGeneration, scopeKey, specVersion: 3, sourceIdentityJson,
      payloadGeneration: `projection-${payloadDigest}`, payloadDigest, validatedRangeJson,
      cachePresent: true, stateSourceIdentityJson: sourceIdentityJson,
      statePayloadGeneration: `projection-${payloadDigest}`, statePayloadDigest: payloadDigest,
      stateValidatedRangeJson: validatedRangeJson, blobLocator, blobByteLength: bytes.byteLength }

    const selected = await readPreparedChatBodiesInWorker({ root, view, messageIds: ['stream-0'] })
    expect(selected.messages).toEqual([{ id: 'stream-0', role: 'assistant', content: `needle ${'x'.repeat(256 * 1024)}`, timestamp: 0 }])
    const search = await searchPreparedChatBodiesInWorker({ root, view, query: 'needle', limit: 1,
      candidateFacts: [{ id: 'stream-0', role: 'assistant', timestamp: 0 }] })
    expect(search.messages.map(({ id }) => id)).toEqual(['stream-0'])
    await expect(searchPreparedChatBodiesInWorker({ root, view, query: 'needle', limit: 1,
      candidateFacts: [{ id: 'missing-stream-candidate', role: 'user', timestamp: 10 }] }))
      .rejects.toThrow('PROJECTION_CHAT_BODY_CACHE_CANDIDATE_SOURCE_MISMATCH')
  })
})
