import type { RuntimeTriggerFailure } from '../../src/shared/domainTypes'
import type { RuntimeTriggerRecord } from '../sessionStorage/public/model'
import {
  createWakeEventRetryState, recordWakeEventRetryFailure,
  type WakeEventRetryConfig
} from '../remote/wakeEventRetryPolicy'
import type { RuntimeTriggerDeliveryResult } from './delivery'

type Candidate = Readonly<{ kind: 'none' }> | Readonly<{ kind: 'candidate'; event: Readonly<Record<string, unknown>> }> |
  Readonly<{ kind: 'expired'; case: string }> | Readonly<{ kind: 'source-gap'; case: string }>
type Receipt = Readonly<{ queuedMessageId?: string; turnId?: string; state: string }>
type TurnTerminal = Readonly<{ kind: 'active' | 'missing' }> | Readonly<{ kind: 'terminal'; outcome: 'completed' | 'failed' | 'cancelled' | 'timed-out' }>

const DEFAULT_TRIGGER_RETRY: WakeEventRetryConfig = { maxAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 60_000, maxElapsedMs: 15 * 60_000, jitterRatio: 0.2 }

/** Durable recovery owner for waiting source facts and matched queue delivery. */
export function createRuntimeTriggerRecovery(input: {
  listWaiting(): readonly RuntimeTriggerRecord[]
  listMatched(after?: { createdAt: number; id: string }): readonly RuntimeTriggerRecord[]
  read(triggerId: string): RuntimeTriggerRecord | null
  evaluateWaiting(trigger: RuntimeTriggerRecord, now: number): Promise<Candidate> | Candidate
  match(triggerId: string, expectedRevision: number, event: Readonly<Record<string, unknown>>): unknown
  expire(triggerId: string, expectedRevision: number): unknown
  fail(triggerId: string, expectedRevision: number, code: RuntimeTriggerFailure['code'], caseId: string): unknown
  deliver(triggerId: string): RuntimeTriggerDeliveryResult
  update(triggerId: string, expectedRevision: number, patch: Partial<Pick<RuntimeTriggerRecord, 'state' | 'messageId' | 'attempts' | 'nextAttemptAt' | 'result' | 'updatedAt'>>): RuntimeTriggerRecord | null
  readReceipt(trigger: RuntimeTriggerRecord): Receipt | undefined
  isSessionBusy(sessionId: string): boolean
  startReceiver(input: { sessionId: string; requestId: string; messageId: string }): Promise<'started' | 'busy' | 'unavailable'> | 'started' | 'busy' | 'unavailable'
  readTurnTerminal(sessionId: string, turnId: string): Promise<TurnTerminal> | TurnTerminal
  now?: () => number
  retryPolicy?: WakeEventRetryConfig
  random?: () => number
  intervalMs?: number
  onDeliveryError?: (triggerId: string, error: unknown) => void
}): { scan(): Promise<void>; start(): void; stop(): Promise<void> } {
  const now = input.now ?? Date.now
  const retryPolicy = { ...DEFAULT_TRIGGER_RETRY, ...input.retryPolicy, ...(input.random ? { random: input.random } : {}) }
  const intervalMs = input.intervalMs ?? 1_000
  let busy = false
  let timer: ReturnType<typeof setInterval> | undefined
  let activeScan: Promise<void> | undefined
  let matchedCursor: { createdAt: number; id: string } | undefined

  const settleFromTurn = async (trigger: RuntimeTriggerRecord, receipt: Receipt): Promise<void> => {
    if (!receipt.turnId) return
    const terminal = await input.readTurnTerminal(trigger.receiverSessionId, receipt.turnId)
    if (terminal.kind !== 'terminal') return
    const current = input.read(trigger.id)
    if (!current || current.state !== 'matched') return
    const completed = terminal.outcome === 'completed'
    input.update(current.id, current.revision, { state: completed ? 'completed' : 'failed',
      result: { ...(current.result ?? {}), receiverTurnId: receipt.turnId, detail: terminal.outcome, completedAt: now() }, updatedAt: now() })
  }

  const recordDeliveryFailure = (trigger: RuntimeTriggerRecord, failureCase: string): void => {
    if (failureCase === 'delivery-message-missing' || failureCase === 'delivery-receipt-missing') {
      input.fail(trigger.id, trigger.revision, 'TRIGGER_DELIVERY_FAILED', failureCase)
      return
    }
    const startedAt = trigger.matchedAt ?? trigger.createdAt
    const initial = createWakeEventRetryState({ eventId: trigger.id, startedAt })
    const state = { ...initial, attemptCount: trigger.attempts, nextAttemptAt: trigger.nextAttemptAt ?? now(),
      shouldRetry: trigger.attempts < retryPolicy.maxAttempts }
    const retried = recordWakeEventRetryFailure(state, { message: failureCase, failedAt: Math.max(startedAt, now()) }, retryPolicy)
    if (!retried.shouldRetry || retried.nextAttemptAt === null) {
      input.fail(trigger.id, trigger.revision, 'TRIGGER_DELIVERY_FAILED', 'delivery-retries-exhausted')
      return
    }
    input.update(trigger.id, trigger.revision, { attempts: retried.attemptCount, nextAttemptAt: retried.nextAttemptAt,
      result: { ...(trigger.result ?? {}), code: 'TRIGGER_DELIVERY_FAILED', case: failureCase }, updatedAt: now() })
  }

  const deliverMatched = async (trigger: RuntimeTriggerRecord, timestamp: number): Promise<void> => {
    if (trigger.state !== 'matched') return
    const isSync = trigger.definition.condition.type === 'session_steps' && trigger.definition.condition.mode === 'sync'
    if (isSync && trigger.result?.pauseAcceptedBySdk !== true) return
    if (trigger.nextAttemptAt !== undefined && trigger.nextAttemptAt > timestamp) return
    let receipt = input.readReceipt(trigger)
    if (receipt?.queuedMessageId) {
      if (trigger.messageId && trigger.messageId !== receipt.queuedMessageId) {
        input.fail(trigger.id, trigger.revision, 'TRIGGER_DELIVERY_FAILED', 'delivery-receipt-mismatch')
        return
      }
      if (receipt.turnId) {
        await settleFromTurn(trigger, receipt)
        return
      }
    } else {
      if (trigger.messageId) {
        input.fail(trigger.id, trigger.revision, 'TRIGGER_DELIVERY_FAILED', 'delivery-receipt-missing')
        return
      }
      const delivered = input.deliver(trigger.id)
      if (delivered.kind === 'deferred') return
      if (delivered.kind === 'failed') {
        const current = input.read(trigger.id)
        if (current?.state === 'matched') recordDeliveryFailure(current, delivered.case)
        return
      }
      const current = input.read(trigger.id)
      if (!current || current.state !== 'matched') return
      receipt = input.readReceipt(current)
      if (!receipt?.queuedMessageId || receipt.queuedMessageId !== delivered.messageId) {
        input.fail(current.id, current.revision, 'TRIGGER_DELIVERY_FAILED', 'delivery-receipt-missing')
        return
      }
      if (receipt.turnId) {
        await settleFromTurn(current, receipt)
        return
      }
    }
    const messageId = receipt?.queuedMessageId
    if (!messageId || receipt.state !== 'queued' || input.isSessionBusy(trigger.receiverSessionId)) return
    const start = await input.startReceiver({ sessionId: trigger.receiverSessionId, requestId: `runtime-trigger:${trigger.id}`, messageId })
    if (start === 'busy') return
    if (start === 'unavailable') {
      const current = input.read(trigger.id)
      if (current?.state === 'matched') input.fail(current.id, current.revision, 'TRIGGER_DELIVERY_FAILED', 'receiver-unavailable')
      return
    }
    const current = input.read(trigger.id)
    if (!current || current.state !== 'matched') return
    const afterStart = input.readReceipt(current)
    if (afterStart?.turnId) await settleFromTurn(current, afterStart)
  }

  return {
    async scan() {
      if (busy) return
      busy = true
      const scan = (async () => {
        try {
        const timestamp = now()
        for (const trigger of input.listWaiting()) {
          if (trigger.state !== 'waiting') continue
          let candidate: Candidate
          try { candidate = await input.evaluateWaiting(trigger, timestamp) }
          catch { candidate = { kind: 'source-gap', case: 'source-read-failed' } }
          if (candidate.kind === 'candidate') input.match(trigger.id, trigger.revision, candidate.event)
          else if (candidate.kind === 'expired') input.expire(trigger.id, trigger.revision)
          else if (candidate.kind === 'source-gap') input.fail(trigger.id, trigger.revision, 'TRIGGER_SOURCE_GAP', candidate.case)
        }
        const matchedPage = input.listMatched(matchedCursor)
        if (matchedCursor && matchedPage.length === 0) {
          matchedCursor = undefined
        } else if (matchedPage.length > 0) {
          const last = matchedPage[matchedPage.length - 1]!
          matchedCursor = { createdAt: last.createdAt, id: last.id }
        }
        for (const trigger of matchedPage) {
          if (trigger.state !== 'matched') continue
          try { await deliverMatched(trigger, timestamp) }
          catch (error) {
            input.onDeliveryError?.(trigger.id, error)
            const current = input.read(trigger.id)
            if (current?.state === 'matched') recordDeliveryFailure(current, 'delivery-runtime-failed')
          }
        }
        } finally { busy = false }
      })()
      activeScan = scan
      try { await scan }
      finally { if (activeScan === scan) activeScan = undefined }
    },
    start() {
      if (timer) return
      timer = setInterval(() => { void this.scan() }, intervalMs)
      timer.unref?.()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = undefined
      return activeScan ?? Promise.resolve()
    }
  }
}
