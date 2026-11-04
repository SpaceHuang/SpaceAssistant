import { historyEventsEqual, type HistoryEvent, type HistoryPort, type HistorySnapshot } from '../../packages/agent-sdk/src/history'
import type { SessionExecutionStore } from '../sessionStorage/public/execution'
import type { RuntimeTriggerRecord } from '../sessionStorage/public/model'
import type { RuntimeTriggerCondition } from '../../src/shared/domainTypes'
import type { SessionQueries } from '../sessionStorage/public/ports'
import { scanImTriggerFacts } from './imSource'
import { readManagedProcessExit } from './processSource'

export type SettledStepFacts = Readonly<{
  ok: boolean
  settledCount: number
  settledStepIds: readonly string[]
  pendingStepIds: readonly string[]
  settledCountByInvocation?: Readonly<Record<string, number>>
  code?: 'SOURCE_GAP'
  case?: string
}>

export type RuntimeTriggerCandidate = Readonly<{ kind: 'none' }> | Readonly<{ kind: 'expired'; case: string }> |
  Readonly<{ kind: 'source-gap'; case: string }> | Readonly<{ kind: 'candidate'; event: Readonly<Record<string, unknown>> }>

export type RuntimeTurnCompletionFact = Readonly<{ kind: 'pending' }> | Readonly<{ kind: 'missing' }> | Readonly<{ kind: 'source-gap'; case: string }> |
  Readonly<{ kind: 'terminal'; sessionId: string; turnId: string; outcome: 'completed' | 'failed' | 'cancelled' | 'timed-out'; occurredAt: number }>

