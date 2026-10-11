import { randomUUID } from 'crypto'
import type { AppDatabase } from '../database/sqliteStore'
import {
  claimWakeEvents,
  clearWakeEventRetryState,
  finalizeWakeEvents,
  listClaimableWakeEventIds,
  listWakeEvents,
  readWakeEventRetryState,
  releaseWakeEventClaimsForRetry,
  saveWakeEventRetryState,
  type ClaimedWakeEventSet
} from '../database/wakeEvents'
import type { WakeEvent } from '../../src/shared/wakeEvent'
import { releaseRemoteSession, tryClaimRemoteSession } from './remoteAgentRegistry'
import {
  createWakeEventRetryClock,
  createWakeEventRetryState,
  isWakeEventRetryDue,
  recordWakeEventRetryFailure,
  type WakeEventRetryClock,
  type WakeEventRetryConfig
} from './wakeEventRetryPolicy'

export type WakeEventLoopInput = {
  sessionId: string
  runId: string
  ownerId: string
  eventIds: string[]
  events: WakeEvent[]
}

export type WakeEventDispatcherOptions = {
  db: AppDatabase
  maxParallel: number
  /** Restricts durable wake reads and claims to sessions owned by this channel. */
  ownerChannel?: 'feishu' | 'wechat'
  launchLoop: (input: WakeEventLoopInput) => Promise<void>
  createRunId?: () => string
  retryPolicy?: WakeEventRetryConfig
  clock?: WakeEventRetryClock
  scheduleRetry?: (delayMs: number, callback: () => void) => void
  /** Receives failures from timer-triggered retries; direct dispatch calls still reject normally. */
  onError?: (error: unknown) => void
  /** Delay before retrying a durable wake that could not acquire the session/global lease. */
  leaseRetryMs?: number
}

export type WakeEventDispatcher = {
  dispatchSession(sessionId: string, options?: { retryExhausted?: boolean }): Promise<void>
  dispose(): Promise<void>
}

