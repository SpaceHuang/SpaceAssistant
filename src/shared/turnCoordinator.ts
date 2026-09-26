import type { Message } from './domainTypes'
import { acceptedAssistantCheckpoint, reduceAssistantFact, type AssistantFactEvent, type TurnExecutionConfig, type TurnIntent, type TurnTerminal, type TurnOutcome } from './assistantFactAggregator'
import { canonicalQueueInput } from './queueInputFingerprint'
import { CheckpointQueue } from './checkpointQueue'
import { isTerminalMessageStatus } from './messageStatus'

export type PersistedMessage = { message: Message; sequence: number }
export type TurnStorage = {
  findByRequestId: (sessionId: string, requestId: string) => TurnStarted | undefined
  hasActiveTurn?: (sessionId: string) => boolean
  getMessage: (messageId: string) => Message | undefined
  append: (message: Omit<Message, 'schemaVersion'> & { schemaVersion?: number }) => PersistedMessage
  appendMany: (messages: Array<Omit<Message, 'schemaVersion'> & { schemaVersion?: number }>) => PersistedMessage[]
  prepareAtomic: (input: {
    user: Omit<Message, 'schemaVersion'> & { schemaVersion?: number }
    assistant: Omit<Message, 'schemaVersion'> & { schemaVersion?: number }
    turn: PersistedTurnRecord
  }) => { user: PersistedMessage; assistant: PersistedMessage }
  claimQueuedAtomic: (input: { sessionId: string; userMessageId: string; turnId: string; assistantMessageId: string; requestId: string; state?: string; startToken?: string; intentFingerprint?: string; excludeMessageIds?: string[]; executionConfig?: TurnExecutionConfig }) => { user: PersistedMessage; assistant: PersistedMessage }
  update: (messageId: string, patch: Partial<Message>) => PersistedMessage | null
  updateIfStreaming: (messageId: string, patch: Partial<Message>) => PersistedMessage | null
  checkpoint: (turnId: string, version: number, message: Message) => boolean
  listStreaming?: () => Message[]
  listRecoverableResidues?: () => Array<{ message: Message; turnId?: string; turnOutcome?: string }>
  finalizeResidueMessage?: (messageId: string, targetStatus: 'cancelled' | 'failed') => boolean
  listUnfinishedTurns: () => Array<{ turnId: string; assistantMessageId: string }>
  recoverTurn: (turnId: string, assistantMessageId: string) => boolean
  saveTurn: (turn: { turnId: string; requestId: string; sessionId: string; assistantMessageId: string; state: string; userMessageId?: string; contextBoundarySequence?: number; startToken?: string; intentFingerprint?: string; excludeMessageIds?: string[]; executionConfig?: TurnExecutionConfig }) => void
  updateTurnState: (turnId: string, state: string, patch?: { version?: number; outcome?: string; usage?: unknown; error?: { code: string; message: string } }) => void
}
export type TurnStarted = { turnId: string; requestId: string; sessionId: string; userMessage?: Message; assistantMessage: Message; version: number; startToken: string; intentFingerprint?: string; excludeMessageIds?: string[]; executionConfig?: TurnExecutionConfig; lastEventSeq?: number; persistedOutcome?: TurnOutcome; persistedUsage?: unknown; persistedError?: { code: string; message: string } }
export type TurnCoordinatorMetric =
  | { kind: 'event'; turnId: string; eventType: AssistantFactEvent['type']; durationMs: number; version: number }
  | { kind: 'checkpoint'; turnId: string; version: number; durationMs: number; accepted: boolean }
