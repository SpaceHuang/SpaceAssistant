import { expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { appendMessage, createSession } from '../database/operations'
import { createTempDatabase } from '../database/testHelpers'
import { advanceProcessGeneration } from '../database/processGeneration'
import { getDbConnection } from '../database/sqliteStore'
import { SqliteAgentHistory } from '../runtime/sqliteAgentHistory'
import { createSqliteProjectionBuildTask, createSqliteSessionStorageHost } from './sqliteSessionStorage'
import { readChatMessagesAfterPreparation } from './application/readChatMessages'

for (const scenario of ['image', 'tool'] as const) {
  it(`recovers chat body projection: ${scenario}`, async () => {
    const temp = createTempDatabase('review-projection-')
    const cacheBlobRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-blobs-'))
    const db = temp.db
    let host: ReturnType<typeof createSqliteSessionStorageHost> | undefined
    try {
      const session = createSession(db, { name: 'review', model: 'test' })
      const processGeneration = advanceProcessGeneration(getDbConnection(db))
      const body = 'hello'
      appendMessage(db, { id: 'a', sessionId: session.id, role: 'assistant', content: body, timestamp: 2, status: 'sent' })

      const history = new SqliteAgentHistory(getDbConnection(db), 1, () => 3, session.id)
      await history.appendBatch([
        {
          invocationId: 'inv', turnId: 'turn', sequence: 1, schemaVersion: 1, eventId: 'context', idempotencyKey: 'context',
          kind: 'invocation-context-committed', payload: { messages: [{ id: 'a', role: 'assistant', timestamp: 2,
            content: [{ type: 'text', text: body }, ...(scenario === 'image' ? [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }] : [])], ...(scenario === 'tool' ? { toolCalls: [{ id: 'tool1', name: 'lookup', input: {} }] } : {}) }, ...(scenario === 'tool' ? [{ role: 'tool', toolCallId: 'tool1', content: 'done', isError: false }] : [])] }
        },
        { invocationId: 'inv', turnId: 'turn', sequence: 2, schemaVersion: 1, eventId: 'end', idempotencyKey: 'end',
          kind: 'invocation-completed', payload: { status: 'completed' } }
      ], 0)

      const task = createSqliteProjectionBuildTask({ db, dbPath: temp.dbPath, blobRoot: cacheBlobRoot,
        processGeneration: () => processGeneration, connectionEpoch: () => processGeneration, now: () => 3 })
      host = createSqliteSessionStorageHost(db, {
        storage: { projectionBlobRoot: cacheBlobRoot },
        startup: { recoverHistory: async () => ({ interruptedCount: 0, repairFailureCount: 0 }),
          recoverSessionLedgers: async () => ({ repairFailureCount: 0 }) },
        maintenanceTasks: [task]
      })

      const expected = [{ id: 'a', role: 'assistant', content: body, timestamp: 2 }]
      expect(await readChatMessagesAfterPreparation(host.storage, { sessionId: session.id })).toMatchObject(expected)

    } finally {
      await host?.lifecycle.stop({ deadlineMs: 5_000 })
      temp.cleanup()
      await fs.rm(cacheBlobRoot, { recursive: true, force: true })
    }
  })
}
