import { AgentTurnPauseTimedOutError, type AgentTurnLifecycleHooks, type AgentTurnLifecycleLimits } from '../../packages/agent-sdk/src/turn'
import { RUNTIME_TRIGGER_LIMITS } from './limits'
import type { RuntimeTriggerRecord } from '../sessionStorage/public/model'
import type { PersistedTurnTerminal, SettledStepFacts } from './sources'
import type { SessionCommands } from '../sessionStorage/public/ports'

export type SyncCheckpointStep = Parameters<NonNullable<AgentTurnLifecycleHooks['postStep']>>[0]
export type SyncCheckpointTerminal = Parameters<NonNullable<AgentTurnLifecycleHooks['postTurn']>>[0]
export type ReceiverTurnRef = Readonly<{ sessionId: string; turnId: string }>

export type SyncCheckpointLifecycleDependencies = Readonly<{
  sessionId: string
  limits: AgentTurnLifecycleLimits
  now?: () => number
  listWaitingSync: (targetSessionId: string) => readonly RuntimeTriggerRecord[]
  listMatchedForExecution: (invocationId: string, turnId: string) => readonly RuntimeTriggerRecord[]
  readStepFacts: (invocationId: string) => Promise<Readonly<{ historyVersion: number; facts: SettledStepFacts }>>
  saveProgress?: (triggerId: string, expectedRevision: number, progress: Readonly<{ settledStepIdsByInvocation: Readonly<Record<string, readonly string[]>> }>) => RuntimeTriggerRecord | null
  match: (triggerId: string, expectedRevision: number, event: Readonly<Record<string, unknown>>) => RuntimeTriggerRecord | null
  expire: (triggerId: string, expectedRevision: number) => RuntimeTriggerRecord | null
  read: (triggerId: string) => RuntimeTriggerRecord | null
  acceptPause: (input: { trigger: RuntimeTriggerRecord; checkpoint: SyncCheckpointStep }) => RuntimeTriggerRecord | null
  activateDelivery: (trigger: RuntimeTriggerRecord) => Promise<ReceiverTurnRef>
  subscribeReceiver: (sessionId: string, turnId: string, listener: (terminal: PersistedTurnTerminal) => void) => () => void
  readReceiver: (sessionId: string, turnId: string) => Promise<PersistedTurnTerminal>
  fail: (triggerId: string, expectedRevision: number, code: 'TRIGGER_SOURCE_GAP' | 'TRIGGER_HANDLING_FAILED' | 'TRIGGER_DELIVERY_FAILED', caseId: string) => unknown
  registerWaiter?: (triggerId: string, cancel: () => void) => () => void
}>

function isSync(record: RuntimeTriggerRecord): record is RuntimeTriggerRecord & { definition: RuntimeTriggerRecord['definition'] & { condition: Extract<RuntimeTriggerRecord['definition']['condition'], { type: 'session_steps'; mode: 'sync' }> } } {
  return record.definition.condition.type === 'session_steps' && record.definition.condition.mode === 'sync'
}

