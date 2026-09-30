import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { createSession, getDbConnection } from '../database'
import { createAcceptedTurnFromPrepared } from './acceptedTurnContext'
import { commitSessionTranscript } from '../database/sessionTranscript'
import { readAcceptedTurn } from '../database/acceptedTurnStorage'

describe('createAcceptedTurnFromPrepared', () => {
  let db: ReturnType<typeof createMemoryAppDb>
  beforeEach(() => { db = createMemoryAppDb('zh-CN') })
  afterEach(() => db.close())

  it('freezes the prepared identity, execution config, and current transcript version', () => {
    const session = createSession(db, { name: 'accepted-turn' })
    commitSessionTranscript(db, { sessionId: session.id, turnId: 'prior-turn', baseVersion: 0, outcome: 'completed', messages: [{ role: 'user', content: 'prior' }] })
    const config = { lane: 'feishu' as const, skillFragments: ['frozen'] }
    const accepted = createAcceptedTurnFromPrepared(db, {
      turnId: 'remote-turn', requestId: 'remote-request', sessionId: session.id, startToken: 'start-token',
      userMessage: { id: 'accepted-user' }
    }, 'feishu', config)
    config.skillFragments[0] = 'mutated'
    expect(accepted).toMatchObject({ turnId: 'remote-turn', requestId: 'remote-request', sessionId: session.id, lane: 'feishu', startToken: 'start-token', currentUserMessageId: 'accepted-user', transcriptVersion: 1 })
    expect(accepted.config.skillFragments).toEqual(['frozen'])
    expect(Object.isFrozen(accepted)).toBe(true)
    expect(readAcceptedTurn(db, session.id, 'remote-request')).toEqual(accepted)
  })

  it('reuses the original accepted snapshot when the same prepared turn is retried after checkpoint advances', () => {
    const session = createSession(db, { name: 'accepted-turn-retry' })
    const prepared = { turnId: 'retry-turn', requestId: 'retry-request', sessionId: session.id, startToken: 'retry-token', userMessage: { id: 'retry-user' } }
    const first = createAcceptedTurnFromPrepared(db, prepared, 'feishu', { lane: 'feishu', model: 'frozen-model' })
    commitSessionTranscript(db, { sessionId: session.id, turnId: 'preceding-turn', baseVersion: 0, outcome: 'completed', messages: [{ role: 'user', content: 'previous' }] })
    const retried = createAcceptedTurnFromPrepared(db, prepared, 'feishu', { lane: 'feishu', model: 'new-default' })
    expect(retried).toEqual(first)
    expect(retried.transcriptVersion).toBe(0)
    expect(retried.config.model).toBe('frozen-model')
  })

  it('rejects acceptance while the session checkpoint needs reconciliation', () => {
    const session = createSession(db, { name: 'blocked-session' })
    getDbConnection(db).prepare("INSERT INTO session_transcript_checkpoints(session_id,version,last_turn_id,status,updated_at) VALUES(?,0,'blocked-turn','blocked',1)").run(session.id)
    expect(() => createAcceptedTurnFromPrepared(db, {
      turnId: 'new-turn', requestId: 'new-request', sessionId: session.id, startToken: 'token', userMessage: { id: 'user' }
    }, 'wechat', { lane: 'wechat' })).toThrow('SESSION_TRANSCRIPT_RECONCILIATION_REQUIRED')
  })
})
