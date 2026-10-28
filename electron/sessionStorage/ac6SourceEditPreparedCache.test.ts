import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { createSession, deleteSession, prepareTurnAtomically, updateMessageContent, updatePersistedTurnState } from '../database/operations'
import { createTempDatabase } from '../database/testHelpers'
import { advanceProcessGeneration } from '../database/processGeneration'
import { getDbConnection } from '../database/sqliteStore'
import { SqliteAgentHistory } from '../runtime/sqliteAgentHistory'
import { certifyCanonicalSessionApiRead } from './certification'
import { createSqliteProjectionBuildTask, createSqliteSessionStorageHost } from './sqliteSessionStorage'
import { readChatMessagesAfterPreparation } from './application/readChatMessages'
import { enableCanonicalSessionWriteAuthority, writeCanonicalBackedMessageContent } from './infrastructure/sqlite/sessionContentWriteAuthority'
import { CHAT_BODY_PROJECTION_SPEC_VERSION, encodeProjectionScopeKey } from './domain/scopeKey'

it('rebuilds edited canonical content and removes its prepared cache when the session is deleted', async () => {
  const temp = createTempDatabase('ac6-source-edit-prepared-cache-')
  const blobRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ac6-source-edit-blobs-'))
  const db = temp.db
  let host: ReturnType<typeof createSqliteSessionStorageHost> | undefined
  try {
    const session = createSession(db, { name: 'AC-6 source edit', model: 'test' })
    const originalBody = 'P4_AC6_SOURCE_EDIT_BEFORE'
    const editedBody = 'P4_AC6_SOURCE_EDIT_AFTER'
    const userMessageId = 'ac6-source-edit-user'
    const assistantMessageId = 'ac6-source-edit-assistant'
    const turnId = 'ac6-source-edit-turn'
    const requestId = 'ac6-source-edit-request'
    const invocationId = turnId
    prepareTurnAtomically(db, {
      user: { id: userMessageId, sessionId: session.id, role: 'user', content: originalBody, timestamp: 1, status: 'sent' },
      assistant: { id: assistantMessageId, sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' },
      turn: { turnId, requestId, sessionId: session.id, assistantMessageId, state: 'prepared', startToken: 'ac6-source-edit-start' }
    })
    const generation = advanceProcessGeneration(getDbConnection(db))
    const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
    await history.appendBatch([
      {
        invocationId, turnId, sequence: 2,
        schemaVersion: 1, eventId: 'ac6-source-edit-context', idempotencyKey: 'ac6-source-edit-context',
        kind: 'invocation-context-committed',
        payload: {
          messages: [{ id: userMessageId, role: 'user', content: originalBody, timestamp: 1 }],
          requiredUserMessage: { id: userMessageId, message: { id: userMessageId, role: 'user', content: originalBody, timestamp: 1 } }
        }
      },
      {
        invocationId, turnId, sequence: 3,
        schemaVersion: 1, eventId: 'ac6-source-edit-response', idempotencyKey: 'ac6-source-edit-response',
        kind: 'model-response-committed',
        payload: { message: { id: assistantMessageId, role: 'assistant', content: 'accepted assistant response', timestamp: 2 } }
      },
      {
        invocationId, turnId, sequence: 4,
        schemaVersion: 1, eventId: 'ac6-source-edit-completed', idempotencyKey: 'ac6-source-edit-completed',
        kind: 'invocation-completed', payload: { status: 'completed' }
      }
    ], 1)
    updateMessageContent(db, assistantMessageId, { content: 'accepted assistant response', status: 'completed' })
    updatePersistedTurnState(db, turnId, 'terminal', { outcome: 'completed' })
    expect(certifyCanonicalSessionApiRead(db, session.id).status).toBe('eligible')
    expect(enableCanonicalSessionWriteAuthority(db, session.id).status).toBe('enabled')

    const task = createSqliteProjectionBuildTask({ db, dbPath: temp.dbPath, blobRoot,
      processGeneration: () => generation, connectionEpoch: () => generation, now: Date.now })
    host = createSqliteSessionStorageHost(db, {
      storage: { projectionBlobRoot: blobRoot },
      startup: { recoverHistory: async () => ({ interruptedCount: 0, repairFailureCount: 0 }),
        recoverSessionLedgers: async () => ({ repairFailureCount: 0 }) },
      maintenanceTasks: [task]
    })

    const before = await readChatMessagesAfterPreparation(host.storage, { sessionId: session.id })
    expect(before.map(({ id, content }) => ({ id, content }))).toEqual([
      { id: userMessageId, content: originalBody },
      { id: assistantMessageId, content: 'accepted assistant response' }
    ])
    const scopeKey = encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: CHAT_BODY_PROJECTION_SPEC_VERSION })
    const projection = getDbConnection(db).prepare(`SELECT status,failure_case_json FROM session_projection_state
      WHERE session_id=? AND scope_key=?`).get(session.id, scopeKey)
    expect(projection).toMatchObject({ status: 'valid' })
    expect(getDbConnection(db).prepare(`SELECT 1 AS ready FROM session_projection_cache
      WHERE session_id=? AND scope_key=?`).get(session.id, scopeKey)).toEqual({ ready: 1 })
    await expect(writeCanonicalBackedMessageContent(db, userMessageId, editedBody)).resolves.toBe(true)
    expect(getDbConnection(db).prepare(`SELECT content,content_storage_state FROM messages WHERE id=?`).get(userMessageId))
      .toEqual({ content: '', content_storage_state: 'canonical-backed-only' })
    const after = await readChatMessagesAfterPreparation(host.storage, { sessionId: session.id })
    expect(after.map(({ id, content }) => ({ id, content }))).toEqual([
      { id: userMessageId, content: editedBody },
      { id: assistantMessageId, content: 'accepted assistant response' }
    ])
    expect(getDbConnection(db).prepare(`SELECT status,failure_case_json FROM session_projection_state
      WHERE session_id=? AND scope_key=?`).get(session.id, scopeKey)).toEqual({ status: 'valid', failure_case_json: null })

    deleteSession(db, session.id, { flush: false })
    expect(getDbConnection(db).prepare('SELECT 1 FROM sessions WHERE id=?').get(session.id)).toBeUndefined()
    expect(getDbConnection(db).prepare('SELECT 1 FROM session_projection_state WHERE session_id=?').get(session.id)).toBeUndefined()
    expect(getDbConnection(db).prepare('SELECT 1 FROM session_projection_cache WHERE session_id=?').get(session.id)).toBeUndefined()
  } finally {
    await host?.lifecycle.stop({ deadlineMs: 5_000 })
    temp.cleanup()
    await fs.rm(blobRoot, { recursive: true, force: true })
  }
})
