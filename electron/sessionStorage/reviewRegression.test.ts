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

for (const scenario of ['text-block', 'spilled-text', 'missing-cache'] as const) {
  it(`recovers chat body projection: ${scenario}`, async () => {
    const temp = createTempDatabase('review-projection-')
    const cacheBlobRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-blobs-'))
    const db = temp.db
    let host: ReturnType<typeof createSqliteSessionStorageHost> | undefined
    try {
      const session = createSession(db, { name: 'review', model: 'test' })
      const processGeneration = advanceProcessGeneration(getDbConnection(db))
      const body = scenario === 'spilled-text' ? 'x'.repeat(70 * 1024) : 'hello'
      appendMessage(db, { id: 'a', sessionId: session.id, role: 'assistant', content: body, timestamp: 2, status: 'sent' })

      const history = new SqliteAgentHistory(getDbConnection(db), 1, () => 3, session.id)
      await history.appendBatch([
        {
          invocationId: 'inv', turnId: 'turn', sequence: 1, schemaVersion: 1, eventId: 'context', idempotencyKey: 'context',
          kind: 'invocation-context-committed', payload: { messages: [{ id: 'a', role: 'assistant', timestamp: 2,
            content: scenario === 'text-block' ? [{ type: 'text', text: body }] : body }] }
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
      expect(await host.storage.ensureChatBodyV1!({ sessionId: session.id })).toEqual(expected)
      if (scenario === 'missing-cache') {
        getDbConnection(db).prepare('DELETE FROM session_projection_cache WHERE session_id=?').run(session.id)
        expect(await host.storage.ensureChatBodyV1!({ sessionId: session.id })).toEqual(expected)
      }
    } finally {
      await host?.lifecycle.stop({ deadlineMs: 5_000 })
      temp.cleanup()
      await fs.rm(cacheBlobRoot, { recursive: true, force: true })
    }
  })
}