export function createSyncCheckpointLifecycleHooks(input: SyncCheckpointLifecycleDependencies): AgentTurnLifecycleHooks {
  if (!Number.isFinite(input.limits.callbackTimeoutMs) || input.limits.callbackTimeoutMs <= 0 || !Number.isFinite(input.limits.maxPauseMs) || input.limits.maxPauseMs <= 0) {
    throw new TypeError('lifecycle limits must be finite positive numbers')
  }
  const now = input.now ?? Date.now
  const localProgress = new Map<string, Readonly<{ settledStepIdsByInvocation: Readonly<Record<string, readonly string[]>> }>>()
  const failIfMatchedButNotAccepted = (record: RuntimeTriggerRecord, caseId: string) => {
    if (record.state === 'matched' && record.result?.pauseAcceptedBySdk !== true) {
      input.fail(record.id, record.revision, 'TRIGGER_HANDLING_FAILED', caseId)
    }
  }

  const postStep: NonNullable<AgentTurnLifecycleHooks['postStep']> = async (step) => {
    if (step.signal.aborted) return
    if (step.invocationId.trim().length === 0 || step.turnId.trim().length === 0 || !Number.isSafeInteger(step.historyVersion) ||
      !Number.isSafeInteger(step.executionGeneration) || step.executionGeneration < 0) return
    let snapshot: Readonly<{ historyVersion: number; facts: SettledStepFacts }>
    try { snapshot = await input.readStepFacts(step.invocationId) }
    catch { snapshot = { historyVersion: -1, facts: { ok: false, settledCount: 0, settledStepIds: [], pendingStepIds: [], code: 'SOURCE_GAP', case: 'history-unavailable' } } }
    if (step.signal.aborted) return
    const timestamp = now()
    for (const waiting of input.listWaitingSync(input.sessionId)) {
      if (!isSync(waiting) || waiting.state !== 'waiting' || waiting.definition.condition.targetSessionId !== input.sessionId) continue
      if (timestamp >= waiting.expiresAt) {
        input.expire(waiting.id, waiting.revision)
        continue
      }
      if (!snapshot.facts.ok) {
        input.fail(waiting.id, waiting.revision, 'TRIGGER_SOURCE_GAP', snapshot.facts.case ?? 'history-unavailable')
        continue
      }
      const baseline = waiting.definition.sourceBaseline.settledCount
      const invocationBaselines = waiting.definition.sourceBaseline.settledCountByInvocation
      if (!Number.isSafeInteger(baseline) || Number(baseline) < 0 || !Number.isSafeInteger(snapshot.facts.settledCount) ||
        snapshot.facts.settledCount < 0 || snapshot.facts.settledStepIds.length !== snapshot.facts.settledCount ||
        !invocationBaselines && Number(baseline) !== 0 || invocationBaselines !== undefined &&
          (invocationBaselines === null || typeof invocationBaselines !== 'object' || Array.isArray(invocationBaselines))) {
        input.fail(waiting.id, waiting.revision, 'TRIGGER_SOURCE_GAP', 'step-baseline-invalid')
        continue
      }
      const baselineCounts = (invocationBaselines ?? {}) as Record<string, unknown>
      const baselineTotal = Object.values(baselineCounts).reduce<number>((total, count) =>
        Number.isSafeInteger(count) && Number(count) >= 0 ? total + Number(count) : Number.NaN, 0)
      if (!Number.isSafeInteger(baselineTotal) || baselineTotal !== Number(baseline)) {
        input.fail(waiting.id, waiting.revision, 'TRIGGER_SOURCE_GAP', 'step-baseline-invalid')
        continue
      }
      const storedProgress = waiting.result?.syncStepProgress ?? localProgress.get(waiting.id)
      const rawProgress = storedProgress && typeof storedProgress === 'object' && !Array.isArray(storedProgress)
        ? (storedProgress as Record<string, unknown>).settledStepIdsByInvocation : undefined
      if (storedProgress !== undefined && (!rawProgress || typeof rawProgress !== 'object' || Array.isArray(rawProgress))) {
        input.fail(waiting.id, waiting.revision, 'TRIGGER_SOURCE_GAP', 'step-progress-invalid')
        continue
      }
      const settledStepIdsByInvocation: Record<string, readonly string[]> = {}
      let invalidProgress = false
      for (const [invocationId, ids] of Object.entries((rawProgress ?? {}) as Record<string, unknown>)) {
        if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
          invalidProgress = true
          break
        }
        settledStepIdsByInvocation[invocationId] = ids as string[]
      }
      if (invalidProgress) {
        input.fail(waiting.id, waiting.revision, 'TRIGGER_SOURCE_GAP', 'step-progress-invalid')
        continue
      }
      const rawCurrentBaseline = (invocationBaselines as Record<string, unknown> | undefined)?.[step.invocationId] ?? 0
      if (!Number.isSafeInteger(rawCurrentBaseline) || Number(rawCurrentBaseline) < 0 || snapshot.facts.settledCount < Number(rawCurrentBaseline)) {
        input.fail(waiting.id, waiting.revision, 'TRIGGER_SOURCE_GAP', 'step-baseline-invalid')
        continue
      }
      const newlySettledForCurrentInvocation = snapshot.facts.settledStepIds.slice(Number(rawCurrentBaseline))
      const previouslyObservedForCurrentInvocation = settledStepIdsByInvocation[step.invocationId]
      if (previouslyObservedForCurrentInvocation && (newlySettledForCurrentInvocation.length < previouslyObservedForCurrentInvocation.length ||
        previouslyObservedForCurrentInvocation.some((id, index) => id !== newlySettledForCurrentInvocation[index]))) {
        input.fail(waiting.id, waiting.revision, 'TRIGGER_SOURCE_GAP', 'step-history-regressed')
        continue
      }
      // Persist only the registration-relative suffix: the trigger's pre-registration history
      // is neither progress nor needed to reconstruct its threshold.
      settledStepIdsByInvocation[step.invocationId] = newlySettledForCurrentInvocation
      let actual = 0
      const settledStepIds: string[] = []
      for (const ids of Object.values(settledStepIdsByInvocation)) {
        actual += ids.length
        settledStepIds.push(...ids)
      }
      if (!Number.isSafeInteger(actual)) {
        input.fail(waiting.id, waiting.revision, 'TRIGGER_SOURCE_GAP', 'step-baseline-invalid')
        continue
      }
      if (actual >= waiting.definition.condition.threshold &&
        (snapshot.historyVersion !== step.historyVersion || step.stepKey !== `${step.invocationId}:turn:${step.modelTurn}`)) {
        input.fail(waiting.id, waiting.revision, 'TRIGGER_HANDLING_FAILED', 'checkpoint-unavailable')
        continue
      }
      let effective: RuntimeTriggerRecord = waiting
      const progress = { settledStepIdsByInvocation }
      if (JSON.stringify(storedProgress) !== JSON.stringify(progress)) {
        if (input.saveProgress) {
          const saved = input.saveProgress(waiting.id, waiting.revision, progress)
          if (!saved || saved.state !== 'waiting') continue
          effective = saved
        } else localProgress.set(waiting.id, progress)
      }
      if (actual < waiting.definition.condition.threshold) continue
      if (step.signal.aborted) return
      const pauseTimeoutMs = Math.min(waiting.definition.condition.pauseTimeoutMs, input.limits.maxPauseMs)
      const pauseDeadlineAt = timestamp + pauseTimeoutMs
      const event = { type: 'session_steps', occurredAt: timestamp, targetSessionId: input.sessionId, baseline: Number(baseline), actual,
        threshold: waiting.definition.condition.threshold, settledStepIds, targetTurnId: step.turnId,
        invocationId: step.invocationId, checkpointKey: step.stepKey, executionGeneration: step.executionGeneration, pauseDeadlineAt }
      const matched = input.match(effective.id, effective.revision, event)
      if (!matched || matched.state !== 'matched' || matched.event?.checkpointKey !== step.stepKey ||
        matched.event?.executionGeneration !== step.executionGeneration || matched.event?.invocationId !== step.invocationId) continue
      const timeoutMs = Math.max(0, pauseDeadlineAt - now())
      if (timeoutMs === 0) {
        failIfMatchedButNotAccepted(matched, 'pause-timeout')
        if (waiting.definition.condition.onPauseTimeout === 'fail') throw new AgentTurnPauseTimedOutError()
        continue
      }
      return {
        timeoutMs,
        onTimeout: waiting.definition.condition.onPauseTimeout,
        wait: (signal) => waitForAcceptedReceiverTurn(input, matched, step, signal, pauseDeadlineAt)
      }
    }
  }

  const postTurn: NonNullable<AgentTurnLifecycleHooks['postTurn']> = async (terminal: SyncCheckpointTerminal) => {
    for (const record of input.listMatchedForExecution(terminal.invocationId, terminal.turnId)) {
      failIfMatchedButNotAccepted(record, 'checkpoint-not-accepted')
    }
  }

  return { postStep, postTurn }
}