export type CoordinatorDeps = { now: () => number; id: () => string; finishingWindowMs?: number; onMetric?: (metric: TurnCoordinatorMetric) => void }
export type ModelResult = Pick<TurnTerminal, 'outcome'> & { error?: TurnTerminal['error']; usage?: unknown }
export type ModelSource = (turn: TurnStarted, token: string) => Promise<ModelResult | void>
export type PersistedTurnRecord = { turnId: string; requestId: string; sessionId: string; assistantMessageId: string; state: string; userMessageId?: string; contextBoundarySequence?: number; excludeMessageIds?: string[]; executionConfig?: TurnExecutionConfig; version?: number; outcome?: string; usage?: unknown; error?: { code: string; message: string }; intentFingerprint?: string; startToken?: string }
export type Checkpoint = (turnId: string, version: number, message: Message) => boolean | void | Promise<boolean | void>
export type CancelHook = (turnId: string) => void
const CHECKPOINT_INTERVAL_MS = 2_000

export function normalizeTurnExecutionConfig(config: TurnExecutionConfig): TurnExecutionConfig {
  return {
    ...(config.lane ? { lane: config.lane } : {}),
    ...(config.model?.trim() ? { model: config.model.trim() } : {}),
    ...(Number.isFinite(config.maximumContext) && config.maximumContext! > 0 ? { maximumContext: config.maximumContext } : {}),
    ...(config.maximumContextTrusted !== undefined ? { maximumContextTrusted: config.maximumContextTrusted } : {}),
    ...(config.llmServiceId?.trim() ? { llmServiceId: config.llmServiceId.trim() } : {}),
    ...(config.system?.trim() ? { system: config.system.trim() } : {}),
    ...(config.skillFragments?.length ? { skillFragments: config.skillFragments.filter((fragment) => typeof fragment === 'string' && fragment.trim()).map((fragment) => fragment.trim()) } : {}),
    ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
    ...(config.thinkingEffort !== undefined ? { thinkingEffort: config.thinkingEffort } : {}),
    ...(config.requestedThinkingEffort !== undefined ? { requestedThinkingEffort: config.requestedThinkingEffort } : {}),
    ...(config.enableThinking !== undefined ? { enableThinking: config.enableThinking } : {}),
    ...(config.locale?.trim() ? { locale: config.locale.trim() } : {}),
    ...(config.projectMemoryEnabled !== undefined ? { projectMemoryEnabled: config.projectMemoryEnabled } : {}),
    ...(config.effectiveModelForUsage?.trim() ? { effectiveModelForUsage: config.effectiveModelForUsage.trim() } : {})
  }
}

export class TurnCoordinator {
  private readonly turns = new Map<string, TurnStarted>()
  private readonly executions = new Map<string, Promise<ModelResult | void>>()
  private readonly recovered = new Set<string>()
  private readonly terminals = new Map<string, TurnTerminal>()
  private readonly checkpointTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly checkpointRetries = new Map<string, number>()
  private readonly committedVersions = new Map<string, number>()
  private readonly checkpointInFlight = new Set<string>()
  private readonly checkpointFailed = new Set<string>()
  private readonly checkpointQueue = new CheckpointQueue()
  private readonly finishing = new Map<string, { outcome: 'cancelled' | 'timed-out'; timer: ReturnType<typeof setTimeout> }>()
  constructor(private readonly storage: TurnStorage, private readonly deps: CoordinatorDeps, private readonly checkpoint: Checkpoint = (turnId, version, message) => this.storage.checkpoint(turnId, version, message), private readonly cancelHook: CancelHook = () => {}) {}