/** Resolve all five source types from their trusted facts; this layer extracts facts and never authorizes access. */
export async function evaluateRuntimeTriggerSource(trigger: RuntimeTriggerRecord, input: {
  now: number
  queries?: SessionQueries
  readSettledSteps?: (targetSessionId: string) => Promise<SettledStepFacts>
  readTurnCompletion?: (targetSessionId: string, turnId: string) => Promise<RuntimeTurnCompletionFact>
  readProcessExit?: (managedProcessId: string, runtimeGeneration: string) => ReturnType<typeof readManagedProcessExit>
  imPageSize?: number
}): Promise<RuntimeTriggerCandidate> {
  const condition: RuntimeTriggerCondition = trigger.definition.condition
  if (condition.type === 'time') return runtimeTriggerCandidate(trigger, input.now)
  if (condition.type === 'session_steps') {
    if (condition.mode === 'sync') return input.now >= trigger.expiresAt ? { kind: 'expired', case: 'source-expired' } : { kind: 'none' }
    if (!input.readSettledSteps) return { kind: 'source-gap', case: 'step-history-unavailable' }
    try { return runtimeTriggerCandidate(trigger, input.now, await input.readSettledSteps(condition.targetSessionId)) }
    catch { return { kind: 'source-gap', case: 'step-history-unavailable' } }
  }
  if (condition.type === 'turn_completed') {
    if (!input.readTurnCompletion) return { kind: 'source-gap', case: 'turn-source-unavailable' }
    let fact: RuntimeTurnCompletionFact
    try { fact = await input.readTurnCompletion(condition.targetSessionId, condition.turnId) }
    catch { return { kind: 'source-gap', case: 'turn-source-unavailable' } }
    if (fact.kind === 'pending') return input.now >= trigger.expiresAt ? { kind: 'expired', case: 'source-expired' } : { kind: 'none' }
    if (fact.kind === 'missing') return { kind: 'source-gap', case: 'target-turn-missing' }
    if (fact.kind === 'source-gap') return { kind: 'source-gap', case: fact.case }
    if (fact.sessionId !== condition.targetSessionId || fact.turnId !== condition.turnId || !Number.isSafeInteger(fact.occurredAt)) {
      return { kind: 'source-gap', case: 'turn-fact-identity-invalid' }
    }
    if (fact.occurredAt < trigger.createdAt) return { kind: 'source-gap', case: 'turn-completed-before-registration' }
    return fact.occurredAt > trigger.expiresAt ? { kind: 'expired', case: 'turn-completed-after-expiry' }
      : { kind: 'candidate', event: { type: 'turn_completed', occurredAt: fact.occurredAt, targetSessionId: fact.sessionId, turnId: fact.turnId, outcome: fact.outcome } }
  }
  if (condition.type === 'process_exit') {
    const runtimeGeneration = trigger.definition.sourceBaseline.runtimeGeneration
    if (typeof runtimeGeneration !== 'string' || !runtimeGeneration) return { kind: 'source-gap', case: 'process-runtime-generation-missing' }
    const fact = (input.readProcessExit ?? readManagedProcessExit)(condition.managedProcessId, runtimeGeneration)
    if (fact.kind === 'running') return input.now >= trigger.expiresAt ? { kind: 'expired', case: 'source-expired' } : { kind: 'none' }
    if (fact.kind === 'source-gap') return { kind: 'source-gap', case: fact.case }
    if (fact.managedProcessId !== condition.managedProcessId || fact.runtimeGeneration !== runtimeGeneration || fact.sessionId !== trigger.ownerSessionId) {
      return { kind: 'source-gap', case: 'process-fact-identity-invalid' }
    }
    return fact.occurredAt > trigger.expiresAt ? { kind: 'expired', case: 'process-exited-after-expiry' }
      : { kind: 'candidate', event: { type: 'process_exit', occurredAt: fact.occurredAt, managedProcessId: fact.managedProcessId,
        runtimeGeneration: fact.runtimeGeneration, sessionId: fact.sessionId, toolName: fact.toolName, exitCode: fact.exitCode,
        signal: fact.signal, reason: fact.reason, ...(fact.outputRef ? { outputRef: fact.outputRef } : {}) } }
  }
  if (!input.queries) return { kind: 'source-gap', case: 'im-fact-reader-unavailable' }
  const baseline = trigger.definition.sourceBaseline
  if (!Number.isSafeInteger(baseline.through) || !Number.isSafeInteger(baseline.coverageRevision)) return { kind: 'source-gap', case: 'im-baseline-invalid' }
  const facts = scanImTriggerFacts(input.queries, condition, { pageSize: input.imPageSize ?? 100,
    baseline: { through: Number(baseline.through), coverageRevision: Number(baseline.coverageRevision) } })
  if (!facts.ok) return { kind: 'source-gap', case: facts.case }
  const match = facts.matches[0]
  if (!match) return input.now >= trigger.expiresAt ? { kind: 'expired', case: 'source-expired' } : { kind: 'none' }
  if (match.timestamp > trigger.expiresAt) return { kind: 'expired', case: 'im-message-after-expiry' }
  return { kind: 'candidate', event: { type: 'im_message', occurredAt: match.timestamp, acceptedSeq: match.acceptedSeq,
    channel: match.channel, accountId: match.accountId, conversationId: match.conversationId, senderId: match.senderId,
    ...(match.isGroup !== undefined ? { isGroup: match.isGroup } : {}), platformMessageId: match.platformMessageId, body: match.body,
    ...(match.contextToken ? { contextToken: match.contextToken } : {}),
    ...(match.trackId ? { trackId: match.trackId } : {}), ...(match.trackEventId ? { trackEventId: match.trackEventId } : {}) } }
}

export function runtimeTriggerCandidate(trigger: RuntimeTriggerRecord, now: number, settledFacts?: SettledStepFacts): RuntimeTriggerCandidate {
  if (trigger.state !== 'waiting' || !Number.isSafeInteger(now)) return { kind: 'none' }
  const condition = trigger.definition.condition
  if (condition.type === 'time') {
    const at = Date.parse(condition.at)
    if (!Number.isFinite(at)) return { kind: 'source-gap', case: 'time-at-invalid' }
    if (at > trigger.expiresAt) return { kind: 'expired', case: 'time-after-expiry' }
    if (at > now) return { kind: 'none' }
    return { kind: 'candidate', event: { type: 'time', occurredAt: at, scheduledAt: condition.at, taskPrompt: condition.taskPrompt } }
  }
  if (condition.type !== 'session_steps') return { kind: 'none' }
  if (now >= trigger.expiresAt) return { kind: 'expired', case: 'source-expired' }
  if (condition.mode === 'sync') return { kind: 'none' }
  if (!settledFacts) return { kind: 'none' }
  if (!settledFacts.ok) return { kind: 'source-gap', case: settledFacts.case ?? 'step-source-gap' }
  const baseline = trigger.definition.sourceBaseline.settledCount
  if (!Number.isSafeInteger(baseline) || Number(baseline) < 0 || !Number.isSafeInteger(settledFacts.settledCount) || settledFacts.settledCount < Number(baseline)) {
    return { kind: 'source-gap', case: 'step-baseline-invalid' }
  }
  const actual = settledFacts.settledCount - Number(baseline)
  if (actual < condition.threshold) return { kind: 'none' }
  return { kind: 'candidate', event: { type: 'session_steps', occurredAt: now, targetSessionId: condition.targetSessionId,
    baseline: Number(baseline), actual: settledFacts.settledCount, threshold: condition.threshold,
    settledStepIds: settledFacts.settledStepIds.slice(Number(baseline)) } }
}