/** Production lifecycle assembly uses the values explicitly confirmed for this project. */
export function createRuntimeTriggerLifecycleAssembly(input: Omit<SyncCheckpointLifecycleDependencies, 'limits'>): Readonly<{
  hooks: AgentTurnLifecycleHooks
  limits: AgentTurnLifecycleLimits
}> {
  return { hooks: createSyncCheckpointLifecycleHooks({ ...input, limits: RUNTIME_TRIGGER_LIMITS }), limits: RUNTIME_TRIGGER_LIMITS }
}

/** An in-memory SDK waiter cannot be resumed after process restart; close durable sync records explicitly. */
export function failOrphanedRuntimeSyncTriggers(commands: Pick<SessionCommands, 'runtimeTriggers'>, now = Date.now()): number {
  let failed = 0
  for (const state of ['waiting', 'matched'] as const) {
    for (const trigger of commands.runtimeTriggers.listByState(state, 4_096)) {
      if (trigger.definition.condition.type !== 'session_steps' || trigger.definition.condition.mode !== 'sync') continue
      if (commands.runtimeTriggers.update(trigger.id, trigger.revision, { state: 'failed',
        result: { ...(trigger.result ?? {}), code: 'TRIGGER_SOURCE_GAP', case: 'sync-waiter-lost-on-restart' }, updatedAt: now })) failed += 1
    }
  }
  return failed
}

/** Owns online SDK wait cancellation so application shutdown can release every pause. */
export function createRuntimeTriggerSyncWaitRegistry(): Readonly<{
  register(triggerId: string, cancel: () => void): () => void
  cancel(triggerId: string): void
  cancelAll(): void
  size(): number
}> {
  const waiters = new Map<string, () => void>()
  return {
    register(triggerId, cancel) {
      waiters.set(triggerId, cancel)
      return () => { if (waiters.get(triggerId) === cancel) waiters.delete(triggerId) }
    },
    cancel(triggerId) {
      const cancel = waiters.get(triggerId)
      waiters.delete(triggerId)
      cancel?.()
    },
    cancelAll() {
      const active = [...waiters.values()]
      waiters.clear()
      for (const cancel of active) cancel()
    },
    size: () => waiters.size
  }
}