  prepare(intent: TurnIntent, initialState = 'prepared'): TurnStarted {
    const existing = this.storage.findByRequestId(intent.sessionId, intent.requestId) ?? [...this.turns.values()].find((turn) => turn.sessionId === intent.sessionId && turn.requestId === intent.requestId)
    if (existing) {
      const fingerprint = this.intentFingerprint(intent)
      const matches = existing.executionConfig
        ? existing.intentFingerprint === fingerprint
        : this.matchesLegacyIntentFingerprint(existing.intentFingerprint, intent)
      if (existing.intentFingerprint && !matches) {
        throw new Error('TURN_REQUEST_FINGERPRINT_MISMATCH')
      }
      this.turns.set(existing.turnId, existing)
      return existing
    }
    if (this.storage.hasActiveTurn?.(intent.sessionId)) throw new Error('SESSION_TURN_BUSY')
    this.validateExclusions(intent)
    let userMessage: Message | undefined
    if (intent.mode === 'reuse-user') {
      userMessage = this.storage.getMessage(intent.userMessageId)
      if (!userMessage || userMessage.sessionId !== intent.sessionId) throw new Error('TURN_REUSE_SESSION_MISMATCH')
      if (userMessage.role !== 'user' || (userMessage.status !== 'sent' && userMessage.status !== 'queued')) throw new Error('TURN_REUSE_TARGET_NOT_USER')
      if (userMessage.status === 'queued') {
        const turnId = this.deps.id()
        const assistantId = this.deps.id()
        const startToken = this.deps.id()
        const claimed = this.storage.claimQueuedAtomic({
          sessionId: intent.sessionId,
          userMessageId: userMessage.id,
          turnId,
          assistantMessageId: assistantId,
          requestId: intent.requestId,
          state: initialState,
          startToken,
          intentFingerprint: this.intentFingerprint(intent),
          excludeMessageIds: intent.excludeMessageIds,
          executionConfig: normalizeTurnExecutionConfig(intent.config)
        })
        const started = this.makeStarted(intent, claimed.user.message, claimed.assistant.message, { turnId, startToken, persist: false, state: initialState })
        this.turns.set(started.turnId, started)
        return started
      }
    } else {
      const user = { id: this.deps.id(), sessionId: intent.sessionId, role: 'user' as const, content: intent.input.text, attachments: intent.input.attachments, timestamp: this.deps.now(), status: 'sent' as const }
      const assistant = { id: this.deps.id(), sessionId: intent.sessionId, role: 'assistant' as const, content: '', timestamp: this.deps.now(), status: 'streaming' as const }
      const turnId = this.deps.id()
      const startToken = this.deps.id()
      const appended = this.storage.prepareAtomic({ user, assistant, turn: { turnId, requestId: intent.requestId, sessionId: intent.sessionId, assistantMessageId: assistant.id, state: initialState, startToken, intentFingerprint: this.intentFingerprint(intent), excludeMessageIds: intent.excludeMessageIds, executionConfig: normalizeTurnExecutionConfig(intent.config) } })
      userMessage = appended.user.message
      const started = this.makeStarted(intent, userMessage, appended.assistant.message, { turnId, startToken, persist: false })
      this.turns.set(started.turnId, started)
      return started
    }
    const assistant = this.storage.append({ id: this.deps.id(), sessionId: intent.sessionId, role: 'assistant', content: '', timestamp: this.deps.now(), status: 'streaming' })
    const started = this.makeStarted(intent, userMessage, assistant.message, {
      contextBoundarySequence: assistant.sequence - 1,
      state: initialState
    })
    this.turns.set(started.turnId, started)
    return started
  }

  private validateExclusions(intent: TurnIntent): void {
    for (const messageId of intent.excludeMessageIds ?? []) {
      if (intent.mode === 'reuse-user' && messageId === intent.userMessageId) throw new Error('exclude cannot contain required user')
      const message = this.storage.getMessage(messageId)
      if (!message || message.sessionId !== intent.sessionId) throw new Error('exclude message session mismatch')
    }
  }

  private intentFingerprint(intent: TurnIntent): string {
    return JSON.stringify({ mode: intent.mode, userMessageId: intent.mode === 'reuse-user' ? intent.userMessageId : undefined, input: intent.mode === 'create-user' ? canonicalQueueInput(intent.input) : undefined, excludeMessageIds: [...(intent.excludeMessageIds ?? [])].sort(), config: normalizeTurnExecutionConfig(intent.config) })
  }

