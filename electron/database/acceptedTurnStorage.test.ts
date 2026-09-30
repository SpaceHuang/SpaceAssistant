import { describe, expect, it } from 'vitest'
import { createAcceptedTurn } from '../../src/shared/acceptedTurn'
import { createMemoryAppDb } from './testHelpers'
import { getDbConnection } from './sqliteStore'
import { acceptTurnContext, readAcceptedTurn } from './acceptedTurnStorage'

const makeTurn = (input: Partial<Parameters<typeof createAcceptedTurn>[0]> = {}) => createAcceptedTurn({
  turnId: 'turn-1', requestId: 'request-1', sessionId: 'session-1', lane: 'desktop', startToken: 'start-1',
  currentUserMessageId: 'user-1', transcriptVersion: 0, config: { lane: 'desktop', model: 'model-a' }, ...input
})

describe('accepted turn durable identity', () => {
  it('persists immutable AcceptedTurn snapshots and resolves the request mapping after reopen', () => {
    const db = createMemoryAppDb()
    const accepted = makeTurn()
    expect(acceptTurnContext(db, accepted)).toEqual(accepted)
    expect(acceptTurnContext(db, accepted)).toEqual(accepted)
    expect(readAcceptedTurn(db, 'session-1', 'request-1')).toEqual(accepted)
    expect(getDbConnection(db).prepare('SELECT turn_id FROM accepted_turn_contexts WHERE session_id=? AND request_id=?').get('session-1', 'request-1'))
      .toEqual({ turn_id: 'turn-1' })
    db.close()
  })

  it('rejects a request id or turn id that was already bound to another accepted identity', () => {
    const db = createMemoryAppDb()
    acceptTurnContext(db, makeTurn())
    expect(() => acceptTurnContext(db, makeTurn({ turnId: 'turn-2' }))).toThrow('ACCEPTED_TURN_IDENTITY_CONFLICT')
    expect(() => acceptTurnContext(db, makeTurn({ requestId: 'request-2' }))).toThrow('ACCEPTED_TURN_IDENTITY_CONFLICT')
    expect(readAcceptedTurn(db, 'session-1', 'request-1')?.turnId).toBe('turn-1')
    db.close()
  })

  it('reuses the originally frozen snapshot on duplicate acceptance and rejects changed prepared identity', () => {
    const db = createMemoryAppDb()
    const original = makeTurn()
    expect(acceptTurnContext(db, original)).toEqual(original)
    const retried = makeTurn({ transcriptVersion: 8, config: { lane: 'desktop', model: 'changed-model' } })
    expect(acceptTurnContext(db, retried)).toEqual(original)
    expect(() => acceptTurnContext(db, makeTurn({ currentUserMessageId: 'other-user' }))).toThrow('ACCEPTED_TURN_IDENTITY_CONFLICT')
    db.close()
  })
})