export function createRuntimeTriggerSourceScanner(input: {
  listWaiting: () => readonly RuntimeTriggerRecord[]
  readSettledSteps?: (targetSessionId: string) => Promise<SettledStepFacts>
  match: (triggerId: string, expectedRevision: number, event: Readonly<Record<string, unknown>>) => unknown
  expire: (triggerId: string, expectedRevision: number) => unknown
  fail: (triggerId: string, expectedRevision: number, caseId: string) => unknown
  now?: () => number
}): { scan(): Promise<void>; start(): void; stop(): void } {
  const now = input.now ?? Date.now
  let busy = false
  let timer: ReturnType<typeof setInterval> | undefined
  return {
    async scan() {
      if (busy) return
      busy = true
      try {
        const timestamp = now()
        for (const trigger of input.listWaiting()) {
          if (trigger.state !== 'waiting') continue
          const condition = trigger.definition.condition
          let facts: SettledStepFacts | undefined
          if (condition.type === 'session_steps' && condition.mode === 'async' && input.readSettledSteps) {
            try { facts = await input.readSettledSteps(condition.targetSessionId) }
            catch { facts = gap('step-history-unavailable') }
          }
          const candidate = runtimeTriggerCandidate(trigger, timestamp, facts)
          if (candidate.kind === 'candidate') input.match(trigger.id, trigger.revision, candidate.event)
          else if (candidate.kind === 'expired') input.expire(trigger.id, trigger.revision)
          else if (candidate.kind === 'source-gap') input.fail(trigger.id, trigger.revision, candidate.case)
        }
      } finally { busy = false }
    },
    start() { if (!timer) timer = setInterval(() => { void this.scan() }, 1000) },
    stop() { if (timer) clearInterval(timer); timer = undefined }
  }
}

type StepRecord = { eventId: string; modelTurn: number; toolIds: Set<string>; terminalToolIds: Set<string>; uncertainToolIds: Set<string> }
type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : undefined
}

function gap(caseId: string): SettledStepFacts {
  return { ok: false, settledCount: 0, settledStepIds: [], pendingStepIds: [], code: 'SOURCE_GAP', case: caseId }
}

function snapshotHasCompleteCoverage(snapshot: HistorySnapshot): boolean {
  if (!snapshot || typeof snapshot.invocationId !== 'string' || !snapshot.invocationId.trim() ||
    !Number.isInteger(snapshot.version) || snapshot.version < 0 || !Array.isArray(snapshot.events) || snapshot.events.length !== snapshot.version) return false
  const eventIds = new Set<string>()
  for (let index = 0; index < snapshot.events.length; index += 1) {
    const event = snapshot.events[index]
    if (!event || event.invocationId !== snapshot.invocationId || event.sequence !== index + 1 ||
      typeof event.turnId !== 'string' || !event.turnId.trim() || typeof event.eventId !== 'string' || !event.eventId.trim() ||
      eventIds.has(event.eventId)) return false
    eventIds.add(event.eventId)
  }
  return true
}