  /** v11 及更早的 turn 没有执行快照；重放时只核对可持久验证的消息意图，不把当前设置当作原请求。 */
  private matchesLegacyIntentFingerprint(persistedFingerprint: string | undefined, intent: TurnIntent): boolean {
    if (!persistedFingerprint) return true
    try {
      const persisted = JSON.parse(persistedFingerprint) as Record<string, unknown>
      const current = JSON.parse(this.intentFingerprint(intent)) as Record<string, unknown>
      return persisted.mode === current.mode
        && persisted.userMessageId === current.userMessageId
        && persisted.input === current.input
        && JSON.stringify(persisted.excludeMessageIds) === JSON.stringify(current.excludeMessageIds)
    } catch {
      return false
    }
  }

  private makeStarted(
    intent: TurnIntent,
    userMessage: Message | undefined,
    assistantMessage: Message | undefined,
    options: { turnId?: string; startToken?: string; persist?: boolean; contextBoundarySequence?: number; state?: string } = {}
  ): TurnStarted {
    if (!userMessage || !assistantMessage) throw new Error('atomic prepare returned incomplete messages')
    const turnId = options.turnId ?? this.deps.id()
    const startToken = options.startToken ?? this.deps.id()
    const started = { turnId, requestId: intent.requestId, sessionId: intent.sessionId, userMessage, assistantMessage, version: 0, startToken, intentFingerprint: this.intentFingerprint(intent), excludeMessageIds: intent.excludeMessageIds, executionConfig: normalizeTurnExecutionConfig(intent.config) }
    if (options.persist !== false) this.storage.saveTurn({
      turnId: started.turnId,
      requestId: started.requestId,
      sessionId: started.sessionId,
      assistantMessageId: assistantMessage.id,
      userMessageId: userMessage.id,
      contextBoundarySequence: options.contextBoundarySequence,
      state: options.state ?? 'prepared',
      startToken: started.startToken,
      intentFingerprint: started.intentFingerprint,
      excludeMessageIds: started.excludeMessageIds,
      executionConfig: started.executionConfig
    })
    return started
  }

  execute(turnId: string, token: string, source: ModelSource): Promise<ModelResult | void> {
    const current = this.turns.get(turnId)
    if (!current || current.startToken !== token) return Promise.reject(new Error('invalid turn start token'))
    if (current.persistedOutcome) {
      return Promise.resolve({ outcome: current.persistedOutcome, usage: current.persistedUsage, error: current.persistedError } as ModelResult)
    }
    const running = this.executions.get(turnId)
    if (running) return running
    this.storage.updateTurnState(turnId, 'executing', { version: current.version })
    const promise = source(current, token).then((terminal) => {
      const pendingFinish = this.finishing.get(turnId)
      if (pendingFinish) {
        this.finalizeFinishing(turnId, pendingFinish.outcome)
        return { outcome: pendingFinish.outcome } as ModelResult
      }
      if (!terminal) return terminal
      const latest = this.turns.get(turnId) ?? current
      const alreadyTerminal = isTerminalMessageStatus(latest.assistantMessage.status)
      const status = terminal.outcome === 'completed' ? 'completed' : terminal.outcome === 'cancelled' ? 'cancelled' : 'failed'
      // source 只能报告 outcome/usage/error；权威 Message 必须来自 consume/reducer。
      const message = latest.assistantMessage
      const finalMessage: Message = alreadyTerminal
        ? latest.assistantMessage
        : { ...acceptedAssistantCheckpoint(message), id: latest.assistantMessage.id, status: status as Message['status'] }
      if (!alreadyTerminal) {
        const finalizedTurn = { ...latest, assistantMessage: finalMessage }
        this.turns.set(turnId, finalizedTurn)
        this.flushCheckpoint(turnId, finalizedTurn)
      }
      const acceptedTerminal = this.terminals.get(turnId)
      const acceptedOutcome = acceptedTerminal?.outcome ?? (alreadyTerminal && latest.assistantMessage.status === 'completed' ? 'completed' : terminal.outcome)
      this.terminals.set(turnId, { turnId, requestId: latest.requestId, sessionId: latest.sessionId, assistantMessageId: latest.assistantMessage.id, version: latest.version, outcome: acceptedOutcome, message: finalMessage, error: acceptedTerminal?.error ?? terminal.error })
      if (!acceptedTerminal) this.storage.updateTurnState(turnId, 'terminal', { version: latest.version, outcome: acceptedOutcome, usage: terminal.usage, ...(terminal.error ? { error: terminal.error } : {}) })
      return terminal
    }).catch((error: unknown) => {
      const pendingFinish = this.finishing.get(turnId)
      if (pendingFinish) {
        this.finalizeFinishing(turnId, pendingFinish.outcome, { code: 'source-cleanup-failed', message: error instanceof Error ? error.message : String(error) })
        return { outcome: pendingFinish.outcome, error: { code: 'source-cleanup-failed', message: error instanceof Error ? error.message : String(error) } } as ModelResult
      }
      const latest = this.turns.get(turnId) ?? current
      const preserveCancelled = isTerminalMessageStatus(latest.assistantMessage.status) && latest.assistantMessage.status === 'cancelled'
      const message = { ...acceptedAssistantCheckpoint(latest.assistantMessage), status: preserveCancelled ? 'cancelled' as const : 'failed' as const }
      const finalized = { ...latest, assistantMessage: message }
      this.turns.set(turnId, finalized)
      this.flushCheckpoint(turnId, finalized)
      const errorOutcome = preserveCancelled ? 'cancelled' : 'failed'
      this.terminals.set(turnId, { turnId, requestId: latest.requestId, sessionId: latest.sessionId, assistantMessageId: message.id, version: latest.version, outcome: errorOutcome, message, error: { code: 'source-failed', message: error instanceof Error ? error.message : String(error) } })
      this.storage.updateTurnState(turnId, 'terminal', { version: latest.version, outcome: errorOutcome, error: { code: 'source-failed', message: error instanceof Error ? error.message : String(error) } })
      throw error
    })
    this.executions.set(turnId, promise)
    return promise
  }

