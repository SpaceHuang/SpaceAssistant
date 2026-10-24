import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendMessage, createSession } from '../database/operations'
import { createTempDatabase } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import type { PreparedChatBodyView } from './public/model'
import { createRoutingQueries } from './routingQueries'

const view = (sessionId: string, sessionGeneration: string, sourceIdentityJson: string): PreparedChatBodyView => ({
  sessionId, sessionGeneration, sourceIdentityJson, scopeKey: 'chatBodyV1', specVersion: 3,
  payloadGeneration: 'projection-generation', payloadDigest: 'a'.repeat(64), validatedRangeJson: '{}', cachePresent: true,
  stateSourceIdentityJson: sourceIdentityJson, statePayloadGeneration: 'projection-generation',
  statePayloadDigest: 'a'.repeat(64), stateValidatedRangeJson: '{}'
})

describe('prepared turn routing reader', () => {
  let temp: ReturnType<typeof createTempDatabase> | undefined
  afterEach(() => { temp?.cleanup(); temp = undefined })

  it('uses prepared canonical bodies without replaying History on the main thread', async () => {
    temp = createTempDatabase('prepared-routing-')
    const db = temp.db
    const session = createSession(db, { name: 'prepared routing', model: 'test' })
    const rows = [
      appendMessage(db, { id: 'route-old-user', sessionId: session.id, role: 'user', content: 'old raw user', timestamp: 1, status: 'sent' }).message,
      appendMessage(db, { id: 'route-old-assistant', sessionId: session.id, role: 'assistant', content: 'old raw assistant', timestamp: 2, status: 'completed' }).message,
      appendMessage(db, { id: 'route-current-user', sessionId: session.id, role: 'user', content: 'raw current', timestamp: 3, status: 'sent', attachments: [{ id: 'route-image' }] }).message,
    ]
    getDbConnection(db).prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    getDbConnection(db).prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
    const sourceIdentityJson = JSON.stringify({ historyWatermark: { sessionSeq: 3 }, messageRevision: 3 })
    const prepared = view(session.id, session.generation, sourceIdentityJson)
    const canonicalBodies = new Map(rows.map((row) => [row.id, {
      id: row.id, role: row.role as 'user' | 'assistant', timestamp: row.timestamp,
      content: `prepared ${row.id}`
    }]))
    const readBodies = vi.fn(async (_view: PreparedChatBodyView, ids: readonly string[]) => ({
      messages: ids.map((id) => canonicalBodies.get(id)!).filter(Boolean), workerThreadId: 2
    }))
    const routing = createRoutingQueries(db, { currentSourceIdentity: () => sourceIdentityJson, readBodies, invalidate: vi.fn() })
    const oldSingleRead = vi.spyOn(await import('./infrastructure/sqlite/sessionTranscriptProjection'), 'getProjectedMessage')
      .mockImplementation(() => { throw new Error('ROUTING_MUST_NOT_REPLAY_HISTORY') })
    const oldRecentRead = vi.spyOn(await import('./infrastructure/sqlite/sessionTranscriptProjection'), 'getProjectedRecentTurnRoutingMessages')
      .mockImplementation(() => { throw new Error('ROUTING_MUST_NOT_REPLAY_HISTORY') })

    const result = await routing.readPreparedRoutingInput!({ sessionId: session.id, requiredUserMessageId: 'route-current-user',
      reuseUserMessageId: 'route-current-user', limit: 2, prepared })

    expect(result).toMatchObject({
      userInput: 'prepared route-current-user', hasVision: true,
      recentMessages: [
        { role: 'assistant', content: 'prepared route-old-assistant' },
        { role: 'user', content: 'prepared route-current-user' }
      ]
    })
    expect(readBodies).toHaveBeenCalled()
    expect(oldSingleRead).not.toHaveBeenCalled()
    expect(oldRecentRead).not.toHaveBeenCalled()
    const resolved = routing.resolveRoutingInput({ sessionId: session.id, selection: result!.fence,
      routeInput: { userInput: result!.userInput!, recentMessages: result!.recentMessages } })
    expect(resolved.routeInput).toEqual({ userInput: 'prepared route-current-user', recentMessages: result!.recentMessages })
    expect(routing.isSelectionCurrent(session.id, resolved.fence)).toBe(true)
  })

  it('rejects a prepared routing selection when the source fence changes during worker reading', async () => {
    temp = createTempDatabase('prepared-routing-stale-')
    const db = temp.db
    const session = createSession(db, { name: 'stale prepared routing', model: 'test' })
    appendMessage(db, { id: 'stale-route-user', sessionId: session.id, role: 'user', content: '', timestamp: 1, status: 'sent' })
    getDbConnection(db).prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    getDbConnection(db).prepare("UPDATE messages SET content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
    const prepared = view(session.id, session.generation, 'source-before')
    let currentIdentity = 'source-before'
    const routing = createRoutingQueries(db, { currentSourceIdentity: () => currentIdentity,
      readBodies: async () => { currentIdentity = 'source-after'; return { messages: [], workerThreadId: 2 } }, invalidate: vi.fn() })

    await expect(routing.readPreparedRoutingInput!({ sessionId: session.id, requiredUserMessageId: 'stale-route-user', prepared }))
      .resolves.toBeUndefined()
  })

  it('propagates configuring-turn cancellation while waiting for prepared route bodies', async () => {
    temp = createTempDatabase('prepared-routing-cancel-')
    const db = temp.db
    const session = createSession(db, { name: 'cancel prepared routing', model: 'test' })
    appendMessage(db, { id: 'cancel-route-user', sessionId: session.id, role: 'user', content: '', timestamp: 1, status: 'sent' })
    getDbConnection(db).prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    getDbConnection(db).prepare("UPDATE messages SET content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
    const prepared = view(session.id, session.generation, 'cancel-source')
    const controller = new AbortController()
    const routing = createRoutingQueries(db, { currentSourceIdentity: () => 'cancel-source', readBodies: (_view, _ids, signal) =>
      new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('PROJECTION_CHAT_BODY_CACHE_WORKER_ABORTED')), { once: true })),
    invalidate: vi.fn() })
    const pending = routing.readPreparedRoutingInput!({ sessionId: session.id, requiredUserMessageId: 'cancel-route-user', prepared, signal: controller.signal })
    controller.abort()

    await expect(pending).rejects.toThrow('PROJECTION_CHAT_BODY_CACHE_WORKER_ABORTED')
  })

  it('continues keyset pages past empty canonical bodies and returns the newest non-empty window', async () => {
    temp = createTempDatabase('prepared-routing-pages-')
    const db = temp.db
    const session = createSession(db, { name: 'prepared routing pages', model: 'test' })
    const bodies = new Map<string, string>()
    for (let index = 0; index < 130; index += 1) {
      const id = `route-page-${String(index).padStart(3, '0')}`
      appendMessage(db, { id, sessionId: session.id, role: index % 2 ? 'assistant' : 'user', content: '', timestamp: index + 1,
        status: index % 2 ? 'completed' : 'sent' })
      bodies.set(id, index < 2 ? `body-${index}` : '   ')
    }
    getDbConnection(db).prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    getDbConnection(db).prepare("UPDATE messages SET content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
    const sourceIdentityJson = 'route-page-source'
    const prepared = view(session.id, session.generation, sourceIdentityJson)
    const readBodies = vi.fn(async (_view: PreparedChatBodyView, ids: readonly string[]) => ({
      messages: ids.map((id) => ({ id, role: Number(id.slice(-3)) % 2 ? 'assistant' as const : 'user' as const,
        content: bodies.get(id)!, timestamp: Number(id.slice(-3)) + 1 })), workerThreadId: 2
    }))
    const routing = createRoutingQueries(db, { currentSourceIdentity: () => sourceIdentityJson, readBodies, invalidate: vi.fn() })

    const result = await routing.readPreparedRoutingInput!({ sessionId: session.id, limit: 2, prepared })

    expect(result?.recentMessages).toEqual([
      { role: 'user', content: 'body-0' },
      { role: 'assistant', content: 'body-1' }
    ])
    expect(readBodies).toHaveBeenCalledTimes(3)
    expect(readBodies.mock.calls.flatMap(([, ids]) => ids)).toHaveLength(130)
  })
})