function toolOutcome(payload: UnknownRecord): 'known' | 'uncertain' | 'invalid' {
  const result = record(payload.result)
  const executionOutcome = payload.executionOutcome ?? result?.executionOutcome
  const executorEntry = payload.executorEntry ?? result?.executorEntry
  if (executionOutcome !== undefined && !['succeeded', 'known-failure', 'unknown-after-dispatch', 'not-dispatched'].includes(String(executionOutcome))) return 'invalid'
  if (executorEntry !== undefined && !['not-entered', 'entered', 'unknown'].includes(String(executorEntry))) return 'invalid'
  if (executionOutcome === 'unknown-after-dispatch' || executorEntry === 'unknown') return 'uncertain'
  return 'known'
}

export class SettledStepFactsTracker {
  private invocationId?: string
  private version = 0
  private events: HistoryEvent[] = []
  private readonly byToolId = new Map<string, StepRecord[]>()
  private readonly steps: StepRecord[] = []
  private failedCase?: string
  get currentVersion(): number { return this.version }

  update(snapshot: HistorySnapshot): SettledStepFacts {
    if (this.failedCase) return gap(this.failedCase)
    if (!snapshotHasCompleteCoverage(snapshot)) return this.fail('history-incomplete')
    if (this.invocationId && this.invocationId !== snapshot.invocationId) return this.fail('history-identity-changed')
    if (snapshot.version < this.version) return this.fail('history-version-regressed')
    for (let index = 0; index < this.version; index += 1) {
      if (!historyEventsEqual(this.events[index]!, snapshot.events[index]!)) return this.fail('history-prefix-changed')
    }
    this.invocationId = snapshot.invocationId
    for (let index = this.version; index < snapshot.version; index += 1) {
      const errorCase = this.applyEvent(snapshot.events[index]!)
      if (errorCase) return this.fail(errorCase)
      this.events.push(snapshot.events[index]!)
    }
    this.version = snapshot.version
    return this.toFacts()
  }

  /** Apply a strictly contiguous append-only page; callers must initialize with one complete snapshot first. */
  appendEvents(input: { invocationId: string; fromVersion: number; version: number; events: readonly HistoryEvent[] }): SettledStepFacts {
    if (this.failedCase) return gap(this.failedCase)
    if (!this.invocationId || input.invocationId !== this.invocationId || input.fromVersion !== this.version ||
      !Number.isSafeInteger(input.version) || input.version !== input.fromVersion + input.events.length) return this.fail('history-incremental-cursor-mismatch')
    const knownIds = new Set(this.events.map((event) => event.eventId))
    for (let index = 0; index < input.events.length; index += 1) {
      const event = input.events[index]!
      if (event.invocationId !== input.invocationId || event.sequence !== input.fromVersion + index + 1 ||
        typeof event.eventId !== 'string' || !event.eventId.trim() || knownIds.has(event.eventId) ||
        !Number.isSafeInteger(event.schemaVersion) || event.schemaVersion < 1) return this.fail('history-incremental-event-invalid')
      knownIds.add(event.eventId)
      const errorCase = this.applyEvent(event)
      if (errorCase) return this.fail(errorCase)
      this.events.push(event)
    }
    this.version = input.version
    return this.toFacts()
  }