  consume(turnId: string, event: AssistantFactEvent): TurnStarted {
    const metricStart = typeof performance !== 'undefined' ? performance.now() : 0
    const turn = this.turns.get(turnId)
    if (!turn) throw new Error('unknown turn')
    if (isTerminalMessageStatus(turn.assistantMessage.status)) return turn
    if (this.finishing.has(turnId) && !this.isFinishingEventAllowed(event.type)) return turn
    if (event.eventSeq != null) {
      const last = turn.lastEventSeq ?? 0
      if (event.eventSeq <= last) return turn
      if (event.eventSeq !== last + 1) throw new Error(`TURN_EVENT_SEQUENCE_GAP:${last + 1}:${event.eventSeq}`)
    }
    const message = reduceAssistantFact(turn.assistantMessage, event, { now: this.deps.now(), createId: this.deps.id })
    const version = turn.version + 1
    const updated = { ...turn, assistantMessage: message, version, ...(event.eventSeq != null ? { lastEventSeq: event.eventSeq } : {}) }
    this.turns.set(turnId, updated)
    if (this.isImmediateCheckpointEvent(event.type)) {
      this.flushCheckpoint(turnId, updated)
    } else {
      this.scheduleCheckpoint(turnId)
    }
    this.deps.onMetric?.({ kind: 'event', turnId, eventType: event.type, durationMs: Math.max(0, (typeof performance !== 'undefined' ? performance.now() : 0) - metricStart), version })
    return updated
  }

  private isImmediateCheckpointEvent(type: AssistantFactEvent['type']): boolean {
    return type === 'confirm-requested'
      || type === 'content-reconciled'
      || type === 'thinking-reconciled'
      || type === 'tool-confirmed'
      || type === 'tool-result'
      || type === 'source-completed'
      || type === 'source-failed'
      || type === 'source-cancelled'
      || type === 'source-timeout'
  }

