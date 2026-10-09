import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { createSession } from '../database/operations'
import { appendWakeEvent, claimWakeEvents, listWakeEvents } from '../database/wakeEvents'
import { isRequestLeaseOwner, releaseRemoteSession, resetRunningRemoteAgentRegistryForTests, tryClaimRemoteSession } from './remoteAgentRegistry'

describe('wake event session execution gate', () => {
  afterEach(() => resetRunningRemoteAgentRegistryForTests())

  it('lets only one concurrent continuation or safety recovery hold a session slot and keeps events pending', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'wake-session-gate' }).id
    appendWakeEvent(db, {
      sessionId, type: 'continuation', reasonKey: 'continue:one',
      payloadRef: { kind: 'continuation', continuationId: 'continue:one' }
    })
    appendWakeEvent(db, {
      sessionId, type: 'safety-recovery', reasonKey: 'safety:two',
      payloadRef: { kind: 'safety-approval', approvalId: 'todo-two' }
    })

    const claims = await Promise.all([
      Promise.resolve().then(() => tryClaimRemoteSession(sessionId, 'continuation-run', 3)),
      Promise.resolve().then(() => tryClaimRemoteSession(sessionId, 'safety-recovery-run', 3))
    ])

    expect(claims.filter((claim) => claim === 'ok')).toHaveLength(1)
    expect(claims.filter((claim) => claim === 'session_busy')).toHaveLength(1)
    expect(listWakeEvents(db, sessionId).map(({ status }) => status)).toEqual(['pending', 'pending'])
    db.close()
  })

  it('keeps a safety event pending while the slot is busy and fences stale lease release after takeover', () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'wake-safety-lease' }).id
    const cancel = () => undefined
    const event = appendWakeEvent(db, {
      sessionId, type: 'safety-recovery', reasonKey: 'safety-pending-while-busy',
      payloadRef: { kind: 'safety-approval', approvalId: 'approval-lease' }
    })
    const now = 10_000

    expect(tryClaimRemoteSession(sessionId, 'normal-loop', 2, { now, ttlMs: 1_000 })).toBe('ok')
    expect(tryClaimRemoteSession(sessionId, 'safety-owner-old', 2, { now, ttlMs: 500, cancel })).toBe('session_busy')
    expect(listWakeEvents(db, sessionId).find(({ eventId }) => eventId === event.eventId)?.status).toBe('pending')
    releaseRemoteSession(sessionId, 'normal-loop')
    expect(tryClaimRemoteSession(sessionId, 'safety-owner-old', 2, { now, ttlMs: 500, cancel })).toBe('ok')
    expect(tryClaimRemoteSession(sessionId, 'safety-owner-new', 2, { now: now + 600, ttlMs: 500 })).toBe('ok')

    releaseRemoteSession(sessionId, 'safety-owner-old')
    expect(isRequestLeaseOwner(sessionId, 'safety-owner-new', now + 601)).toBe(true)
    expect(claimWakeEvents(db, { sessionId, runId: 'safety-run-new', ownerId: 'safety-owner-new' }).eventIds)
      .toEqual([event.eventId])
    db.close()
  })
})
