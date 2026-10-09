import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from './testHelpers'
import { getDbConnection } from './sqliteStore'
import { createSession } from './operations'
import { ackWakeEvent, ackWakeEventInRun, appendWakeEvent, claimWakeEvent, claimWakeEvents, continueWorkflow, finalizeWakeEvents, listWakeEvents, waitForEvent } from './wakeEvents'

describe('wake event persistence', () => {
  it('returns the original event for a repeated reasonKey without inserting a second row', () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'wake-session-1' }).id
    const input = {
      sessionId,
      type: 'im-inbound' as const,
      reasonKey: 'feishu:message-001',
      payloadRef: { kind: 'im-inbox-message' as const, messageId: 'message-001' }
    }

    const first = appendWakeEvent(db, input)
    const retry = appendWakeEvent(db, input)

    expect(retry.eventId).toBe(first.eventId)
    expect(retry.duplicate).toBe(true)
    expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM wake_events WHERE reason_key=?').get(input.reasonKey))
      .toEqual({ count: 1 })
    db.close()
  })

  it('does not list, claim, or ack another session\'s wake event', () => {
    const db = createMemoryAppDb()
    const ownerSessionId = createSession(db, { name: 'wake-owner-session' }).id
    const otherSessionId = createSession(db, { name: 'wake-other-session' }).id
    const event = appendWakeEvent(db, {
      sessionId: ownerSessionId,
      type: 'continuation',
      reasonKey: 'workflow:continue:1',
      payloadRef: { kind: 'continuation', continuationId: 'continue-1' }
    })

    expect(listWakeEvents(db, otherSessionId)).toEqual([])
    expect(listWakeEvents(db, ownerSessionId).map(({ eventId }) => eventId)).toEqual([event.eventId])
    expect(claimWakeEvent(db, { sessionId: otherSessionId, eventId: event.eventId, ownerId: 'other-run' })).toBeNull()
    expect(ackWakeEvent(db, { sessionId: otherSessionId, eventId: event.eventId, ownerId: 'other-run' })).toBe(false)
    expect(getDbConnection(db).prepare('SELECT status FROM wake_events WHERE event_id=?').get(event.eventId))
      .toEqual({ status: 'pending' })
    expect(claimWakeEvent(db, { sessionId: ownerSessionId, eventId: event.eventId, ownerId: 'owner-run' })).not.toBeNull()
    expect(ackWakeEvent(db, { sessionId: ownerSessionId, eventId: event.eventId, ownerId: 'other-run' })).toBe(false)
    expect(ackWakeEvent(db, { sessionId: ownerSessionId, eventId: event.eventId, ownerId: 'owner-run' })).toBe(true)
    expect(getDbConnection(db).prepare('SELECT status FROM wake_events WHERE event_id=?').get(event.eventId))
      .toEqual({ status: 'acked' })
    db.close()
  })

  it('atomically claims the currently pending set and binds that exact set to one runId', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'wake-claim-batch' }).id
    const events = ['batch-a', 'batch-b', 'batch-c'].map((reasonKey) => appendWakeEvent(db, {
      sessionId,
      type: 'continuation' as const,
      reasonKey,
      payloadRef: { kind: 'continuation' as const, continuationId: reasonKey }
    }))

    const claims = await Promise.all(Array.from({ length: 4 }, (_, index) => Promise.resolve().then(() =>
      claimWakeEvents(db, { sessionId, runId: `run-${index}`, ownerId: `owner-${index}` })
    )))
    const successful = claims.filter((claim) => claim.eventIds.length > 0)

    expect(successful).toHaveLength(1)
    expect(successful[0]?.runId).toMatch(/^run-/)
    expect(successful[0]?.eventIds.slice().sort()).toEqual(events.map(({ eventId }) => eventId).sort())
    expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM wake_events WHERE session_id=? AND status=\'claimed\' AND run_id=?')
      .get(sessionId, successful[0]!.runId)).toEqual({ count: 3 })
    db.close()
  })

  it('only lets the run that claimed an event acknowledge that event', () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'wake-run-ack' }).id
    const event = appendWakeEvent(db, {
      sessionId, type: 'continuation', reasonKey: 'ack-run-event',
      payloadRef: { kind: 'continuation', continuationId: 'ack-run-event' }
    })
    claimWakeEvents(db, { sessionId, runId: 'run-owner', ownerId: 'loop-owner' })

    expect(ackWakeEventInRun(db, {
      sessionId, eventId: event.eventId, runId: 'different-run', ownerId: 'loop-owner'
    })).toBe(false)
    expect(ackWakeEventInRun(db, {
      sessionId, eventId: event.eventId, runId: 'run-owner', ownerId: 'loop-owner'
    })).toBe(true)
    db.close()
  })

  it('reclaims an expired run lease and fences acknowledgements from the prior run', () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'wake-lease-reclaim' }).id
    const event = appendWakeEvent(db, {
      sessionId, type: 'continuation', reasonKey: 'wake-lease-event',
      payloadRef: { kind: 'continuation', continuationId: 'wake-lease-event' }
    })
    claimWakeEvents(db, { sessionId, runId: 'expired-run', ownerId: 'expired-owner', leaseDurationMs: 10 })
    getDbConnection(db).prepare('UPDATE wake_events SET lease_expires_at=? WHERE event_id=?')
      .run(Date.now() - 1, event.eventId)

    const reclaimed = claimWakeEvents(db, { sessionId, runId: 'replacement-run', ownerId: 'replacement-owner' })
    expect(reclaimed.eventIds).toContain(event.eventId)
    expect(ackWakeEventInRun(db, {
      sessionId, eventId: event.eventId, runId: 'expired-run', ownerId: 'expired-owner'
    })).toBe(false)
    expect(ackWakeEventInRun(db, {
      sessionId, eventId: event.eventId, runId: 'replacement-run', ownerId: 'replacement-owner'
    })).toBe(true)
    db.close()
  })

  it('keeps an inbound event appended during a run pending when that run finalizes', () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'wake-interleaved' }).id
    const initial = appendWakeEvent(db, {
      sessionId, type: 'im-inbound', reasonKey: 'inbound-before-run',
      payloadRef: { kind: 'im-inbox-message', messageId: 'inbound-before-run' }
    })
    const claim = claimWakeEvents(db, { sessionId, runId: 'interleaved-run', ownerId: 'interleaved-owner' })
    const arrivedDuringRun = appendWakeEvent(db, {
      sessionId, type: 'im-inbound', reasonKey: 'inbound-during-run',
      payloadRef: { kind: 'im-inbox-message', messageId: 'inbound-during-run' }
    })

    expect(claim.eventIds).toEqual([initial.eventId])
    expect(finalizeWakeEvents(db, {
      sessionId, runId: 'interleaved-run', ownerId: 'interleaved-owner', eventIds: claim.eventIds
    })).toEqual([initial.eventId])
    expect(getDbConnection(db).prepare('SELECT status FROM wake_events WHERE event_id=?').get(arrivedDuringRun.eventId))
      .toEqual({ status: 'pending' })
    db.close()
  })

  it('keeps a continuation created during a run outside that run\'s finalize set', () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'wake-continuation-during-run' }).id
    const initial = appendWakeEvent(db, {
      sessionId, type: 'continuation', reasonKey: 'initial-continuation',
      payloadRef: { kind: 'continuation', continuationId: 'initial-continuation' }
    })
    const claim = claimWakeEvents(db, { sessionId, runId: 'continuation-run', ownerId: 'continuation-owner' })
    const continuation = appendWakeEvent(db, {
      sessionId, type: 'continuation', reasonKey: 'new-continuation',
      payloadRef: { kind: 'continuation', continuationId: 'new-continuation' }
    })

    expect(claim.eventIds).toEqual([initial.eventId])
    expect(finalizeWakeEvents(db, {
      sessionId, runId: 'continuation-run', ownerId: 'continuation-owner', eventIds: claim.eventIds
    })).toEqual([initial.eventId])
    expect(getDbConnection(db).prepare('SELECT status FROM wake_events WHERE event_id=?').get(continuation.eventId))
      .toEqual({ status: 'pending' })
    db.close()
  })

  it('creates a pending continuation for an empty Inbox so a later dispatch can start a Loop', () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'wake-empty-inbox-continuation' }).id
    expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id=?').get(sessionId))
      .toEqual({ count: 0 })

    const continuation = continueWorkflow(db, { sessionId, reasonKey: 'skill:continue:next-step' })
    const retry = continueWorkflow(db, { sessionId, reasonKey: 'skill:continue:next-step' })

    expect(continuation.duplicate).toBe(false)
    expect(retry).toEqual({ eventId: continuation.eventId, duplicate: true })
    expect(listWakeEvents(db, sessionId)).toMatchObject([{
      eventId: continuation.eventId,
      reasonKey: 'skill:continue:next-step',
      type: 'continuation',
      status: 'pending'
    }])
    expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM wake_event_outbox WHERE session_id=?').get(sessionId))
      .toEqual({ count: 1 })
    db.close()
  })

  it('waits by finalizing only runtime-supplied claimed IDs and has no cursor input', () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'wake-wait-boundary' }).id
    const claimedEvent = appendWakeEvent(db, {
      sessionId, type: 'continuation', reasonKey: 'wait-claimed',
      payloadRef: { kind: 'continuation', continuationId: 'wait-claimed' }
    })
    const run = claimWakeEvents(db, { sessionId, runId: 'wait-boundary-run', ownerId: 'wait-boundary-owner' })
    const laterEvent = appendWakeEvent(db, {
      sessionId, type: 'im-inbound', reasonKey: 'wait-unclaimed',
      payloadRef: { kind: 'im-inbox-message', messageId: 'wait-unclaimed' }
    })

    // @ts-expect-error Model-provided cursor/event generation must not be accepted by waitForEvent.
    const waitResult = waitForEvent(db, { sessionId, runId: run.runId, ownerId: 'wait-boundary-owner', eventIds: [claimedEvent.eventId], cursor: 999 })
    expect(waitResult).toEqual([claimedEvent.eventId])
    expect(getDbConnection(db).prepare('SELECT status FROM wake_events WHERE event_id=?').get(laterEvent.eventId))
      .toEqual({ status: 'pending' })
    db.close()
  })
})