  private scheduleCheckpoint(turnId: string): void {
    if (this.checkpointTimers.has(turnId)) return
    const timer = setTimeout(() => {
      this.checkpointTimers.delete(turnId)
      const current = this.turns.get(turnId)
      if (current) this.persistCheckpoint(turnId, current)
    }, CHECKPOINT_INTERVAL_MS)
    this.checkpointTimers.set(turnId, timer)
  }

  private flushCheckpoint(turnId: string, turn: TurnStarted): void {
    const timer = this.checkpointTimers.get(turnId)
    if (timer) clearTimeout(timer)
    this.checkpointTimers.delete(turnId)
    this.persistCheckpoint(turnId, turn)
  }

  private persistCheckpoint(turnId: string, turn: TurnStarted): void {
    this.checkpointInFlight.add(turnId)
    const metricStart = typeof performance !== 'undefined' ? performance.now() : 0
    let result: boolean | void | Promise<boolean | void>
    try {
      result = this.checkpointQueue.enqueue(turnId, () => this.checkpoint(turnId, turn.version, acceptedAssistantCheckpoint(turn.assistantMessage)))
    } catch {
      result = false
    }
    if (result && typeof result === 'object' && 'then' in result) {
      void result.then((accepted) => {
        this.deps.onMetric?.({ kind: 'checkpoint', turnId, version: turn.version, durationMs: Math.max(0, (typeof performance !== 'undefined' ? performance.now() : 0) - metricStart), accepted: accepted !== false })
        this.finishCheckpoint(turnId, accepted, turn.version)
      }, () => {
        this.deps.onMetric?.({ kind: 'checkpoint', turnId, version: turn.version, durationMs: Math.max(0, (typeof performance !== 'undefined' ? performance.now() : 0) - metricStart), accepted: false })
        this.finishCheckpoint(turnId, false, turn.version)
      })
      return
    }
    this.deps.onMetric?.({ kind: 'checkpoint', turnId, version: turn.version, durationMs: Math.max(0, (typeof performance !== 'undefined' ? performance.now() : 0) - metricStart), accepted: result !== false })
    this.finishCheckpoint(turnId, result, turn.version)
  }

  private finishCheckpoint(turnId: string, accepted: boolean | void, committedVersion: number): void {
    this.checkpointInFlight.delete(turnId)
    if (accepted !== false) {
      this.committedVersions.set(turnId, Math.max(this.committedVersions.get(turnId) ?? -1, committedVersion))
      this.checkpointRetries.delete(turnId)
      this.checkpointFailed.delete(turnId)
      return
    }
    const current = this.turns.get(turnId)
    if (current && (isTerminalMessageStatus(current.assistantMessage.status))) {
      const retries = this.checkpointRetries.get(turnId) ?? 0
      if (retries >= 3) this.checkpointFailed.add(turnId)
      else { this.checkpointRetries.set(turnId, retries + 1); this.checkpointTimers.set(turnId, setTimeout(() => { this.checkpointTimers.delete(turnId); this.persistCheckpoint(turnId, current) }, 100)) }
      return
    }
    const retries = this.checkpointRetries.get(turnId) ?? 0
    if (retries >= 3 || this.checkpointTimers.has(turnId)) return
    this.checkpointRetries.set(turnId, retries + 1)
    this.checkpointTimers.set(turnId, setTimeout(() => {
      this.checkpointTimers.delete(turnId)
      const current = this.turns.get(turnId)
      if (current) this.persistCheckpoint(turnId, current)
    }, 100))
  }

  cancel(turnId: string): boolean {
    const turn = this.turns.get(turnId)
    if (!turn || isTerminalMessageStatus(turn.assistantMessage.status)) return false
    if (this.finishing.has(turnId)) return false
    this.cancelHook(turnId)
    if (this.executions.has(turnId)) {
      this.beginFinishing(turnId, 'cancelled')
    } else {
      this.finalizeFinishing(turnId, 'cancelled')
    }
    return true
  }

