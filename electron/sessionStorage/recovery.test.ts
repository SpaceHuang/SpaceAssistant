import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { createSession } from '../database/operations'
import { getDbConnection } from '../database'
import { claimSessionExecution } from '../database/sessionTranscript'
import { createSqliteStartupHistoryRecoveryBindings } from './infrastructure/sqlite/sessionHistoryRecoveryHost'
import { createSessionTranscriptRecoveryAdapter } from './recoveryDatabaseAdapter'
import { createSqliteSessionStorage } from './sqliteSessionStorage'
import type { SessionHistoryRecoveryOptions } from './public/ports'

describe('session recovery boundaries', () => {
  it('keeps transcript recovery scoped to the requested session', () => {
    const db = createMemoryAppDb()
    claimSessionExecution(db, { sessionId: 'adapter-target', turnId: 'stale', ownerId: 'old-owner', now: 1 })
    claimSessionExecution(db, { sessionId: 'adapter-other', turnId: 'keep', ownerId: 'other-owner', now: 2 })

    expect(createSessionTranscriptRecoveryAdapter(db).recoverTarget('adapter-target', 3)).toMatchObject({ status: 'ready', releasedUnstarted: 1 })
    expect(getDbConnection(db).prepare('SELECT status FROM session_execution_claims WHERE session_id=?').get('adapter-other'))
      .toEqual({ status: 'claimed' })
    db.close()
  })

  it('keeps startup History recovery explicit and separate from session storage availability', async () => {
    const db = createMemoryAppDb()
    try {
      const options: SessionHistoryRecoveryOptions = { onSessionLocationResolveError: () => undefined }
      const history = createSqliteStartupHistoryRecoveryBindings(db)
      expectTypeOf(history.recoverInterruptedInvocations).parameter(0).toEqualTypeOf<SessionHistoryRecoveryOptions | undefined>()
      expect(history.getStartupRecoveryWorkSummary()).toMatchObject({ hasWork: false })
      await expect(history.classifyLegacyProjectionRepairs(10)).resolves.toMatchObject({ complete: true })
      expect(options).toBeDefined()

      const session = createSession(db, { name: 'no global recovery' })
      const storage = createSqliteSessionStorage(db)
      expect(storage).not.toHaveProperty('recovery')
      expect(storage.availability.inspect(session.id)).toMatchObject({ content: { state: 'readable' }, execution: { state: 'ready' } })
    } finally {
      db.close()
    }
  })
})
