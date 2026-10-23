import { afterEach, describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { createMemoryAppDb, createTempDatabase } from '../database/testHelpers'
import { appendMessage, createPersistedTurn, createSession } from '../database/operations'
import { createSqliteProjectionBuildTask, createSqliteSessionStorageHost } from './sqliteSessionStorage'
import { createSqliteProjectionStateStore } from './infrastructure/sqlite/sessionProjectionStateStore'
import { createSqliteProjectionChatBodyCacheStore } from './infrastructure/sqlite/sessionProjectionStateStore'
import { readProjectionChatBodyCache } from './application/projectionChatBodyCacheReader'
import { CHAT_BODY_PROJECTION_SPEC_VERSION, encodeProjectionScopeKey } from './domain/scopeKey'
import { SqliteAgentHistory } from '../runtime/sqliteAgentHistory'
import { advanceProcessGeneration } from '../database/processGeneration'
import { getDbConnection } from '../database/sqliteStore'
import { openDatabase } from '../database'
import { createSessionProjectionBlobStore } from './infrastructure/sqlite/sessionProjectionBlobStore'
import { readChatMessagesAfterPreparation } from './application/readChatMessages'

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
      const history = new SqliteAgentHistory(getDbConnection(db), 1, () => 3, session.id)
      await history.appendBatch([
        { invocationId: 'projection-chat-body-inv', turnId: 'projection-chat-body-turn', sequence: 1, schemaVersion: 1,
          eventId: 'projection-chat-body-context', idempotencyKey: 'projection-chat-body-context', kind: 'invocation-context-committed',
          payload: { messages: [{ id: 'projection-chat-body-user', role: 'user', content: 'same body', timestamp: 11 }] } },
        { invocationId: 'projection-chat-body-inv', turnId: 'projection-chat-body-turn', sequence: 2, schemaVersion: 1,
          eventId: 'projection-chat-body-terminal', idempotencyKey: 'projection-chat-body-terminal', kind: 'invocation-completed',
          payload: { status: 'completed' } },
      ], 0)
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
        expect(ensured).toEqual([{ id: 'projection-chat-body-user', role: 'user', content: 'same body', timestamp: 11 }])
        expect(createSqliteProjectionStateStore(db).get(session.id, scopeKey)).toMatchObject({ status: 'valid' })
        const cache = getDbConnection(db).prepare('SELECT inline_payload FROM session_projection_cache WHERE session_id=? AND scope_key=?')
          .get(session.id, scopeKey) as { inline_payload: string }
        const published = JSON.parse(cache.inline_payload) as { messages: Array<Record<string, unknown>> }
        expect(published.messages).toEqual([{ id: 'projection-chat-body-user', role: 'user', content: 'same body', timestamp: 11 }])
        expect(Object.keys(published.messages[0]!).sort()).toEqual(['content', 'id', 'role', 'timestamp'])
        const cacheStore = createSqliteProjectionChatBodyCacheStore(db)
        await expect(readProjectionChatBodyCache({ sessionId: session.id, sessionGeneration: session.generation, scopeKey, specVersion: CHAT_BODY_PROJECTION_SPEC_VERSION },
          cacheStore, createSessionProjectionBlobStore(root)))
          .resolves.toEqual({ kind: 'ready', messages: published.messages })
        expect(ensured).toEqual(published.messages)
      } finally { await host.lifecycle.stop({ deadlineMs: 5_000 }) }
    } finally { db.close(); temp.cleanup() }
  })

  it('keeps legacy authority readable when projection preparation is deferred for an oversized History event', async () => {
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
      const task = createSqliteProjectionBuildTask({ db, dbPath: temp.dbPath, blobRoot: root,
        processGeneration: () => processGeneration, connectionEpoch: () => processGeneration, now: () => 3 })
      const host = createSqliteSessionStorageHost(db, { storage: { projectionBlobRoot: root },
        startup: { recoverHistory: async () => ({ interruptedCount: 0, repairFailureCount: 0 }), recoverSessionLedgers: async () => ({ repairFailureCount: 0 }) },
        maintenanceTasks: [task] })
      try {
        await expect(host.storage.ensureChatBodyV1?.({ sessionId: session.id })).rejects.toThrow('PROJECTION_PREPARATION_DEFERRED_LARGE')
        expect(await readChatMessagesAfterPreparation(host.storage, { sessionId: session.id }))
          .toMatchObject([{ id: 'deferred-legacy-user', content: 'keep-serving-legacy' }])
      } finally { await host.lifecycle.stop({ deadlineMs: 5_000 }) }
    } finally { db.close(); temp.cleanup() }
  })

  it('keeps canonical-only message bodies readable when one chunk of message facts exceeds the projection budget', async () => {
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
        await expect(host.storage.ensureChatBodyV1?.({ sessionId: session.id })).rejects.toThrow('PROJECTION_PREPARATION_DEFERRED_LARGE')
        await expect(readChatMessagesAfterPreparation(host.storage, { sessionId: session.id }))
          .resolves.toMatchObject([{ id: 'deferred-facts-user', content: body }])
      } finally { await host.lifecycle.stop({ deadlineMs: 5_000 }) }
    } finally { db.close(); temp.cleanup() }
  })

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