  timeout(turnId: string): boolean {
    const turn = this.turns.get(turnId)
    if (!turn || isTerminalMessageStatus(turn.assistantMessage.status)) return false
    if (this.finishing.has(turnId)) return false
    this.cancelHook(turnId)
    if (this.executions.has(turnId)) this.beginFinishing(turnId, 'timed-out')
    else this.finalizeFinishing(turnId, 'timed-out')
    return true
  }

  private isFinishingEventAllowed(type: AssistantFactEvent['type']): boolean {
    return type === 'content-delta' || type === 'thinking-delta' || type === 'content-reconciled' || type === 'thinking-reconciled' || type === 'preview-rollback' || type === 'tool-progress' || type === 'tool-result'
  }

  private beginFinishing(turnId: string, outcome: 'cancelled' | 'timed-out'): void {
    const timer = setTimeout(() => this.finalizeFinishing(turnId, outcome), this.deps.finishingWindowMs ?? 5_000)
    this.finishing.set(turnId, { outcome, timer })
  }

  private finalizeFinishing(turnId: string, outcome: 'cancelled' | 'timed-out', error?: { code: string; message: string }): void {
    const pending = this.finishing.get(turnId)
    if (pending) clearTimeout(pending.timer)
    this.finishing.delete(turnId)
    const current = this.turns.get(turnId)
    if (!current || isTerminalMessageStatus(current.assistantMessage.status)) return
    const finalized = this.consume(turnId, { type: outcome === 'cancelled' ? 'source-cancelled' : 'source-timeout' })
    this.storage.updateTurnState(turnId, 'terminal', { version: finalized.version, outcome, ...(error ? { error } : {}) })
    this.terminals.set(turnId, { ...this.makeTerminal(finalized, outcome), ...(error ? { error } : {}) })
  }

  recover(): number {
    const unfinished = this.storage.listUnfinishedTurns()
    let recovered = 0
    for (const turn of unfinished) {
      if (this.recovered.has(turn.assistantMessageId)) continue
      if (this.storage.recoverTurn(turn.turnId, turn.assistantMessageId)) {
        this.recovered.add(turn.assistantMessageId)
        const inMemory = this.turns.get(turn.turnId)
        if (inMemory) {
          const failedMessage = { ...acceptedAssistantCheckpoint(inMemory.assistantMessage), status: 'failed' as const }
          const recoveredTurn = { ...inMemory, assistantMessage: failedMessage, persistedOutcome: 'recovered' as const }
          this.turns.set(turn.turnId, recoveredTurn)
          this.terminals.set(turn.turnId, { turnId: turn.turnId, requestId: inMemory.requestId, sessionId: inMemory.sessionId, assistantMessageId: failedMessage.id, version: inMemory.version, outcome: 'recovered', message: failedMessage })
        }
        recovered++
      }
    }
    const residues: Array<{ message: Message; turnId?: string; turnOutcome?: string }> = this.storage.listRecoverableResidues?.() ?? (this.storage.listStreaming?.() ?? []).map((message) => ({ message }))
    for (const message of residues) {
      const residue = message
      const m = residue.message
      if (m.role !== 'assistant' || m.status !== 'streaming') continue
      if (this.recovered.has(m.id)) continue
      const owned = [...this.turns.values()].find((turn) => turn.assistantMessage.id === m.id)
      const cancelled = residue.turnOutcome === 'cancelled' || owned?.persistedOutcome === 'cancelled'
      const result = cancelled
        ? (this.storage.finalizeResidueMessage?.(m.id, 'cancelled') ?? this.storage.updateIfStreaming(m.id, { ...m, status: 'cancelled' }))
        : residue.turnId
        ? (this.storage.recoverTurn(residue.turnId, m.id) ? { message: { ...m, status: 'failed' as const }, sequence: 0 } : null)
        : owned?.turnId
        ? (this.storage.recoverTurn(owned.turnId, m.id) ? { message: { ...m, status: 'failed' as const }, sequence: 0 } : null)
        : this.storage.updateIfStreaming(m.id, { ...m, status: 'failed' })
      if (result) {
        this.recovered.add(m.id)
        if (cancelled && owned) {
          const converged = { ...owned, assistantMessage: { ...owned.assistantMessage, status: 'cancelled' as const }, persistedOutcome: 'cancelled' as const }
          this.turns.set(owned.turnId, converged)
          this.terminals.set(owned.turnId, this.makeTerminal(converged, 'cancelled'))
        }
        recovered++
      }
    }
    return recovered
  }