async function waitForAcceptedReceiverTurn(input: SyncCheckpointLifecycleDependencies, matched: RuntimeTriggerRecord, checkpoint: SyncCheckpointStep,
  signal: AbortSignal, pauseDeadlineAt: number): Promise<void> {
  const now = input.now ?? Date.now
  let cancelled = false
  let cancelActiveWait: (() => void) | undefined
  let unregisterWaiter: (() => void) | undefined
  const fail = (code: 'TRIGGER_HANDLING_FAILED' | 'TRIGGER_DELIVERY_FAILED', caseId: string) => {
    const current = input.read(matched.id)
    if (current && current.state === 'matched') input.fail(current.id, current.revision, code, caseId)
  }
  const event = matched.event
  if (signal.aborted) {
    if (signal.reason === 'lifecycle-pause-timeout') fail('TRIGGER_HANDLING_FAILED', 'pause-timeout')
    throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'pause aborted'))
  }
  const current = input.read(matched.id)
  if (!current || current.state !== 'matched' || !isSync(current) || current.result?.pauseAcceptedBySdk === true ||
    current.event?.checkpointKey !== checkpoint.stepKey || current.event?.targetTurnId !== checkpoint.turnId ||
    current.event?.invocationId !== checkpoint.invocationId || current.event?.executionGeneration !== checkpoint.executionGeneration ||
    current.event?.pauseDeadlineAt !== pauseDeadlineAt || !event) {
    fail('TRIGGER_HANDLING_FAILED', 'checkpoint-not-accepted')
    throw new Error('sync checkpoint is no longer current')
  }
  if (now() >= current.expiresAt) {
    input.expire(current.id, current.revision)
    throw new Error('sync trigger expired before SDK pause acceptance')
  }
  if (!nowWithinDeadline(input, pauseDeadlineAt)) {
    fail('TRIGGER_HANDLING_FAILED', 'pause-timeout')
    throw new AgentTurnPauseTimedOutError()
  }
  const accepted = input.acceptPause({ trigger: current, checkpoint })
  if (!accepted || accepted.state !== 'matched' || accepted.result?.pauseAcceptedBySdk !== true) {
    fail('TRIGGER_HANDLING_FAILED', 'checkpoint-not-accepted')
    throw new Error('SDK pause acceptance was not persisted')
  }
  if (now() >= accepted.expiresAt) {
    input.expire(accepted.id, accepted.revision)
    throw new Error('sync trigger expired before delivery')
  }
  unregisterWaiter = input.registerWaiter?.(matched.id, () => { cancelled = true; cancelActiveWait?.() })
  let unsubscribe: (() => void) | undefined
  let abortListener: (() => void) | undefined
  try {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'pause aborted'))
    const receiver = await input.activateDelivery(accepted)
    if (cancelled) throw new Error('sync wait cancelled')
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'pause aborted'))
    const afterDelivery = input.read(accepted.id)
    if (afterDelivery?.state === 'matched' && now() >= afterDelivery.expiresAt) {
      input.expire(afterDelivery.id, afterDelivery.revision)
      throw new Error('sync trigger expired during delivery')
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        if (unsubscribe) unsubscribe()
        if (abortListener) signal.removeEventListener('abort', abortListener)
        if (error) reject(error)
        else resolve()
      }
      unsubscribe = input.subscribeReceiver(receiver.sessionId, receiver.turnId, (terminal) => {
        if (terminal.kind === 'terminal') finish()
        else if (terminal.kind === 'source-gap') finish(new Error(`receiver terminal unavailable: ${terminal.case}`))
      })
      cancelActiveWait = () => finish(new Error('sync wait cancelled'))
      if (cancelled) cancelActiveWait()
      abortListener = () => {
        if (signal.reason === 'lifecycle-pause-timeout') fail('TRIGGER_HANDLING_FAILED', 'pause-timeout')
        finish(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'pause aborted')))
      }
      signal.addEventListener('abort', abortListener, { once: true })
      if (signal.aborted) { abortListener(); return }
      void input.readReceiver(receiver.sessionId, receiver.turnId).then((terminal) => {
        if (terminal.kind === 'terminal') finish()
        else if (terminal.kind === 'source-gap') finish(new Error(`receiver terminal unavailable: ${terminal.case}`))
      }, (error) => finish(error instanceof Error ? error : new Error(String(error))))
    })
  } catch (error) {
    if (signal.reason === 'lifecycle-pause-timeout') fail('TRIGGER_HANDLING_FAILED', 'pause-timeout')
    else if (!signal.aborted) fail('TRIGGER_DELIVERY_FAILED', 'receiver-wait-failed')
    throw error
  } finally {
    cancelActiveWait = undefined
    unregisterWaiter?.()
  }
}

function nowWithinDeadline(input: SyncCheckpointLifecycleDependencies, deadline: number): boolean {
  return (input.now ?? Date.now)() < deadline
}
