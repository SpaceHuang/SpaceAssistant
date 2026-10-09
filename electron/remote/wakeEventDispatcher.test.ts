import { describe, expect, it, vi } from 'vitest'
import { createMemoryAppDb, createTempDatabase } from '../database/testHelpers'
import { createSession } from '../database/operations'
import { appendWakeEvent, continueWorkflow, listWakeEvents, readWakeEventRetryState } from '../database/wakeEvents'
import { getDbConnection } from '../database/sqliteStore'
import { openDatabase } from '../database'
import { appendImInboxMessageWithWakeEvent, claimImInboxMessage, releaseImInboxMessage } from '../database/imInbox'
import { buildImQueueScope } from '../../src/shared/queueScope'
import { createWakeEventRetryClock } from './wakeEventRetryPolicy'
import { createWakeEventDispatcher, type WakeEventLoopInput } from './wakeEventDispatcher'
import { claimQueuedTurnAtomicallyInScope, createQueueInputReceiptInScope } from '../database/operations'
import { queueInputFingerprint } from '../queueInputFingerprint'
import { resetRunningRemoteAgentRegistryForTests, tryClaimRemoteSession, releaseRemoteSession } from './remoteAgentRegistry'

describe('wake event dispatcher', () => {
  it('retries a durable wake after an inbound lease releases the session', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'dispatcher-busy-inbound' }).id
    const event = appendWakeEvent(db, {
      sessionId, type: 'im-inbound', reasonKey: 'dispatcher-busy-inbound',
      payloadRef: { kind: 'im-inbox-message', messageId: 'dispatcher-busy-inbound' }
    })
    const inboundOwner = 'inbound-owner'
    expect(tryClaimRemoteSession(sessionId, inboundOwner, 2)).toBe('ok')
    const scheduled: Array<() => void> = []
    const launchLoop = vi.fn(async () => undefined)
    const dispatcher = createWakeEventDispatcher({
      db, maxParallel: 2, launchLoop,
      scheduleRetry: (_delay, callback) => { scheduled.push(callback) }
    })

    await dispatcher.dispatchSession(sessionId)
    expect(launchLoop).not.toHaveBeenCalled()
    expect(scheduled).toHaveLength(1)
    expect(listWakeEvents(db, sessionId).find(({ eventId }) => eventId === event.eventId)?.status).toBe('pending')

    releaseRemoteSession(sessionId, inboundOwner)
    scheduled[0]?.()
    await vi.waitFor(() => expect(launchLoop).toHaveBeenCalledTimes(1))
    expect(listWakeEvents(db, sessionId).find(({ eventId }) => eventId === event.eventId)?.status).toBe('acked')
    resetRunningRemoteAgentRegistryForTests()
    db.close()
  })

  it('cancels scheduled retries on dispose and ignores callbacks fired after disposal', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'dispatcher-dispose' }).id
    appendWakeEvent(db, { sessionId, type: 'im-inbound', reasonKey: 'dispatcher-dispose',
      payloadRef: { kind: 'im-inbox-message', messageId: 'dispatcher-dispose' } })
    expect(tryClaimRemoteSession(sessionId, 'dispose-owner', 2)).toBe('ok')
    let retry!: () => void
    const launchLoop = vi.fn(async () => undefined)
    const onError = vi.fn()
    const dispatcher = createWakeEventDispatcher({ db, maxParallel: 2, launchLoop, onError,
      scheduleRetry: (_delay, callback) => { retry = callback } })

    await dispatcher.dispatchSession(sessionId)
    await dispatcher.dispose()
    db.close()
    retry()
    await Promise.resolve()

    expect(launchLoop).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    resetRunningRemoteAgentRegistryForTests()
  })

  it('reports errors from scheduled retry callbacks instead of creating unhandled rejections', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'dispatcher-retry-error' }).id
    appendWakeEvent(db, { sessionId, type: 'im-inbound', reasonKey: 'dispatcher-retry-error',
      payloadRef: { kind: 'im-inbox-message', messageId: 'dispatcher-retry-error' } })
    expect(tryClaimRemoteSession(sessionId, 'retry-error-owner', 2)).toBe('ok')
    let retry!: () => void
    const onError = vi.fn()
    const dispatcher = createWakeEventDispatcher({ db, maxParallel: 2, launchLoop: vi.fn(async () => undefined), onError,
      scheduleRetry: (_delay, callback) => { retry = callback } })

    await dispatcher.dispatchSession(sessionId)
    db.close()
    retry()
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Database connection is closed' })))
    await dispatcher.dispose()
    resetRunningRemoteAgentRegistryForTests()
  })

  it('starts one Loop for a new event in an idle session and ignores duplicate dispatch signals', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'dispatcher-idle' }).id
    const event = appendWakeEvent(db, {
      sessionId, type: 'im-inbound', reasonKey: 'dispatcher-message-1',
      payloadRef: { kind: 'im-inbox-message', messageId: 'dispatcher-message-1' }
    })
    const launchLoop = vi.fn(async () => undefined)
    const dispatcher = createWakeEventDispatcher({ db, maxParallel: 2, launchLoop })

    await dispatcher.dispatchSession(sessionId)
    await dispatcher.dispatchSession(sessionId)

    expect(launchLoop).toHaveBeenCalledTimes(1)
    expect(launchLoop).toHaveBeenCalledWith(expect.objectContaining({ sessionId, eventIds: [event.eventId] }))
    db.close()
  })

  it('persists an event arriving during a Loop without starting a concurrent Loop', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'dispatcher-running' }).id
    appendWakeEvent(db, {
      sessionId, type: 'im-inbound', reasonKey: 'dispatcher-before-run',
      payloadRef: { kind: 'im-inbox-message', messageId: 'dispatcher-before-run' }
    })
    let finishLoop!: () => void
    let activeLoops = 0
    let maxActiveLoops = 0
    const launchLoop = vi.fn(async () => {
      activeLoops++
      maxActiveLoops = Math.max(maxActiveLoops, activeLoops)
      if (launchLoop.mock.calls.length === 1) {
        await new Promise<void>((resolve) => { finishLoop = resolve })
      }
      activeLoops--
    })
    const dispatcher = createWakeEventDispatcher({ db, maxParallel: 2, launchLoop })
    const firstDispatch = dispatcher.dispatchSession(sessionId)
    await vi.waitFor(() => expect(launchLoop).toHaveBeenCalledTimes(1))

    const duringRun = appendWakeEvent(db, {
      sessionId, type: 'im-inbound', reasonKey: 'dispatcher-during-run',
      payloadRef: { kind: 'im-inbox-message', messageId: 'dispatcher-during-run' }
    })
    const secondDispatch = dispatcher.dispatchSession(sessionId)
    await Promise.resolve()

    expect(launchLoop).toHaveBeenCalledTimes(1)
    expect(maxActiveLoops).toBe(1)
    expect(getDbConnection(db).prepare('SELECT status FROM wake_events WHERE event_id=?').get(duringRun.eventId))
      .toEqual({ status: 'pending' })
    finishLoop()
    await Promise.all([firstDispatch, secondDispatch])
    expect(launchLoop).toHaveBeenCalledTimes(2)
    expect(maxActiveLoops).toBe(1)
    db.close()
  })

  it('finalizes only each run\'s claimed event IDs and dispatches an event that arrived during the prior run', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'dispatcher-finalize-set' }).id
    const first = appendWakeEvent(db, {
      sessionId, type: 'im-inbound', reasonKey: 'dispatcher-finalize-first',
      payloadRef: { kind: 'im-inbox-message', messageId: 'dispatcher-finalize-first' }
    })
    let later: ReturnType<typeof appendWakeEvent> | undefined
    const launchLoop = vi.fn(async ({ eventIds }: { eventIds: string[] }) => {
      if (eventIds.includes(first.eventId)) {
        later = appendWakeEvent(db, {
          sessionId, type: 'continuation', reasonKey: 'dispatcher-finalize-later',
          payloadRef: { kind: 'continuation', continuationId: 'dispatcher-finalize-later' }
        })
      }
    })
    const dispatcher = createWakeEventDispatcher({ db, maxParallel: 2, launchLoop })

    await dispatcher.dispatchSession(sessionId)

    expect(launchLoop).toHaveBeenCalledTimes(2)
    expect(launchLoop.mock.calls[0]?.[0].eventIds).toEqual([first.eventId])
    expect(launchLoop.mock.calls[1]?.[0].eventIds).toEqual([later?.eventId])
    expect(listWakeEvents(db, sessionId).every(({ status }) => status === 'acked')).toBe(true)
    expect(listWakeEvents(db, sessionId).map(({ eventId }) => eventId)).toContain(first.eventId)
    expect(listWakeEvents(db, sessionId).map(({ eventId }) => eventId)).toContain(later?.eventId)
    db.close()
  })

  it('recovers a persisted pre-dispatch event after database reopen and retries continuation idempotently', async () => {
    const temp = createTempDatabase('wake-dispatch-restart-')
    const sessionId = createSession(temp.db, { name: 'dispatcher-restart' }).id
    const event = appendWakeEvent(temp.db, {
      sessionId, type: 'im-inbound', reasonKey: 'restart-before-dispatch',
      payloadRef: { kind: 'im-inbox-message', messageId: 'restart-before-dispatch' }
    })
    const firstContinuation = continueWorkflow(temp.db, { sessionId, reasonKey: 'restart:continue:stable' })
    temp.db.close()

    const reopened = openDatabase(temp.dbPath)
    const retryContinuation = continueWorkflow(reopened, { sessionId, reasonKey: 'restart:continue:stable' })
    const launchLoop = vi.fn(async (_input: WakeEventLoopInput) => undefined)
    const dispatcher = createWakeEventDispatcher({ db: reopened, maxParallel: 2, launchLoop })
    await dispatcher.dispatchSession(sessionId)

    expect(retryContinuation).toEqual({ eventId: firstContinuation.eventId, duplicate: true })
    expect(launchLoop).toHaveBeenCalledTimes(1)
    expect(launchLoop.mock.calls[0]?.[0].eventIds).toContain(event.eventId)
    expect(launchLoop.mock.calls[0]?.[0].eventIds).toContain(firstContinuation.eventId)
    expect(listWakeEvents(reopened, sessionId).every(({ status }) => status === 'acked')).toBe(true)
    reopened.close()
    temp.cleanup()
  })

  it('does not spin on a released pending Inbox message and wakes again only for a new event', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'dispatcher-wait-e2e' }).id
    const queueScope = buildImQueueScope('feishu', 'dispatcher-wait-e2e') as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>
    const firstMessage = appendImInboxMessageWithWakeEvent(db, {
      sessionId, channel: 'feishu', queueScope,
      channelMessageId: 'dispatcher-wait-first', content: 'please wait'
    })
    const launchLoop = vi.fn(async ({ ownerId }: { ownerId: string }) => {
      expect(claimImInboxMessage(db, { queueScope, messageId: firstMessage.messageId, ownerId })).not.toBeNull()
      expect(releaseImInboxMessage(db, { queueScope, messageId: firstMessage.messageId, ownerId })).toBe(true)
    })
    const dispatcher = createWakeEventDispatcher({ db, maxParallel: 2, launchLoop })

    await dispatcher.dispatchSession(sessionId)
    expect(listWakeEvents(db, sessionId).filter(({ status }) => status === 'pending')).toEqual([])
    expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM messages WHERE id=? AND status=\'queued\'')
      .get(firstMessage.messageId)).toEqual({ count: 1 })
    await dispatcher.dispatchSession(sessionId)
    expect(launchLoop).toHaveBeenCalledTimes(1)
    expect(getDbConnection(db).prepare('SELECT state FROM wake_event_outbox WHERE event_id=?').get(firstMessage.eventId))
      .toEqual({ state: 'dispatched' })

    appendImInboxMessageWithWakeEvent(db, {
      sessionId, channel: 'feishu', queueScope,
      channelMessageId: 'dispatcher-wait-new-event', content: 'new request'
    })
    await dispatcher.dispatchSession(sessionId)
    expect(launchLoop).toHaveBeenCalledTimes(2)
    db.close()
  })

  it('allows a wake event to reuse its existing IM message without creating a second user message', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'im-reuse-turn' }).id
    const queueScope = buildImQueueScope('feishu', sessionId) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>
    const inbox = appendImInboxMessageWithWakeEvent(db, { sessionId, channel: 'feishu', queueScope,
      channelMessageId: 'reuse-source-message', content: 'original body' })
    expect(getDbConnection(db).prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id=? AND role='user'").get(sessionId)).toEqual({ count: 1 })
    db.close()
  })

  it('persists bounded retry facts and waits until the fake clock reaches the next attempt', async () => {
    const temp = createTempDatabase('dispatcher-retry-clock-')
    const sessionId = createSession(temp.db, { name: 'dispatcher-retry-clock' }).id
    const event = appendWakeEvent(temp.db, {
      sessionId, type: 'im-inbound', reasonKey: 'dispatcher-retry-clock-event',
      payloadRef: { kind: 'im-inbox-message', messageId: 'dispatcher-retry-clock-event' }
    })
    let now = 5_000
    let scheduledDelay = -1
    const scheduleRetry = vi.fn((delay: number) => { scheduledDelay = delay })
    const firstLaunchLoop = vi.fn().mockRejectedValue(new Error('provider unavailable'))
    const firstDispatcher = createWakeEventDispatcher({
      db: temp.db,
      maxParallel: 2,
      launchLoop: firstLaunchLoop,
      clock: createWakeEventRetryClock(() => now),
      retryPolicy: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 1_000, maxElapsedMs: 1_000, jitterRatio: 0, random: () => 0.5 },
      scheduleRetry
    })

    await firstDispatcher.dispatchSession(sessionId)
    expect(readWakeEventRetryState(temp.db, event.eventId)).toMatchObject({
      attemptCount: 1, nextAttemptAt: 5_100, shouldRetry: true,
      lastFailure: { message: 'provider unavailable', failedAt: 5_000 }
    })
    expect(scheduledDelay).toBe(100)
    expect(firstLaunchLoop).toHaveBeenCalledTimes(1)
    temp.db.close()

    const reopened = openDatabase(temp.dbPath)
    const secondLaunchLoop = vi.fn(async (_input: WakeEventLoopInput) => undefined)
    const secondDispatcher = createWakeEventDispatcher({
      db: reopened,
      maxParallel: 2,
      launchLoop: secondLaunchLoop,
      clock: createWakeEventRetryClock(() => now),
      retryPolicy: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 1_000, maxElapsedMs: 1_000, jitterRatio: 0, random: () => 0.5 },
      scheduleRetry: vi.fn()
    })
    await secondDispatcher.dispatchSession(sessionId)
    expect(secondLaunchLoop).not.toHaveBeenCalled()

    now = 5_100
    await secondDispatcher.dispatchSession(sessionId)
    expect(secondLaunchLoop).toHaveBeenCalledTimes(1)
    expect(readWakeEventRetryState(reopened, event.eventId)).toBeNull()
    expect(listWakeEvents(reopened, sessionId).find(({ eventId }) => eventId === event.eventId)?.status).toBe('acked')
    reopened.close()
    temp.cleanup()
  })

  it('does not let an exhausted event block a newly arrived inbound event', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'dispatcher-new-event-after-exhaustion' }).id
    const exhausted = appendWakeEvent(db, {
      sessionId, type: 'im-inbound', reasonKey: 'dispatcher-exhausted-event',
      payloadRef: { kind: 'im-inbox-message', messageId: 'dispatcher-exhausted-event' }
    })
    const launchLoop = vi.fn().mockRejectedValueOnce(new Error('provider unavailable')).mockResolvedValue(undefined)
    const dispatcher = createWakeEventDispatcher({
      db, maxParallel: 2, launchLoop,
      clock: createWakeEventRetryClock(() => 9_000),
      retryPolicy: { maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 1_000, maxElapsedMs: 1_000, jitterRatio: 0, random: () => 0.5 },
      scheduleRetry: vi.fn()
    })

    await dispatcher.dispatchSession(sessionId)
    expect(readWakeEventRetryState(db, exhausted.eventId)).toMatchObject({ attemptCount: 1, shouldRetry: false })
    const fresh = appendWakeEvent(db, {
      sessionId, type: 'safety-recovery', reasonKey: 'dispatcher-fresh-recovery',
      payloadRef: { kind: 'safety-approval', approvalId: 'fresh-recovery' }
    })
    await dispatcher.dispatchSession(sessionId)

    expect(launchLoop).toHaveBeenCalledTimes(2)
    expect(launchLoop.mock.calls[1]?.[0].eventIds).toEqual([fresh.eventId])
    expect(listWakeEvents(db, sessionId).find(({ eventId }) => eventId === exhausted.eventId)?.status).toBe('pending')
    db.close()
  })
})