  restoreTurn(record: PersistedTurnRecord, assistantMessage: Message): TurnStarted {
    if (assistantMessage.id !== record.assistantMessageId || assistantMessage.sessionId !== record.sessionId) throw new Error('persisted turn assistant mismatch')
    const userMessage = record.userMessageId ? this.storage.getMessage(record.userMessageId) : undefined
    if (record.userMessageId && (!userMessage || userMessage.sessionId !== record.sessionId || userMessage.role !== 'user')) {
      throw new Error('persisted turn user mismatch')
    }
    const restored: TurnStarted = {
      turnId: record.turnId,
      requestId: record.requestId,
      sessionId: record.sessionId,
      ...(userMessage ? { userMessage } : {}),
      assistantMessage,
      version: record.version ?? 0,
      startToken: record.startToken ?? this.deps.id(),
      ...(record.outcome ? { persistedOutcome: record.outcome as TurnOutcome } : {}),
      ...(record.usage !== undefined ? { persistedUsage: record.usage } : {}),
      ...(record.error ? { persistedError: record.error } : {}),
      ...(record.intentFingerprint ? { intentFingerprint: record.intentFingerprint } : {}),
      ...(record.excludeMessageIds ? { excludeMessageIds: record.excludeMessageIds } : {}),
      ...(record.executionConfig ? { executionConfig: normalizeTurnExecutionConfig(record.executionConfig) } : {})
    }
    this.turns.set(record.turnId, restored)
    return restored
  }

  getTerminal(turnId: string): TurnTerminal | undefined { return this.terminals.get(turnId) }
  getCommittedVersion(turnId: string): number | undefined { return this.committedVersions.get(turnId) }
  getCheckpointStatus(turnId: string, targetVersion?: number): 'pending' | 'committed' | 'failed' {
    if (this.checkpointFailed.has(turnId)) return 'failed'
    const committedVersion = this.committedVersions.get(turnId)
    if (committedVersion === undefined) return 'pending'
    return targetVersion === undefined || committedVersion >= targetVersion ? 'committed' : 'pending'
  }
  retryCheckpoint(turnId: string): void { const turn = this.turns.get(turnId); if (turn && !this.checkpointInFlight.has(turnId)) this.persistCheckpoint(turnId, turn) }
  listTerminals(sessionId?: string): TurnTerminal[] { return [...this.terminals.values()].filter((terminal) => !sessionId || terminal.sessionId === sessionId) }
  /** 重开页面只能拿到消息，拿不到 turnId：按 assistantMessageId 回查内存终态（失败原因只在这里和 turns 表里）。 */
  getTerminalByAssistantMessageId(assistantMessageId: string): TurnTerminal | undefined {
    for (const terminal of this.terminals.values()) {
      if (terminal.assistantMessageId === assistantMessageId) return terminal
    }
    return undefined
  }
  getTurn(turnId: string): TurnStarted | undefined { return this.turns.get(turnId) }
  listActive(sessionId?: string): TurnStarted[] {
    return [...this.turns.values()].filter((turn) => (!sessionId || turn.sessionId === sessionId) && !isTerminalMessageStatus(turn.assistantMessage.status))
  }
  private makeTerminal(turn: TurnStarted, outcome: TurnTerminal['outcome']): TurnTerminal {
    return { turnId: turn.turnId, requestId: turn.requestId, sessionId: turn.sessionId, assistantMessageId: turn.assistantMessage.id, version: turn.version, outcome, message: { ...turn.assistantMessage, status: outcome === 'cancelled' ? 'cancelled' : 'failed' } }
  }
}