export function createWakeEventDispatcher(options: WakeEventDispatcherOptions): WakeEventDispatcher {
  const activeSessions = new Map<string, Promise<void>>()
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const scheduledRetries = new Set<string>()
  let disposed = false
  const createRunId = options.createRunId ?? randomUUID
  const clock = options.clock ?? createWakeEventRetryClock()
  const retryPolicy = options.retryPolicy ?? {
    maxAttempts: 5,
    baseDelayMs: 1_000,
    maxDelayMs: 60_000,
    maxElapsedMs: 15 * 60_000,
    jitterRatio: 0.2
  }

  const scheduleRetry = (sessionId: string, nextAttemptAt: number) => {
    if (disposed || scheduledRetries.has(sessionId)) return
    scheduledRetries.add(sessionId)
    const delayMs = Math.max(0, nextAttemptAt - clock.now())
    const callback = () => {
      scheduledRetries.delete(sessionId)
      retryTimers.delete(sessionId)
      if (disposed) return
      void dispatchSession(sessionId).catch((error) => {
        try {
          if (options.onError) options.onError(error)
          else console.error('[wake-event-dispatcher] scheduled retry failed', error)
        } catch (reportError) {
          console.error('[wake-event-dispatcher] retry error reporter failed', reportError)
        }
      })
    }
    if (options.scheduleRetry) {
      options.scheduleRetry(delayMs, callback)
      return
    }
    const timer = setTimeout(callback, delayMs)
    timer.unref?.()
    retryTimers.set(sessionId, timer)
  }

  const runSession = async (sessionId: string, retryExhausted: boolean): Promise<void> => {
    let retryExhaustedRequested = retryExhausted
    while (true) {
      let retryExhaustedAfterFresh = false
      if (disposed) return
      const now = clock.now()
      const candidates = listClaimableWakeEventIds(options.db, sessionId, now, options.ownerChannel)
      const eligibleEventIds: string[] = []
      const nextRetryTimes: number[] = []
      for (const eventId of candidates) {
        const retry = readWakeEventRetryState(options.db, eventId)
        if (!retry || isWakeEventRetryDue(retry, now) || (retryExhaustedRequested && !retry.shouldRetry)) eligibleEventIds.push(eventId)
        else if (retry.shouldRetry && retry.nextAttemptAt != null) nextRetryTimes.push(retry.nextAttemptAt)
      }
      if (retryExhaustedRequested) {
        retryExhaustedRequested = false
        const freshOrDueEventIds = eligibleEventIds.filter((eventId) => {
          const retry = readWakeEventRetryState(options.db, eventId)
          return !retry || retry.shouldRetry
        })
        // Process recoverable work separately from older exhausted work, and settle
        // each event independently so one event cannot consume another's retry budget.
        if (freshOrDueEventIds.length > 0) {
          retryExhaustedAfterFresh = freshOrDueEventIds.length < eligibleEventIds.length
          eligibleEventIds.splice(0, eligibleEventIds.length, ...freshOrDueEventIds)
        }
      }
      if (eligibleEventIds.length === 0) {
        if (nextRetryTimes.length > 0) scheduleRetry(sessionId, Math.min(...nextRetryTimes))
        return
      }
      let selectedEventsSucceeded = true
      for (const eventId of eligibleEventIds) {
        if (disposed) return
        const runId = createRunId()
        const ownerId = runId
        const claimResult = tryClaimRemoteSession(sessionId, runId, options.maxParallel)
        if (claimResult !== 'ok') {
          scheduleRetry(sessionId, clock.now() + (options.leaseRetryMs ?? 250))
          return
        }
        let claimed: ClaimedWakeEventSet | undefined
        try {
          claimed = claimWakeEvents(options.db, { sessionId, runId, ownerId, eventIds: [eventId], now: clock.now(), ownerChannel: options.ownerChannel })
          if (claimed.eventIds.length === 0) continue
          const event = listWakeEvents(options.db, sessionId).find((candidate) => candidate.eventId === eventId)
          if (!event) continue
          await options.launchLoop({ sessionId, runId, ownerId, eventIds: [eventId], events: [event] })
          const finalized = finalizeWakeEvents(options.db, {
            sessionId, runId, ownerId, eventIds: [eventId], now: clock.now()
          })
          if (finalized.length !== 1) {
            selectedEventsSucceeded = false
            continue
          }
          clearWakeEventRetryState(options.db, eventId)
        } catch (error) {
          selectedEventsSucceeded = false
          const failedAt = clock.now()
          const message = error instanceof Error ? error.message : String(error)
          if (claimed?.eventIds.includes(eventId)) {
            const prior = readWakeEventRetryState(options.db, eventId)
            const initial = prior ?? createWakeEventRetryState({ eventId, startedAt: failedAt })
            const retry = recordWakeEventRetryFailure(initial, { message, failedAt }, retryPolicy)
            saveWakeEventRetryState(options.db, retry, failedAt)
            releaseWakeEventClaimsForRetry(options.db, { sessionId, runId, ownerId, eventIds: [eventId], now: failedAt })
            if (retry.shouldRetry && retry.nextAttemptAt != null) scheduleRetry(sessionId, retry.nextAttemptAt)
          }
        } finally {
          releaseRemoteSession(sessionId, runId)
        }
      }
      if (retryExhaustedAfterFresh && selectedEventsSucceeded) {
        retryExhaustedRequested = true
        continue
      }
      if (retryExhaustedAfterFresh && !selectedEventsSucceeded) return
    }
  }

  function dispatchSession(sessionId: string, dispatchOptions: { retryExhausted?: boolean } = {}): Promise<void> {
    if (disposed) return Promise.resolve()
    const existing = activeSessions.get(sessionId)
    if (existing) {
      if (!dispatchOptions.retryExhausted) return existing
      return existing.finally(() => {
        if (!disposed) return dispatchSession(sessionId, dispatchOptions)
      })
    }
    const run = runSession(sessionId, dispatchOptions.retryExhausted === true).finally(() => {
      if (activeSessions.get(sessionId) === run) activeSessions.delete(sessionId)
    })
    activeSessions.set(sessionId, run)
    return run
  }

  return {
    dispatchSession,
    async dispose() {
      if (disposed) return
      disposed = true
      for (const timer of retryTimers.values()) clearTimeout(timer)
      retryTimers.clear()
      scheduledRetries.clear()
      await Promise.allSettled(activeSessions.values())
    }
  }
}