  private applyEvent(event: HistoryEvent): string | undefined {
    if (event.kind === 'model-response-committed') {
      const payload = record(event.payload)
      const message = record(payload?.message)
      if (!payload || !message || message.role !== 'assistant' || !Number.isInteger(payload.modelTurn) || Number(payload.modelTurn) < 1) return 'model-response-malformed'
      const rawCalls = message.toolCalls === undefined ? [] : message.toolCalls
      if (!Array.isArray(rawCalls)) return 'model-response-tools-malformed'
      const step: StepRecord = { eventId: event.eventId, modelTurn: Number(payload.modelTurn), toolIds: new Set(), terminalToolIds: new Set(), uncertainToolIds: new Set() }
      for (const rawCall of rawCalls) {
        const call = record(rawCall)
        if (typeof call?.id !== 'string' || !call.id.trim() || step.toolIds.has(call.id)) return 'model-response-tool-identity-invalid'
        step.toolIds.add(call.id)
        const matchingSteps = this.byToolId.get(call.id) ?? []
        matchingSteps.push(step)
        this.byToolId.set(call.id, matchingSteps)
      }
      this.steps.push(step)
      return undefined
    }
    if (event.kind !== 'tool-call-finished' && event.kind !== 'tool-call-not-dispatched' && event.kind !== 'tool-call-deferred') return undefined
    const payload = record(event.payload)
    if (typeof payload?.toolCallId !== 'string' || !payload.toolCallId.trim()) return 'tool-terminal-identity-invalid'
    const toolCallId = payload.toolCallId
    const modelTurn = payload.modelTurn
    const matchingSteps = this.byToolId.get(toolCallId)
    if (!matchingSteps?.length) return 'tool-terminal-without-response'
    const stepCandidates = modelTurn === undefined
      ? matchingSteps.filter((candidate) => !candidate.terminalToolIds.has(toolCallId) && !candidate.uncertainToolIds.has(toolCallId))
      : matchingSteps.filter((candidate) => candidate.modelTurn === modelTurn)
    if (modelTurn !== undefined && stepCandidates.length === 0 && matchingSteps.some((candidate) => candidate.modelTurn !== modelTurn)) return 'tool-terminal-turn-mismatch'
    if (stepCandidates.length !== 1) return stepCandidates.length === 0 ? 'tool-terminal-duplicate' : 'tool-terminal-ambiguous'
    const step = stepCandidates[0]!
    if (step.terminalToolIds.has(toolCallId) || step.uncertainToolIds.has(toolCallId)) return 'tool-terminal-duplicate'
    const outcome = event.kind === 'tool-call-finished' ? toolOutcome(payload) : 'known'
    if (outcome === 'invalid') return 'tool-terminal-outcome-invalid'
    if (outcome === 'uncertain') step.uncertainToolIds.add(toolCallId)
    else step.terminalToolIds.add(toolCallId)
    return undefined
  }
  private fail(caseId: string): SettledStepFacts { this.failedCase = caseId; return gap(caseId) }

  private toFacts(): SettledStepFacts {
    const settledStepIds: string[] = []
    const pendingStepIds: string[] = []
    for (const step of this.steps) {
      if (step.toolIds.size === step.terminalToolIds.size && step.uncertainToolIds.size === 0) settledStepIds.push(step.eventId)
      else pendingStepIds.push(step.eventId)
    }
    return { ok: true, settledCount: settledStepIds.length, settledStepIds, pendingStepIds }
  }
}

export function reduceSettledStepFacts(snapshot: HistorySnapshot): SettledStepFacts {
  return new SettledStepFactsTracker().update(snapshot)
}

export async function readSettledStepFacts(history: HistoryPort, invocationId: string): Promise<SettledStepFacts> {
  try {
    const snapshot = await history.read(invocationId)
    if (snapshot.invocationId !== invocationId) return gap('history-identity-mismatch')
    return reduceSettledStepFacts(snapshot)
  }
  catch { return { ok: false, settledCount: 0, settledStepIds: [], pendingStepIds: [], code: 'SOURCE_GAP', case: 'history-unavailable' } }
}

/** Aggregate complete, session-owned invocation ledgers in stable order for registration baselines and async scans. */
export async function readSessionSettledStepFacts(execution: Pick<SessionExecutionStore, 'historyFor'>, sessionId: string): Promise<SettledStepFacts> {
  try {
    if (!sessionId.trim()) return gap('session-identity-invalid')
    const history = execution.historyFor({ sessionId })
    // HistoryPort preserves the invocation creation order; new invocations append while each invocation's
    // settled steps append within its own transcript, so a count baseline remains a stable prefix.
    const invocationIds = history.listInvocationIds()
    const settledStepIds: string[] = []
    const pendingStepIds: string[] = []
    const settledCountByInvocation: Record<string, number> = {}
    for (const invocationId of invocationIds) {
      if (!invocationId.trim()) return gap('history-invocation-identity-invalid')
      const facts = await readSettledStepFacts(history, invocationId)
      if (!facts.ok) return facts
      settledCountByInvocation[invocationId] = facts.settledCount
      settledStepIds.push(...facts.settledStepIds.map((id) => `${invocationId}:${id}`))
      pendingStepIds.push(...facts.pendingStepIds.map((id) => `${invocationId}:${id}`))
    }
    return { ok: true, settledCount: settledStepIds.length, settledStepIds, pendingStepIds, settledCountByInvocation }
  } catch {
    return gap('session-history-unavailable')
  }
}

