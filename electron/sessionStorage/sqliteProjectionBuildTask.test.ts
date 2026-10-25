import { afterEach, describe, expect, it } from 'vitest'
import os from 'node:os'
import fsSync from 'node:fs'
import path from 'node:path'
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createMemoryAppDb, createTempDatabase } from '../database/testHelpers'
import { appendMessage, createPersistedTurn, createSession, enqueueQueuedUserMessage } from '../database/operations'
import { createSqliteProjectionBuildTask, createSqliteSessionStorageHost } from './sqliteSessionStorage'
import { createSqliteProjectionStateStore } from './infrastructure/sqlite/sessionProjectionStateStore'
import { createSqliteProjectionChatBodyCacheStore } from './infrastructure/sqlite/sessionProjectionStateStore'
import { readProjectionChatBodyCache } from './application/projectionChatBodyCacheReader'
import { CHAT_BODY_PROJECTION_SPEC_VERSION, encodeProjectionScopeKey } from './domain/scopeKey'
import { SqliteAgentHistory } from '../runtime/sqliteAgentHistory'
import { createSpillStore } from '../storage/spillStore'
import { advanceProcessGeneration } from '../database/processGeneration'
import { queueInputFingerprint } from '../queueInputFingerprint'
import { getDbConnection } from '../database/sqliteStore'
import { openDatabase } from '../database'
import { createSessionProjectionBlobStore } from './infrastructure/sqlite/sessionProjectionBlobStore'
import { readApiBaselineAfterPreparation, readChatMessageAfterPreparation, readChatMessagesAfterPreparation, readChatPageAfterPreparation, readSearchCorpusPageAfterPreparation, readExportPageAfterPreparation } from './application/readChatMessages'

