import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendMessage, createSession } from '../database/operations'
import { getDbConnection } from '../database/sqliteStore'
import { createTempDatabase } from '../database/testHelpers'
import { readChatMessagesAfterPreparation, readExportPageAfterPreparation } from './application/readChatMessages'
import { createSessionQueries } from './queries'
import type { PreparedChatBodyView } from './public/model'
import { SqliteAgentHistory } from '../runtime/sqliteAgentHistory'

describe('prepared chat body read cancellation', () => {
  let cleanup: (() => void) | undefined
  afterEach(() => { cleanup?.(); cleanup = undefined })

  it('forwards export cancellation to the worker without invalidating or reading synchronously', async () => {
    const temp = createTempDatabase('prepared-export-cancel-')
    cleanup = temp.cleanup
    const db = temp.db
    const session = createSession(db, { name: 'prepared export cancellation' })
    appendMessage(db, { id: 'prepared-export-cancel-message', sessionId: session.id, role: 'user', content: 'canonical body', timestamp: 1, status: 'sent' })
    const history = new SqliteAgentHistory(getDbConnection(db), 1, () => 3, session.id)
    await history.appendBatch([
      { invocationId: 'prepared-export-cancel-inv', turnId: 'prepared-export-cancel-turn', sequence: 1, schemaVersion: 1,
        eventId: 'prepared-export-cancel-context', idempotencyKey: 'prepared-export-cancel-context', kind: 'invocation-context-committed',
        payload: { messages: [{ id: 'prepared-export-cancel-message', role: 'user', content: 'canonical body', timestamp: 1 }] } },
      { invocationId: 'prepared-export-cancel-inv', turnId: 'prepared-export-cancel-turn', sequence: 2, schemaVersion: 1,
        eventId: 'prepared-export-cancel-terminal', idempotencyKey: 'prepared-export-cancel-terminal', kind: 'invocation-completed',
        payload: { status: 'completed' } },
    ], 0)
    const conn = getDbConnection(db)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content_storage_state='canonical-backed-only' WHERE id=?").run('prepared-export-cancel-message')

    const sourceIdentityJson = 'current-source'
    const view = { sessionId: session.id, sessionGeneration: session.generation, sourceIdentityJson, scopeKey: 'chatBodyV1', specVersion: 1,
      payloadGeneration: 'generation', payloadDigest: 'digest', validatedRangeJson: '{}', cachePresent: true,
      stateSourceIdentityJson: sourceIdentityJson, statePayloadGeneration: 'generation', statePayloadDigest: 'digest',
      stateValidatedRangeJson: '{}'} as PreparedChatBodyView
    const abortError = new Error('PROJECTION_CHAT_BODY_CACHE_WORKER_ABORTED')
    const invalidate = vi.fn()
    const readBodies = vi.fn(async (_view: PreparedChatBodyView, _messageIds: readonly string[], signal?: AbortSignal) => {
      if (!signal) throw new Error('EXPORT_ABORT_SIGNAL_NOT_FORWARDED')
      if (signal.aborted) throw signal.reason
      return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    })
    const queries = createSessionQueries(db, { currentSourceIdentity: () => sourceIdentityJson, readBodies,
      searchBodies: async () => ({ messages: [] }), invalidate })
    const authorityRead = vi.fn(() => {
      throw new Error('SYNCHRONOUS_AUTHORITY_FALLBACK_MUST_NOT_RUN_ON_CANCEL')
    })

    const controller = new AbortController()
    const pending = readExportPageAfterPreparation({ ensureChatBodyV1: async () => view, queries: { ...queries, readExportPage: authorityRead } },
      { sessionId: session.id, fromSequence: 0, pageSize: 20, signal: controller.signal })
    controller.abort(abortError)
    await expect(pending).rejects.toBe(abortError)
    expect(readBodies).toHaveBeenCalledWith(view, ['prepared-export-cancel-message'], controller.signal)
    expect(invalidate).not.toHaveBeenCalled()
    expect(authorityRead).not.toHaveBeenCalled()
  })

  it('invalidates a worker selection whose message identity disagrees and retries the authority reader', async () => {
    const temp = createTempDatabase('prepared-message-mismatch-')
    cleanup = temp.cleanup
    const db = temp.db
    const session = createSession(db, { name: 'prepared message mismatch' })
    appendMessage(db, { id: 'prepared-message-mismatch', sessionId: session.id, role: 'user', content: '', timestamp: 1, status: 'sent' })
    const conn = getDbConnection(db)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content_storage_state='canonical-backed-only' WHERE id=?").run('prepared-message-mismatch')
    const sourceIdentityJson = 'current-source'
    const view = { sessionId: session.id, sessionGeneration: session.generation, sourceIdentityJson, scopeKey: 'chatBodyV1', specVersion: 1,
      payloadGeneration: 'generation', payloadDigest: 'digest', validatedRangeJson: '{}', cachePresent: true,
      stateSourceIdentityJson: sourceIdentityJson, statePayloadGeneration: 'generation', statePayloadDigest: 'digest',
      stateValidatedRangeJson: '{}'} as PreparedChatBodyView
    const invalidate = vi.fn()
    const queries = createSessionQueries(db, { currentSourceIdentity: () => sourceIdentityJson,
      readBodies: async () => ({ messages: [{ id: 'prepared-message-mismatch', sessionId: session.id, role: 'assistant', content: 'derived', timestamp: 1 }] } as never),
      searchBodies: async () => ({ messages: [] }), invalidate })
    const authority = [{ id: 'prepared-message-mismatch', sessionId: session.id, role: 'user', content: 'canonical authority', timestamp: 1 }]
    const authorityRead = vi.fn(() => authority as never)

    await expect(readChatMessagesAfterPreparation({ ensureChatBodyV1: async () => view,
      queries: { ...queries, readMessages: authorityRead } }, { sessionId: session.id })).resolves.toBe(authority)
    expect(invalidate).toHaveBeenCalledWith(view)
    expect(authorityRead).toHaveBeenCalledOnce()
  })
})