export type PersistedTurnTerminal = Readonly<{ kind: 'pending' } | { kind: 'terminal'; sessionId: string; turnId: string; outcome: string } | { kind: 'source-gap'; case: string }>

export function readPersistedTurnTerminal(value: unknown, sessionId: string, turnId: string): PersistedTurnTerminal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'source-gap', case: 'turn-unavailable' }
  const turn = value as UnknownRecord
  if (turn.sessionId !== sessionId || turn.turnId !== turnId) return { kind: 'source-gap', case: 'turn-identity-mismatch' }
  if (turn.state !== 'terminal') return ['prepared', 'configuring', 'executing'].includes(String(turn.state))
    ? { kind: 'pending' } : { kind: 'source-gap', case: 'turn-state-invalid' }
  if (typeof turn.outcome !== 'string' || !['completed', 'parked', 'failed', 'cancelled', 'timed-out', 'timed_out', 'interrupted', 'recovered', 'commit-uncertain'].includes(turn.outcome)) {
    return { kind: 'source-gap', case: 'turn-terminal-outcome-invalid' }
  }
  return { kind: 'terminal', sessionId, turnId, outcome: turn.outcome }
}

export function createTurnTerminalBus(readTurn: (sessionId: string, turnId: string) => unknown): {
  subscribe(sessionId: string, turnId: string, listener: (terminal: PersistedTurnTerminal) => void): () => void
  notify(sessionId: string, turnId: string): Promise<void>
} {
  const listeners = new Map<string, Set<(terminal: PersistedTurnTerminal) => void>>()
  const deliveredOutcome = new WeakMap<(terminal: PersistedTurnTerminal) => void, string>()
  const keyOf = (sessionId: string, turnId: string) => `${sessionId.length}:${sessionId}${turnId.length}:${turnId}`
  return {
    subscribe(sessionId, turnId, listener) {
      const key = keyOf(sessionId, turnId)
      const group = listeners.get(key) ?? new Set()
      group.add(listener)
      listeners.set(key, group)
      return () => {
        group.delete(listener)
        if (group.size === 0) listeners.delete(key)
      }
    },
    async notify(sessionId, turnId) {
      const key = keyOf(sessionId, turnId)
      const group = listeners.get(key)
      if (!group?.size) return
      let terminal: PersistedTurnTerminal
      try { terminal = readPersistedTurnTerminal(await readTurn(sessionId, turnId), sessionId, turnId) }
      catch { terminal = { kind: 'source-gap', case: 'turn-unavailable' } }
      if (terminal.kind === 'pending') return
      for (const listener of [...group]) {
        if (terminal.kind === 'terminal' && deliveredOutcome.get(listener) === terminal.outcome) continue
        if (terminal.kind === 'terminal') deliveredOutcome.set(listener, terminal.outcome)
        try { listener(terminal) } catch { /* Source subscribers cannot change the committed Turn outcome. */ }
      }
    }
  }
}

const turnTerminalBuses = new WeakMap<object, ReturnType<typeof createTurnTerminalBus>>()

/** Share one terminal notification bus per public SessionExecutionStore; each notification rereads persisted state. */
export function turnTerminalBusForExecution(execution: Pick<SessionExecutionStore, 'readTurn'>): ReturnType<typeof createTurnTerminalBus> {
  const key = execution as object
  let bus = turnTerminalBuses.get(key)
  if (!bus) {
    bus = createTurnTerminalBus((sessionId, turnId) => execution.readTurn({ sessionId, turnId }))
    turnTerminalBuses.set(key, bus)
  }
  return bus
}

/** Wrap TurnRuntime execution so subscribers are notified only after coordinator persistence settles. */
export async function runWithPersistedTurnTerminalNotification<T>(
  execution: Pick<SessionExecutionStore, 'readTurn'>,
  turn: Readonly<{ sessionId: string; turnId: string }>,
  run: () => Promise<T>
): Promise<T> {
  try { return await run() }
  finally {
    try { await turnTerminalBusForExecution(execution).notify(turn.sessionId, turn.turnId) }
    catch { /* Durable terminal scans remain authoritative; notification is an acceleration hint only. */ }
  }
}
