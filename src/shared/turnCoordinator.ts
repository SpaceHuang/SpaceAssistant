import type { Message } from './domainTypes'
import { reduceAssistantFact, type AssistantFactEvent, type TurnExecutionConfig, type TurnIntent, type TurnTerminal, type TurnOutcome } from './assistantFactAggregator'
import { canonicalQueueInput } from './queueInputFingerprint'
import { CheckpointQueue } from './checkpointQueue'

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
    ...(config.llmServiceId?.trim() ? { llmServiceId: config.llmServiceId.trim() } : {}),
    ...(config.baseUrl?.trim() ? { baseUrl: config.baseUrl.trim().replace(/\/+$/, '') } : {}),
    ...(config.system?.trim() ? { system: config.system.trim() } : {}),
    ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
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
      if (!userMessage || userMessage.sessionId !== intent.sessionId) throw new Error('reuse user message session mismatch')
      if (userMessage.role !== 'user' || (userMessage.status !== 'sent' && userMessage.status !== 'queued')) throw new Error('reuse target must be a user message')
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
      const alreadyTerminal = latest.assistantMessage.status === 'completed' || latest.assistantMessage.status === 'failed'
      const status = terminal.outcome === 'completed' ? 'completed' : 'failed'
      // source 只能报告 outcome/usage/error；权威 Message 必须来自 consume/reducer。
      const message = latest.assistantMessage
      const finalMessage: Message = alreadyTerminal
        ? latest.assistantMessage
        : { ...message, id: latest.assistantMessage.id, status: status as Message['status'] }
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
      const message = { ...latest.assistantMessage, status: 'failed' as const }
      const finalized = { ...latest, assistantMessage: message }
      this.turns.set(turnId, finalized)
      this.flushCheckpoint(turnId, finalized)
      this.terminals.set(turnId, { turnId, requestId: latest.requestId, sessionId: latest.sessionId, assistantMessageId: message.id, version: latest.version, outcome: 'failed', message, error: { code: 'source-failed', message: error instanceof Error ? error.message : String(error) } })
      this.storage.updateTurnState(turnId, 'terminal', { version: latest.version, outcome: 'failed', error: { code: 'source-failed', message: error instanceof Error ? error.message : String(error) } })
      throw error
    })
    this.executions.set(turnId, promise)
    return promise
  }

  consume(turnId: string, event: AssistantFactEvent): TurnStarted {
    const metricStart = typeof performance !== 'undefined' ? performance.now() : 0
    const turn = this.turns.get(turnId)
    if (!turn) throw new Error('unknown turn')
    if (turn.assistantMessage.status === 'completed' || turn.assistantMessage.status === 'failed') return turn
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
    const metricStart = typeof performance !== 'undefined' ? performance.now() : 0
    let result: boolean | void | Promise<boolean | void>
    try {
      result = this.checkpointQueue.enqueue(turnId, () => this.checkpoint(turnId, turn.version, turn.assistantMessage))
    } catch {
      result = false
    }
    if (result && typeof result === 'object' && 'then' in result) {
      void result.then((accepted) => {
        this.deps.onMetric?.({ kind: 'checkpoint', turnId, version: turn.version, durationMs: Math.max(0, (typeof performance !== 'undefined' ? performance.now() : 0) - metricStart), accepted: accepted !== false })
        this.finishCheckpoint(turnId, accepted)
      }, () => {
        this.deps.onMetric?.({ kind: 'checkpoint', turnId, version: turn.version, durationMs: Math.max(0, (typeof performance !== 'undefined' ? performance.now() : 0) - metricStart), accepted: false })
        this.finishCheckpoint(turnId, false)
      })
      return
    }
    this.deps.onMetric?.({ kind: 'checkpoint', turnId, version: turn.version, durationMs: Math.max(0, (typeof performance !== 'undefined' ? performance.now() : 0) - metricStart), accepted: result !== false })
    this.finishCheckpoint(turnId, result)
  }

  private finishCheckpoint(turnId: string, accepted: boolean | void): void {
    if (accepted !== false) {
      this.checkpointRetries.delete(turnId)
      return
    }
    const current = this.turns.get(turnId)
    if (current && (current.assistantMessage.status === 'completed' || current.assistantMessage.status === 'failed')) {
      // 旧的异步 checkpoint 在 terminal 已经提交/排队后才失败，不得重新
      // 安排 retry timer 覆盖终态；terminal 路径拥有最后一次写入责任。
      this.checkpointRetries.delete(turnId)
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
    if (!turn || turn.assistantMessage.status === 'completed' || turn.assistantMessage.status === 'failed') return false
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
    if (!turn || turn.assistantMessage.status === 'completed' || turn.assistantMessage.status === 'failed') return false
    if (this.finishing.has(turnId)) return false
    this.cancelHook(turnId)
    if (this.executions.has(turnId)) this.beginFinishing(turnId, 'timed-out')
    else this.finalizeFinishing(turnId, 'timed-out')
    return true
  }

  private isFinishingEventAllowed(type: AssistantFactEvent['type']): boolean {
    return type === 'content-delta' || type === 'thinking-delta' || type === 'tool-progress' || type === 'tool-result'
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
    if (!current || current.assistantMessage.status === 'completed' || current.assistantMessage.status === 'failed') return
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
        recovered++
      }
    }
    if (unfinished.length > 0) return recovered

    const residues = this.storage.listStreaming?.() ?? []
    recovered = 0
    for (const message of residues) {
      if (message.role !== 'assistant' || message.status !== 'streaming') continue
      if (this.recovered.has(message.id)) continue
      const owned = [...this.turns.values()].find((turn) => turn.assistantMessage.id === message.id)
      const result = owned?.turnId
        ? (this.storage.recoverTurn(owned.turnId, message.id) ? { message: { ...message, status: 'failed' as const }, sequence: 0 } : null)
        : this.storage.updateIfStreaming(message.id, { ...message, status: 'failed' })
      if (result) { this.recovered.add(message.id); recovered++ }
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
  getTurn(turnId: string): TurnStarted | undefined { return this.turns.get(turnId) }
  listActive(sessionId?: string): TurnStarted[] {
    return [...this.turns.values()].filter((turn) => (!sessionId || turn.sessionId === sessionId) && turn.assistantMessage.status !== 'completed' && turn.assistantMessage.status !== 'failed')
  }
  private makeTerminal(turn: TurnStarted, outcome: TurnTerminal['outcome']): TurnTerminal {
    return { turnId: turn.turnId, requestId: turn.requestId, sessionId: turn.sessionId, assistantMessageId: turn.assistantMessage.id, version: turn.version, outcome, message: { ...turn.assistantMessage, status: 'failed' } }
  }
}
