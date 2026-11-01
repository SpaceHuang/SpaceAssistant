import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { createSession } from '../database/operations'
import { commitSessionTranscript } from '../database/sessionTranscript'
import { getDbConnection } from '../database/sqliteStore'
import { createSessionExecutionStore } from './execution'

describe('hosted session context cache', () => {
  it('reuses only an exact generation, version, and scope match', async () => {
    const db = createMemoryAppDb()
    try {
      const session = createSession(db, { name: 'context cache', model: 'test' })
      const execution = createSessionExecutionStore(db)
      const cold = await execution.prepareHostedContext({ sessionId: session.id, scopeKey: 'session' })
      expect(cold).toMatchObject({ version: 0, status: 'ready', warm: false, baselineRequired: false })
      expect(execution.commitHostedContext({ sessionId: session.id, generation: cold.generation, scopeKey: 'session', context: cold.context })).toBe(true)

      expect(await execution.prepareHostedContext({ sessionId: session.id, scopeKey: 'session' })).toMatchObject({ warm: true })
      expect(await execution.prepareHostedContext({ sessionId: session.id, scopeKey: 'track:other' })).toMatchObject({ warm: false })

      const scoped = await execution.prepareHostedContext({ sessionId: session.id, scopeKey: 'session' })
      expect(execution.commitHostedContext({ sessionId: session.id, generation: scoped.generation, scopeKey: 'session', context: scoped.context })).toBe(true)
      getDbConnection(db).prepare('UPDATE sessions SET generation=? WHERE id=?').run('changed-generation', session.id)
      expect(await execution.prepareHostedContext({ sessionId: session.id, scopeKey: 'session' }))
        .toMatchObject({ generation: 'changed-generation', warm: false })

      const afterGeneration = await execution.prepareHostedContext({ sessionId: session.id, scopeKey: 'session' })
      expect(execution.commitHostedContext({ sessionId: session.id, generation: scoped.generation, scopeKey: 'session', context: afterGeneration.context })).toBe(false)

      expect(commitSessionTranscript(db, { sessionId: session.id, turnId: 'context-cache-commit', baseVersion: 0,
        outcome: 'completed', messages: [{ role: 'user', content: 'advance version' }] })).toMatchObject({ committed: true, version: 1 })
      expect(await execution.prepareHostedContext({ sessionId: session.id, scopeKey: 'session' })).toMatchObject({ version: 1, warm: false, baselineRequired: true })
    } finally {
      db.close()
    }
  })
})