describe('SQLite projection build task composition', () => {
  let root: string | undefined
  afterEach(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); root = undefined })

  it('registers an idle durable due-work task and quiesces after stop', async () => {
    const db = createMemoryAppDb()
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-projection-task-'))
    try {
      const task = createSqliteProjectionBuildTask({ db, dbPath: db.filePath, blobRoot: root,
        processGeneration: () => 2, connectionEpoch: () => 2, now: () => 3 })
      expect(task.category).toBe('derived-index')
      const handle = task.start()!
      handle.stop()
      await handle.quiesce()
    } finally { db.close() }
  })

  it('prepares a chatBodyV1 scope through the host capability and publishes only its registered DTO', async () => {
    const temp = createTempDatabase('sqlite-projection-chat-body-')
    const db = temp.db
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-projection-chat-body-blobs-'))
    try {
      const session = createSession(db, { name: 'projection chat body', model: 'test' })
      const processGeneration = advanceProcessGeneration(getDbConnection(db))
      appendMessage(db, { id: 'projection-chat-body-user', sessionId: session.id, role: 'user', content: 'same body', timestamp: 11, status: 'sent' })
      appendMessage(db, { id: 'projection-chat-body-assistant', sessionId: session.id, role: 'assistant', content: 'assistant body', timestamp: 12, status: 'failed' })
      const queued = enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: 'projection-chat-body-queued', content: 'queued body' })
      const history = new SqliteAgentHistory(getDbConnection(db), 1, () => 3, session.id)
      await history.appendBatch([
        { invocationId: 'projection-chat-body-inv', turnId: 'projection-chat-body-turn', sequence: 1, schemaVersion: 1,
          eventId: 'projection-chat-body-context', idempotencyKey: 'projection-chat-body-context', kind: 'invocation-context-committed',
          payload: { messages: [
            { id: 'projection-chat-body-user', role: 'user', content: 'same body', timestamp: 11 },
            { id: 'projection-chat-body-assistant', role: 'assistant', content: 'assistant body', timestamp: 12 },
            { id: queued.persisted.message.id, role: 'user', content: 'queued body', timestamp: queued.persisted.message.timestamp },
          ] } },
        { invocationId: 'projection-chat-body-inv', turnId: 'projection-chat-body-turn', sequence: 2, schemaVersion: 1,
          eventId: 'projection-chat-body-terminal', idempotencyKey: 'projection-chat-body-terminal', kind: 'invocation-completed',
          payload: { status: 'completed' } },
      ], 0)
      createPersistedTurn(db, { turnId: 'projection-chat-body-failed-turn', requestId: 'projection-chat-body-failed-invocation',
        sessionId: session.id, userMessageId: 'projection-chat-body-user', assistantMessageId: 'projection-chat-body-assistant',
        contextBoundarySequence: 0, state: 'failed', startToken: 'projection-chat-body-failed-token' })
      getDbConnection(db).prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
      getDbConnection(db).prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE id IN (?,?)").run('projection-chat-body-user', 'projection-chat-body-assistant')
      const scopeKey = encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: CHAT_BODY_PROJECTION_SPEC_VERSION })
      const task = createSqliteProjectionBuildTask({ db, dbPath: temp.dbPath, blobRoot: root,
        processGeneration: () => processGeneration, connectionEpoch: () => processGeneration, now: () => 3 })
      const host = createSqliteSessionStorageHost(db, {
        storage: { projectionBlobRoot: root },
        startup: { recoverHistory: async () => ({ interruptedCount: 0, repairFailureCount: 0 }),
          recoverSessionLedgers: async () => ({ repairFailureCount: 0 }) },
        maintenanceTasks: [task],
      })
      try {
        const ensured = await host.storage.ensureChatBodyV1?.({ sessionId: session.id })
        expect(ensured).toMatchObject({ sessionId: session.id, sourceIdentityJson: expect.any(String), sessionGeneration: session.generation,
          payloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/) })
        expect(createSqliteProjectionStateStore(db).get(session.id, scopeKey)).toMatchObject({ status: 'valid' })
        const cache = getDbConnection(db).prepare('SELECT inline_payload FROM session_projection_cache WHERE session_id=? AND scope_key=?')
          .get(session.id, scopeKey) as { inline_payload: string }
        const published = JSON.parse(cache.inline_payload) as { messages: Array<Record<string, unknown>> }
        expect(published.messages).toEqual([
          { id: 'projection-chat-body-user', role: 'user', content: 'same body', timestamp: 11 },
          { id: 'projection-chat-body-assistant', role: 'assistant', content: 'assistant body', timestamp: 12 },
          { id: queued.persisted.message.id, role: 'user', content: 'queued body', timestamp: queued.persisted.message.timestamp },
        ])
        expect(Object.keys(published.messages[0]!).sort()).toEqual(['content', 'id', 'role', 'timestamp'])
        const cacheStore = createSqliteProjectionChatBodyCacheStore(db)
        await expect(readProjectionChatBodyCache({ sessionId: session.id, sessionGeneration: session.generation, scopeKey, specVersion: CHAT_BODY_PROJECTION_SPEC_VERSION },
          cacheStore, createSessionProjectionBlobStore(root)))
          .resolves.toMatchObject({ kind: 'ready', messages: published.messages, sessionGeneration: session.generation })
        await expect(readChatMessagesAfterPreparation(host.storage, { sessionId: session.id }))
          .resolves.toMatchObject([
            { id: 'projection-chat-body-user', content: 'same body' },
            { id: 'projection-chat-body-assistant', content: 'assistant body' },
            { id: queued.persisted.message.id, content: 'queued body' },
          ])
        await expect(host.storage.queries.readPreparedChatPage?.({ sessionId: session.id, prepared: ensured }))
          .resolves.toMatchObject({ entries: [
            { sequence: expect.any(Number), message: { id: 'projection-chat-body-user', content: 'same body' } },
            { sequence: expect.any(Number), message: { id: 'projection-chat-body-assistant', content: 'assistant body' } },
            { sequence: expect.any(Number), message: { id: queued.persisted.message.id, content: 'queued body' } },
          ] })
        await expect(readChatPageAfterPreparation(host.storage, { sessionId: session.id }))
          .resolves.toMatchObject({ entries: [
            { message: { id: 'projection-chat-body-user', content: 'same body' } },
            { message: { id: 'projection-chat-body-assistant', content: 'assistant body' } },
            { message: { id: queued.persisted.message.id, content: 'queued body' } },
          ] })
        await expect(readApiBaselineAfterPreparation(host.storage, { sessionId: session.id, limit: 20 }))
          .resolves.toMatchObject({ sessionId: session.id, entries: [
            { sequence: expect.any(Number), message: { id: 'projection-chat-body-user', content: 'same body' } },
            { sequence: expect.any(Number), message: { id: 'projection-chat-body-assistant', content: 'assistant body' } },
            { sequence: expect.any(Number), message: { id: queued.persisted.message.id, content: 'queued body' } },
          ] })
        const authorityExport = host.storage.queries.readExportPage({ sessionId: session.id, fromSequence: 0, pageSize: 50 })
        await expect(readExportPageAfterPreparation(host.storage, { sessionId: session.id, fromSequence: 0, pageSize: 50 }))
          .resolves.toEqual(authorityExport)
        await expect(host.storage.queries.readPreparedRetryTarget?.({ sessionId: session.id, prepared: ensured }))
          .resolves.toMatchObject({
            failedAssistant: { message: { id: 'projection-chat-body-assistant', content: 'assistant body' } },
            currentUser: { message: { id: 'projection-chat-body-user', content: 'same body' } },
            sourceInvocationId: 'projection-chat-body-failed-invocation', sourceTurnId: 'projection-chat-body-failed-turn',
          })
        await expect(readChatMessageAfterPreparation(host.storage, { sessionId: session.id, messageId: 'projection-chat-body-assistant' }))
          .resolves.toMatchObject({ id: 'projection-chat-body-assistant', content: 'assistant body' })
        const authorityCorpus = host.storage.queries.readSearchCorpusPage({ sessionId: session.id, fromSequence: 0, pageSize: 50 })
        expect(authorityCorpus.entries.map(({ message }) => message.id)).toEqual(['projection-chat-body-user', 'projection-chat-body-assistant'])
        const corpusPage = await host.storage.queries.readPreparedSearchCorpusPage?.({ sessionId: session.id, fromSequence: 0, pageSize: 50, prepared: ensured })
        expect(corpusPage).toEqual(authorityCorpus)
        expect(corpusPage).toMatchObject({ entries: [
          { sequence: expect.any(Number), message: { id: 'projection-chat-body-user', content: 'same body' } },
          { sequence: expect.any(Number), message: { id: 'projection-chat-body-assistant', content: 'assistant body' } },
        ], hasMore: false })
        getDbConnection(db).prepare(`UPDATE session_projection_cache SET inline_payload=replace(inline_payload,'same body','evil body')
          WHERE session_id=? AND scope_key=?`).run(session.id, scopeKey)
        await expect(readChatPageAfterPreparation(host.storage, { sessionId: session.id }))
          .resolves.toMatchObject({ entries: [
            { message: { id: 'projection-chat-body-user', content: 'same body' } },
            { message: { id: 'projection-chat-body-assistant', content: 'assistant body' } },
            { message: { id: queued.persisted.message.id, content: 'queued body' } },
          ] })
        const searchPrepared = await host.storage.ensureChatBodyV1?.({ sessionId: session.id })
        getDbConnection(db).prepare(`UPDATE session_projection_cache SET inline_payload=replace(inline_payload,'same body','evil body')
          WHERE session_id=? AND scope_key=?`).run(session.id, scopeKey)
        await expect(readSearchCorpusPageAfterPreparation(host.storage, { sessionId: session.id, fromSequence: 0, pageSize: 50, prepared: searchPrepared }))
          .resolves.toMatchObject({ entries: [
            { message: { id: 'projection-chat-body-user', content: 'same body' } },
            { message: { id: 'projection-chat-body-assistant', content: 'assistant body' } },
          ], hasMore: false })
        expect(createSqliteProjectionStateStore(db).get(session.id, scopeKey)?.status).toBe('invalid')
        appendMessage(db, { id: 'projection-chat-body-new-source', sessionId: session.id, role: 'user', content: 'new source', timestamp: 12, status: 'sent' })
        await expect(host.storage.queries.readPreparedMessages?.({ sessionId: session.id, prepared: ensured })).resolves.toBeUndefined()
        await expect(host.storage.queries.readPreparedChatPage?.({ sessionId: session.id, prepared: ensured })).resolves.toBeUndefined()
        await expect(host.storage.queries.readPreparedApiBaseline?.({ sessionId: session.id, prepared: ensured })).resolves.toBeUndefined()
      } finally { await host.lifecycle.stop({ deadlineMs: 5_000 }) }
    } finally { db.close(); temp.cleanup() }
  })

  it('loads accepted turn context from the prepared worker cache without replaying History on the main thread', async () => {
    const temp = createTempDatabase('sqlite-projection-accepted-context-')
    const db = temp.db
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-projection-accepted-context-blobs-'))
    try {
      const session = createSession(db, { name: 'prepared accepted context', model: 'test' })
      const user = appendMessage(db, { id: 'prepared-accepted-user', sessionId: session.id, role: 'user',
        content: 'accepted canonical body', timestamp: 11, status: 'sent' })
      appendMessage(db, { id: 'prepared-accepted-assistant', sessionId: session.id, role: 'assistant',
        content: '', timestamp: 12, status: 'streaming' })
      createPersistedTurn(db, { turnId: 'prepared-accepted-turn', requestId: 'prepared-accepted-request', sessionId: session.id,
        userMessageId: user.message.id, assistantMessageId: 'prepared-accepted-assistant',
        contextBoundarySequence: user.sequence - 1, state: 'executing', excludeMessageIds: [] })
      const history = new SqliteAgentHistory(getDbConnection(db), 1, () => 3, session.id)
      await history.appendBatch([
        { invocationId: 'prepared-accepted-turn', turnId: 'prepared-accepted-turn', sequence: 1, schemaVersion: 1,
          eventId: 'prepared-accepted-input', idempotencyKey: 'prepared-accepted-input', kind: 'session-input-committed',
          payload: { sessionId: session.id, messageId: user.message.id, role: 'user', inputFingerprint: queueInputFingerprint({ text: 'accepted canonical body', attachments: [] }) } },
        { invocationId: 'prepared-accepted-turn', turnId: 'prepared-accepted-turn', sequence: 2, schemaVersion: 1,
          eventId: 'prepared-accepted-context', idempotencyKey: 'prepared-accepted-context', kind: 'invocation-context-committed',
          payload: { messages: [{ id: user.message.id, role: 'user', content: 'accepted canonical body', timestamp: 11 }] } },
        { invocationId: 'prepared-accepted-turn', turnId: 'prepared-accepted-turn', sequence: 3, schemaVersion: 1,
          eventId: 'prepared-accepted-terminal', idempotencyKey: 'prepared-accepted-terminal', kind: 'invocation-completed',
          payload: { status: 'completed' } },
      ], 0)
      getDbConnection(db).prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
      getDbConnection(db).prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE id=?")
        .run(user.message.id)
      const processGeneration = advanceProcessGeneration(getDbConnection(db))
      const task = createSqliteProjectionBuildTask({ db, dbPath: temp.dbPath, blobRoot: root,
        processGeneration: () => processGeneration, connectionEpoch: () => processGeneration, now: () => 3 })
      const host = createSqliteSessionStorageHost(db, {
        storage: { projectionBlobRoot: root },
        startup: { recoverHistory: async () => ({ interruptedCount: 0, repairFailureCount: 0 }),
          recoverSessionLedgers: async () => ({ repairFailureCount: 0 }) },
        maintenanceTasks: [task],
      })
      const replaySpy = vi.spyOn(SqliteAgentHistory.prototype, 'readCanonicalSessionTranscript')
      const shadowReplaySpy = vi.spyOn(SqliteAgentHistory.prototype, 'readCanonicalSessionTranscriptForShadow')
      const fullHistoryReadSpy = vi.spyOn(SqliteAgentHistory.prototype, 'readSync')

      try {
        const actual = await host.storage.execution.loadAcceptedMessagesAsync({ sessionId: session.id, turnId: 'prepared-accepted-turn' })
        expect(actual).toMatchObject([{ id: user.message.id, content: 'accepted canonical body' }])
        expect(fullHistoryReadSpy).not.toHaveBeenCalled()
        expect(replaySpy).not.toHaveBeenCalled()
        expect(shadowReplaySpy).not.toHaveBeenCalled()
      } finally {
        fullHistoryReadSpy.mockRestore()
        replaySpy.mockRestore()
        shadowReplaySpy.mockRestore()
      }
    } finally { temp.cleanup() }
  })

  it('rebuilds an oversized History event when its persisted pending chunk is corrupted', async () => {
    const temp = createTempDatabase('sqlite-projection-deferred-legacy-')
    const db = temp.db
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-projection-deferred-legacy-blobs-'))
    try {
      const session = createSession(db, { name: 'deferred projection legacy authority', model: 'test' })
      appendMessage(db, { id: 'deferred-legacy-user', sessionId: session.id, role: 'user', content: 'keep-serving-legacy', timestamp: 1, status: 'sent' })
      const history = new SqliteAgentHistory(getDbConnection(db), 1, () => 3, session.id)
      await history.appendBatch([{ invocationId: 'deferred-large-inv', turnId: 'deferred-large-turn', sequence: 1, schemaVersion: 1,
        eventId: 'deferred-large-event', idempotencyKey: 'deferred-large-event', kind: 'invocation-context-committed',
        payload: { messages: [{ id: 'deferred-legacy-user', role: 'user', content: 'keep-serving-legacy', timestamp: 1 }], extraLargeFact: 'x'.repeat(400_000) } }], 0)
      const processGeneration = advanceProcessGeneration(getDbConnection(db))
      let corruptedPendingChunk = false
      const task = createSqliteProjectionBuildTask({ db, dbPath: temp.dbPath, blobRoot: root,
        processGeneration: () => processGeneration, connectionEpoch: () => processGeneration, now: () => 3,
        onResult: (_item, result) => {
          if (corruptedPendingChunk || result.kind !== 'checkpointed' || !result.checkpoint.pendingHistoryChunkBlob) return
          corruptedPendingChunk = true
          fsSync.writeFileSync(path.join(root!, result.checkpoint.pendingHistoryChunkBlob.locator), 'corrupt pending chunk')
        } })
      const host = createSqliteSessionStorageHost(db, { storage: { projectionBlobRoot: root },
        startup: { recoverHistory: async () => ({ interruptedCount: 0, repairFailureCount: 0 }), recoverSessionLedgers: async () => ({ repairFailureCount: 0 }) },
        maintenanceTasks: [task] })
      try {
        await expect(host.storage.ensureChatBodyV1?.({ sessionId: session.id })).rejects.toThrow('PROJECTION_PREPARATION_CHECKPOINT_INVALID')
        expect(corruptedPendingChunk).toBe(true)
        await expect(host.storage.ensureChatBodyV1?.({ sessionId: session.id })).resolves.toBeDefined()
        expect(createSqliteProjectionStateStore(db).get(session.id,
          encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: CHAT_BODY_PROJECTION_SPEC_VERSION })))
          .toMatchObject({ status: 'valid' })
        expect(await readChatMessagesAfterPreparation(host.storage, { sessionId: session.id }))
          .toMatchObject([{ id: 'deferred-legacy-user', content: 'keep-serving-legacy' }])
      } finally { await host.lifecycle.stop({ deadlineMs: 5_000 }) }
    } finally { db.close(); temp.cleanup() }
  })

  it('stages oversized canonical-only History and message facts and completes projection preparation', async () => {
    const temp = createTempDatabase('sqlite-projection-deferred-facts-')
    const db = temp.db
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-projection-deferred-facts-blobs-'))
    try {
      const session = createSession(db, { name: 'deferred projection canonical only', model: 'test' })
      const body = 'x'.repeat(300 * 1024)
      appendMessage(db, { id: 'deferred-facts-user', sessionId: session.id, role: 'user', content: body, timestamp: 1, status: 'sent' })
      const history = new SqliteAgentHistory(getDbConnection(db), 1, () => 3, session.id)
      await history.appendBatch([
        { invocationId: 'deferred-facts-inv', turnId: 'deferred-facts-turn', sequence: 1, schemaVersion: 1,
          eventId: 'deferred-facts-context', idempotencyKey: 'deferred-facts-context', kind: 'invocation-context-committed',
          payload: { messages: [{ id: 'deferred-facts-user', role: 'user', content: body, timestamp: 1 }] } },
        { invocationId: 'deferred-facts-inv', turnId: 'deferred-facts-turn', sequence: 2, schemaVersion: 1,
          eventId: 'deferred-facts-terminal', idempotencyKey: 'deferred-facts-terminal', kind: 'invocation-completed', payload: { status: 'completed' } },
      ], 0)
      getDbConnection(db).prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
      getDbConnection(db).prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE id=?").run('deferred-facts-user')
      const processGeneration = advanceProcessGeneration(getDbConnection(db))
      const task = createSqliteProjectionBuildTask({ db, dbPath: temp.dbPath, blobRoot: root,
        processGeneration: () => processGeneration, connectionEpoch: () => processGeneration, now: () => 3 })
      const host = createSqliteSessionStorageHost(db, { storage: { projectionBlobRoot: root },
        startup: { recoverHistory: async () => ({ interruptedCount: 0, repairFailureCount: 0 }), recoverSessionLedgers: async () => ({ repairFailureCount: 0 }) },
        maintenanceTasks: [task] })
      try {
        const deferredStorage = { ...host.storage, ensureChatBodyV1: async () => { throw new Error('PROJECTION_PREPARATION_DEFERRED_LARGE') } }
        await expect(readChatMessagesAfterPreparation(deferredStorage, { sessionId: session.id }))
          .resolves.toMatchObject([{ id: 'deferred-facts-user', content: body }])
        await expect(host.storage.ensureChatBodyV1?.({ sessionId: session.id })).resolves.toBeDefined()
        expect(createSqliteProjectionStateStore(db).get(session.id,
          encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: CHAT_BODY_PROJECTION_SPEC_VERSION })))
          .toMatchObject({ status: 'valid' })
        await expect(readChatMessagesAfterPreparation(host.storage, { sessionId: session.id }))
          .resolves.toMatchObject([{ id: 'deferred-facts-user', content: body }])
      } finally { await host.lifecycle.stop({ deadlineMs: 5_000 }) }
    } finally { db.close(); temp.cleanup() }
  })

  it('segments a canonical-writable single History event above the source staging cap', async () => {
    const temp = createTempDatabase('sqlite-projection-single-history-event-segments-')
    const db = temp.db
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-projection-single-history-event-segments-blobs-'))
    try {
      const session = createSession(db, { name: 'single oversized History event', model: 'test' })
      const body = 'segment-source-body-'.repeat(2_048)
      const messages = Array.from({ length: 850 }, (_, index) => ({ id: `segment-source-${index}`, role: 'user', content: body, timestamp: index + 1 }))
      for (const message of messages) appendMessage(db, { ...message, sessionId: session.id, status: 'sent' })
      const history = new SqliteAgentHistory(getDbConnection(db), 1, () => 3, session.id,
        createSpillStore(path.join(path.dirname(temp.dbPath), 'spill')))
      await history.appendBatch([
        { invocationId: 'single-history-segment-inv', turnId: 'single-history-segment-turn', sequence: 1, schemaVersion: 1,
          eventId: 'single-history-segment-context', idempotencyKey: 'single-history-segment-context', kind: 'invocation-context-committed',
          payload: { messages } },
        { invocationId: 'single-history-segment-inv', turnId: 'single-history-segment-turn', sequence: 2, schemaVersion: 1,
          eventId: 'single-history-segment-terminal', idempotencyKey: 'single-history-segment-terminal', kind: 'invocation-completed', payload: { status: 'completed' } },
      ], 0)
      const storedPayload = getDbConnection(db).prepare(`SELECT length(CAST(payload_json AS BLOB)) AS byte_length,
        instr(payload_json, '__spaceassistant_spill_v1') AS spill_marker FROM agent_history_events WHERE event_id=?`)
        .get('single-history-segment-context') as { byte_length: number; spill_marker: number }
      expect(storedPayload.byte_length).toBeGreaterThan(32 * 1024 * 1024)
      expect(storedPayload.spill_marker).toBe(0)
      getDbConnection(db).prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
      getDbConnection(db).prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
      const processGeneration = advanceProcessGeneration(getDbConnection(db))
      const task = createSqliteProjectionBuildTask({ db, dbPath: temp.dbPath, blobRoot: root,
        processGeneration: () => processGeneration, connectionEpoch: () => processGeneration, now: () => 3 })
      const host = createSqliteSessionStorageHost(db, { storage: { projectionBlobRoot: root },
        startup: { recoverHistory: async () => ({ interruptedCount: 0, repairFailureCount: 0 }), recoverSessionLedgers: async () => ({ repairFailureCount: 0 }) },
        maintenanceTasks: [task] })
      try {
        const prepared = await host.storage.ensureChatBodyV1?.({ sessionId: session.id })
        expect(prepared).toMatchObject({
          sessionId: session.id, payloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/) })
        const projected: Array<{ id: string; content: string }> = []
        let beforeSequence: number | null = null
        do {
          const page = await host.storage.queries.readPreparedChatPage?.({ sessionId: session.id, prepared, beforeSequence })
          expect(page).toBeDefined()
          projected.push(...page!.entries.map(({ message }) => ({ id: message.id, content: message.content })))
          beforeSequence = page!.oldestSequence
          if (!page!.hasMoreBefore) break
        } while (beforeSequence !== null)
        expect(projected).toHaveLength(messages.length)
        expect(new Set(projected.map(({ id }) => id))).toEqual(new Set(messages.map(({ id }) => id)))
        expect(projected.every((message) => message.content === body)).toBe(true)
      } finally { await host.lifecycle.stop({ deadlineMs: 5_000 }) }
    } finally { temp.cleanup() }
  }, 60_000)

  it('segments large same-snapshot message facts instead of embedding them in the root manifest', async () => {
    const temp = createTempDatabase('sqlite-projection-large-message-facts-segments-')
    const db = temp.db
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-projection-large-message-facts-blobs-'))
    try {
      const session = createSession(db, { name: 'large History message facts', model: 'test' })
      const body = 'dual-write-fact-body-'.repeat(2_048)
      const messages = Array.from({ length: 850 }, (_, index) => ({ id: `large-fact-${index}`, role: 'user', content: body, timestamp: index + 1 }))
      for (const message of messages) appendMessage(db, { ...message, sessionId: session.id, status: 'sent' })
      const history = new SqliteAgentHistory(getDbConnection(db), 1, () => 3, session.id,
        createSpillStore(path.join(path.dirname(temp.dbPath), 'source-spill')))
      await history.appendBatch([
        { invocationId: 'large-facts-inv', turnId: 'large-facts-turn', sequence: 1, schemaVersion: 1,
          eventId: 'large-facts-context', idempotencyKey: 'large-facts-context', kind: 'invocation-context-committed', payload: { messages } },
        { invocationId: 'large-facts-inv', turnId: 'large-facts-turn', sequence: 2, schemaVersion: 1,
          eventId: 'large-facts-terminal', idempotencyKey: 'large-facts-terminal', kind: 'invocation-completed', payload: { status: 'completed' } },
      ], 0)
      const conn = getDbConnection(db)
      conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
      conn.prepare("UPDATE messages SET content_storage_state='canonical-backed-dual-write' WHERE session_id=?").run(session.id)
      const storedEvent = conn.prepare('SELECT length(CAST(payload_json AS BLOB)) AS byte_length FROM agent_history_events WHERE event_id=?')
        .get('large-facts-context') as { byte_length: number }
      expect(storedEvent.byte_length).toBeGreaterThan(32 * 1024 * 1024)
      const processGeneration = advanceProcessGeneration(conn)
      const task = createSqliteProjectionBuildTask({ db, dbPath: temp.dbPath, blobRoot: root,
        processGeneration: () => processGeneration, connectionEpoch: () => processGeneration, now: () => 3 })
      const host = createSqliteSessionStorageHost(db, { storage: { projectionBlobRoot: root },
        startup: { recoverHistory: async () => ({ interruptedCount: 0, repairFailureCount: 0 }),
          recoverSessionLedgers: async () => ({ repairFailureCount: 0 }) }, maintenanceTasks: [task] })
      try {
        const prepared = await host.storage.ensureChatBodyV1?.({ sessionId: session.id })
        expect(prepared).toMatchObject({ sessionId: session.id, payloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/) })
        const page = await host.storage.queries.readPreparedChatPage?.({ sessionId: session.id, prepared, limit: 10 })
        expect(page?.entries).toHaveLength(20)
        expect(page?.entries.every(({ message }) => message.content === body)).toBe(true)
      } finally { await host.lifecycle.stop({ deadlineMs: 5_000 }) }
    } finally { temp.cleanup() }
  }, 60_000)

  it('segments one oversized spilled message item across bounded History blobs', async () => {
    const temp = createTempDatabase('sqlite-projection-single-oversized-history-item-')
    const db = temp.db
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-projection-single-oversized-history-item-blobs-'))
    try {
      const session = createSession(db, { name: 'single oversized History item', model: 'test' })
      const body = 'x'.repeat(17 * 1024 * 1024)
      appendMessage(db, { id: 'single-oversized-history-item', sessionId: session.id, role: 'user', content: body,
        timestamp: 1, status: 'sent' })
      const history = new SqliteAgentHistory(getDbConnection(db), 1, () => 3, session.id,
        createSpillStore(path.join(path.dirname(temp.dbPath), 'spill')))
      await history.appendBatch([
        { invocationId: 'single-oversized-history-item-inv', turnId: 'single-oversized-history-item-turn', sequence: 1, schemaVersion: 1,
          eventId: 'single-oversized-history-item-context', idempotencyKey: 'single-oversized-history-item-context',
          kind: 'invocation-context-committed', payload: { messages: [{ id: 'single-oversized-history-item', role: 'user', content: body, timestamp: 1 }],
            requiredUserMessage: { id: 'single-oversized-history-item', message: { id: 'single-oversized-history-item', role: 'user', content: body, timestamp: 1 } } } },
        { invocationId: 'single-oversized-history-item-inv', turnId: 'single-oversized-history-item-turn', sequence: 2, schemaVersion: 1,
          eventId: 'single-oversized-history-item-terminal', idempotencyKey: 'single-oversized-history-item-terminal',
          kind: 'invocation-completed', payload: { status: 'completed' } },
      ], 0)
      const conn = getDbConnection(db)
      conn.prepare(`UPDATE spill_reference_backfill_state SET status='complete',verified_generation=(SELECT meta_value FROM spill_reference_meta WHERE meta_key='canonical_change_generation')
        WHERE owner_table='agent_history_events'`).run()
      conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
      conn.prepare("UPDATE messages SET content_storage_state='canonical-backed-dual-write' WHERE session_id=?").run(session.id)
      const stagedHistoryRow = conn.prepare('SELECT length(CAST(payload_json AS BLOB)) AS byte_length, instr(payload_json,\'__spaceassistant_spill_v1\') AS has_spill FROM agent_history_events WHERE event_id=?')
        .get('single-oversized-history-item-context') as { byte_length: number; has_spill: number }
      expect(stagedHistoryRow.byte_length).toBeGreaterThan(16 * 1024 * 1024)
      expect(stagedHistoryRow.has_spill).toBeGreaterThan(0)
      const processGeneration = advanceProcessGeneration(conn)
      const task = createSqliteProjectionBuildTask({ db, dbPath: temp.dbPath, blobRoot: root,
        processGeneration: () => processGeneration, connectionEpoch: () => processGeneration, now: () => 3 })
      const host = createSqliteSessionStorageHost(db, { storage: { projectionBlobRoot: root },
        startup: { recoverHistory: async () => ({ interruptedCount: 0, repairFailureCount: 0 }),
          recoverSessionLedgers: async () => ({ repairFailureCount: 0 }) }, maintenanceTasks: [task] })
      try {
        const prepared = await host.storage.ensureChatBodyV1?.({ sessionId: session.id })
        expect(prepared).toMatchObject({ sessionId: session.id, payloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/) })
        const page = await host.storage.queries.readPreparedChatPage?.({ sessionId: session.id, prepared, limit: 1 })
        expect(page?.entries).toHaveLength(1)
        expect(page?.entries[0]?.message.content).toBe(body)
      } finally { await host.lifecycle.stop({ deadlineMs: 5_000 }) }
    } finally { temp.cleanup() }
  }, 120_000)

  it('publishes a segmented output manifest chain for a multi-message oversized History chunk', async () => {
    const temp = createTempDatabase('sqlite-projection-output-segments-')
    const db = temp.db
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-projection-output-segments-blobs-'))
    try {
      const session = createSession(db, { name: 'segmented output manifests', model: 'test' })
      const firstBody = 'first-large-message'.repeat(450_000)
      const secondBody = 'second-large-message'.repeat(450_000)
      appendMessage(db, { id: 'segmented-first', sessionId: session.id, role: 'user', content: '', timestamp: 1, status: 'sent' })
      appendMessage(db, { id: 'segmented-second', sessionId: session.id, role: 'user', content: '', timestamp: 2, status: 'sent' })
      const history = new SqliteAgentHistory(getDbConnection(db), 1, () => 3, session.id)
      await history.appendBatch([
        { invocationId: 'segmented-output-inv', turnId: 'segmented-output-turn', sequence: 1, schemaVersion: 1,
          eventId: 'segmented-output-context', idempotencyKey: 'segmented-output-context', kind: 'invocation-context-committed',
          payload: { messages: [
            { id: 'segmented-first', role: 'user', content: firstBody, timestamp: 1 },
            { id: 'segmented-second', role: 'user', content: secondBody, timestamp: 2 },
          ] } },
        { invocationId: 'segmented-output-inv', turnId: 'segmented-output-turn', sequence: 2, schemaVersion: 1,
          eventId: 'segmented-output-terminal', idempotencyKey: 'segmented-output-terminal', kind: 'invocation-completed',
          payload: { status: 'completed' } },
      ], 0)
      getDbConnection(db).prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
      getDbConnection(db).prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
      const processGeneration = advanceProcessGeneration(getDbConnection(db))
      const sliceSamples: Array<{ sourceBytes: number; sourceWorkerDurationMs: number; outcome: string; yielded: boolean; reducerWorkerDurationMs: number;
        maxWorkerHeapUsedBytesAtExit: number | null; maxProcessRssBytesAtExit: number | null;
        maxWorkerHeapUsedBytesPeakSampled: number | null; maxProcessRssBytesPeakSampled: number | null;
        memorySampleIntervalMs: number | null; workerSamples: number }> = []
      const task = createSqliteProjectionBuildTask({ db, dbPath: temp.dbPath, blobRoot: root,
        processGeneration: () => processGeneration, connectionEpoch: () => processGeneration, now: () => 3,
        onSlice: (sample) => { sliceSamples.push(sample) } })
      const host = createSqliteSessionStorageHost(db, { storage: { projectionBlobRoot: root },
        startup: { recoverHistory: async () => ({ interruptedCount: 0, repairFailureCount: 0 }), recoverSessionLedgers: async () => ({ repairFailureCount: 0 }) },
        maintenanceTasks: [task] })
      try {
        await expect(host.storage.ensureChatBodyV1?.({ sessionId: session.id })).resolves.toBeDefined()
        const messages = await readChatMessagesAfterPreparation(host.storage, { sessionId: session.id })
        expect(sliceSamples.some((sample) => sample.sourceBytes >= 16 * 1024 * 1024 &&
          sample.sourceWorkerDurationMs > 0 && sample.outcome === 'checkpointed' && sample.yielded)).toBe(true)
        expect(sliceSamples.some((sample) => sample.reducerWorkerDurationMs > 0 &&
          sample.maxWorkerHeapUsedBytesAtExit !== null && sample.maxProcessRssBytesAtExit !== null &&
          sample.maxWorkerHeapUsedBytesPeakSampled !== null && sample.maxProcessRssBytesPeakSampled !== null &&
          sample.memorySampleIntervalMs === 10 && sample.workerSamples >= 3)).toBe(true)
        expect(messages.map((message) => ({ id: message.id, length: String(message.content).length,
          digest: createHash('sha256').update(String(message.content)).digest('hex') }))).toEqual([
          { id: 'segmented-first', length: firstBody.length, digest: createHash('sha256').update(firstBody).digest('hex') },
          { id: 'segmented-second', length: secondBody.length, digest: createHash('sha256').update(secondBody).digest('hex') },
        ])
      } finally { await host.lifecycle.stop({ deadlineMs: 5_000 }) }
    } finally { db.close(); temp.cleanup() }
  }, 30_000)

  it('publishes the complete canonical-only assistant body when response chunks cross worker slices', async () => {
    const temp = createTempDatabase('sqlite-projection-assistant-chunks-')
    let db = temp.db
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-projection-assistant-chunks-blobs-'))
    try {
      const session = createSession(db, { name: 'canonical-only split assistant', model: 'test' })
      appendMessage(db, { id: 'split-user', sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' })
      appendMessage(db, { id: 'split-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
      createPersistedTurn(db, { turnId: 'split-assistant-turn', requestId: 'split-assistant-request', sessionId: session.id,
        userMessageId: 'split-user', assistantMessageId: 'split-assistant', state: 'executing' })
      getDbConnection(db).prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
      getDbConnection(db).prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE id=?").run('split-assistant')
      const processGeneration = advanceProcessGeneration(getDbConnection(db))
      const history = new SqliteAgentHistory(getDbConnection(db), processGeneration, () => 3, session.id)
      await history.appendBatch([
        { invocationId: 'split-assistant-inv', turnId: 'split-assistant-turn', sequence: 1, schemaVersion: 1,
          eventId: 'split-assistant-context', idempotencyKey: 'split-assistant-context', kind: 'invocation-context-committed',
          payload: { messages: [{ id: 'split-user', role: 'user', timestamp: 1, content: 'question' }] } },
        { invocationId: 'split-assistant-inv', turnId: 'split-assistant-turn', sequence: 2, schemaVersion: 1,
          eventId: 'split-assistant-first', idempotencyKey: 'split-assistant-first', kind: 'model-response-committed',
          payload: { message: { id: 'split-assistant', role: 'assistant', timestamp: 2,
            content: [{ type: 'text', text: 'partial' }], toolCalls: [{ id: 'split-assistant-tool', name: 'lookup', input: {} }] } } },
        { invocationId: 'split-assistant-inv', turnId: 'split-assistant-turn', sequence: 3, schemaVersion: 1,
          eventId: 'split-assistant-tool-started', idempotencyKey: 'split-assistant-tool-started', kind: 'tool-call-started',
          payload: { toolCallId: 'split-assistant-tool', toolName: 'lookup' } },
        { invocationId: 'split-assistant-inv', turnId: 'split-assistant-turn', sequence: 4, schemaVersion: 1,
          eventId: 'split-assistant-tool-finished', idempotencyKey: 'split-assistant-tool-finished', kind: 'tool-call-finished',
          payload: { toolCallId: 'split-assistant-tool', success: true, replayContent: 'lookup result', result: { success: true, data: 'lookup result' } } },
        { invocationId: 'split-assistant-inv', turnId: 'split-assistant-turn', sequence: 5, schemaVersion: 1,
          eventId: 'split-assistant-second', idempotencyKey: 'split-assistant-second', kind: 'model-response-committed',
          payload: { message: { id: 'split-assistant', role: 'assistant', timestamp: 2,
            content: [{ type: 'text', text: ' response' }] } } },
        { invocationId: 'split-assistant-inv', turnId: 'split-assistant-turn', sequence: 6, schemaVersion: 1,
          eventId: 'split-assistant-terminal', idempotencyKey: 'split-assistant-terminal', kind: 'invocation-completed',
          payload: { status: 'completed' } },
      ], 0)

      const scopeKey = encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: CHAT_BODY_PROJECTION_SPEC_VERSION })
      const stateStore = createSqliteProjectionStateStore(db)
      stateStore.ensureInvalid({ sessionId: session.id, scopeKey, sessionGeneration: session.generation, now: 3 })
      let firstHandle: ReturnType<ReturnType<typeof createSqliteProjectionBuildTask>['start']>
      let observePendingCheckpoint!: () => void
      const pendingCheckpoint = new Promise<void>((resolve) => { observePendingCheckpoint = resolve })
      const task = createSqliteProjectionBuildTask({ db, dbPath: temp.dbPath, blobRoot: root,
        processGeneration: () => processGeneration, connectionEpoch: () => processGeneration, now: () => 3,
        limits: { maxRows: 1, maxBytes: 8192 }, maxChunksPerSlice: 1,
        onResult: (_item, result) => {
          if (result.kind === 'checkpointed' && result.checkpoint.nextSequence === 5) {
            observePendingCheckpoint()
            firstHandle?.stop()
          }
        } })
      firstHandle = task.start()!
      try {
        await pendingCheckpoint
        await firstHandle.quiesce()
        expect(JSON.parse(stateStore.readCheckpoint(session.id, scopeKey)!)).toMatchObject({ nextSequence: 5,
          historyReducerStateJson: expect.stringContaining('"contentOffset":16') })
        db.close()

        db = openDatabase(temp.dbPath)
        const nextProcessGeneration = advanceProcessGeneration(getDbConnection(db))
        const reopenedStateStore = createSqliteProjectionStateStore(db)
        const resumedTask = createSqliteProjectionBuildTask({ db, dbPath: temp.dbPath, blobRoot: root,
          processGeneration: () => nextProcessGeneration, connectionEpoch: () => nextProcessGeneration, now: () => 10,
          limits: { maxRows: 1, maxBytes: 8192 }, maxChunksPerSlice: 1 })
        const resumedHandle = resumedTask.start()!
        const publishDeadline = Date.now() + 8_000
        while (reopenedStateStore.get(session.id, scopeKey)?.status !== 'valid' && Date.now() < publishDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        expect(reopenedStateStore.get(session.id, scopeKey)).toMatchObject({ status: 'valid' })
        const cache = getDbConnection(db).prepare('SELECT inline_payload FROM session_projection_cache WHERE session_id=? AND scope_key=?')
          .get(session.id, scopeKey) as { inline_payload: string }
        expect(JSON.parse(cache.inline_payload)).toMatchObject({ messages: [
          { id: 'split-user', role: 'user', content: 'question', timestamp: 1 },
          { id: 'split-assistant', role: 'assistant', content: 'partial response', timestamp: 2 },
        ] })
        resumedHandle.stop()
        await resumedHandle.quiesce()
      } finally { if (db === temp.db) await firstHandle.quiesce(); db.close(); temp.cleanup() }
    } finally { await fs.rm(root, { recursive: true, force: true }); root = undefined }
  })

  it('reopens a file-backed checkpoint under a newer process and publishes the resumed projection', async () => {
    const temp = createTempDatabase('sqlite-projection-task-reopen-')
    let currentDb = temp.db
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-projection-task-blobs-'))
    try {
      const session = createSession(currentDb, { name: 'projection takeover', model: 'test' })
      appendMessage(currentDb, { id: 'projection-reopen-user', sessionId: session.id, role: 'user', content: 'hello', timestamp: 1, status: 'sent' })
      const firstProcessGeneration = advanceProcessGeneration(getDbConnection(currentDb))
      const history = new SqliteAgentHistory(getDbConnection(currentDb), firstProcessGeneration, () => 10, session.id)
      await history.appendBatch([
        { invocationId: 'projection-reopen-inv', turnId: 'projection-reopen-turn', sequence: 1, schemaVersion: 1,
          eventId: 'projection-reopen-context', idempotencyKey: 'projection-reopen-context', kind: 'invocation-context-committed',
          payload: { messages: [{ id: 'projection-reopen-user', role: 'user', content: 'hello', timestamp: 1 }] } },
        { invocationId: 'projection-reopen-inv', turnId: 'projection-reopen-turn', sequence: 2, schemaVersion: 1,
          eventId: 'projection-reopen-terminal', idempotencyKey: 'projection-reopen-terminal', kind: 'invocation-completed',
          payload: { status: 'completed' } },
      ], 0)
      const scopeKey = encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: 1 })
      const stateStore = createSqliteProjectionStateStore(currentDb)
      stateStore.ensureInvalid({ sessionId: session.id, scopeKey, sessionGeneration: session.generation, now: 10 })
      let stopFirstTask!: () => void
      let checkpointSaved!: (checkpointJson: string) => void
      const savedCheckpoint = new Promise<string>((resolve) => { checkpointSaved = resolve })
      const firstTask = createSqliteProjectionBuildTask({ db: currentDb, dbPath: temp.dbPath, blobRoot: root,
        processGeneration: () => firstProcessGeneration, connectionEpoch: () => firstProcessGeneration, now: () => 10,
        limits: { maxRows: 1, maxBytes: 8192 }, maxChunksPerSlice: 1,
        onResult: (_item, result) => { if (result.kind === 'checkpointed') { checkpointSaved(JSON.stringify(result.checkpoint)); stopFirstTask() } } })
      const firstHandle = firstTask.start()!
      stopFirstTask = firstHandle.stop
      const checkpointJson = await savedCheckpoint
      expect(JSON.parse(checkpointJson)).toMatchObject({ nextSequence: 1, processGeneration: firstProcessGeneration })
      await firstHandle.quiesce()
      expect(stateStore.get(session.id, scopeKey)).toMatchObject({ status: 'rebuilding', processGeneration: firstProcessGeneration - 1 })
      expect(JSON.parse(stateStore.readCheckpoint(session.id, scopeKey)!)).toMatchObject({ processGeneration: firstProcessGeneration - 1 })
      currentDb.close()

      currentDb = await import('../database').then(({ openDatabase }) => openDatabase(temp.dbPath))
      const nextProcessGeneration = advanceProcessGeneration(getDbConnection(currentDb))
      const reopenedStateStore = createSqliteProjectionStateStore(currentDb)
      let observeTakeover!: (checkpointJson: string) => void
      const takeoverCheckpoint = new Promise<string>((resolve) => { observeTakeover = resolve })
      const nextTask = createSqliteProjectionBuildTask({ db: currentDb, dbPath: temp.dbPath, blobRoot: root,
        processGeneration: () => nextProcessGeneration, connectionEpoch: () => nextProcessGeneration, now: () => 20,
        limits: { maxRows: 1, maxBytes: 8192 }, maxChunksPerSlice: 1,
        onResult: (_item, result) => { if (result.kind === 'checkpointed' && result.checkpoint.nextSequence === 2) observeTakeover(JSON.stringify(result.checkpoint)) } })
      const nextHandle = nextTask.start()!
      expect(JSON.parse(await takeoverCheckpoint)).toMatchObject({ nextSequence: 2, processGeneration: nextProcessGeneration })
      const publishDeadline = Date.now() + 8_000
      while (reopenedStateStore.get(session.id, scopeKey)?.status !== 'valid' && Date.now() < publishDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(reopenedStateStore.get(session.id, scopeKey)).toMatchObject({ status: 'valid' })
      expect(reopenedStateStore.readCheckpoint(session.id, scopeKey)).toBeNull()
      const cache = getDbConnection(currentDb).prepare('SELECT inline_payload FROM session_projection_cache WHERE session_id=? AND scope_key=?')
        .get(session.id, scopeKey) as { inline_payload: string }
      const published = JSON.parse(cache.inline_payload) as { sessionId: string; messages: Array<Record<string, unknown>> }
      expect(published).toMatchObject({ sessionId: session.id,
        messages: [{ id: 'projection-reopen-user', role: 'user', content: 'hello', timestamp: 1 }] })
      expect(Object.keys(published.messages[0]!).sort()).toEqual(['content', 'id', 'role', 'timestamp'])
      nextHandle.stop()
      await nextHandle.quiesce()
    } finally {
      currentDb.close()
      temp.cleanup()
    }
  })
})
