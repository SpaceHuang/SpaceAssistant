import type { AssistantFactEvent, TurnIntent, TurnTerminal } from '../src/shared/assistantFactAggregator'
import { TurnCoordinator, type CoordinatorDeps, type ModelResult, type ModelSource, type TurnStarted, type TurnStorage } from '../src/shared/turnCoordinator'

export type TurnRuntimeOptions = {
  storage: TurnStorage
  deps: CoordinatorDeps
  source?: ModelSource
  onEvent?: (turn: TurnStarted, event: AssistantFactEvent) => void
  onCancel?: (turn: TurnStarted) => void
}

export type TurnProjectionListener = (turn: TurnStarted, event: AssistantFactEvent) => void

/** 主进程唯一 turn owner：Coordinator、source 和事实 projection 在此装配。 */
export class TurnRuntime {
  readonly coordinator: TurnCoordinator
  private readonly source: ModelSource
  private readonly onEvent?: TurnRuntimeOptions['onEvent']
  private readonly listeners = new Set<TurnProjectionListener>()
  private readonly requestToTurn = new Map<string, string>()
  private readonly requestEventSeq = new Map<string, number>()

  constructor(options: TurnRuntimeOptions) {
    this.source = options.source ?? (async () => { throw new Error('TURN_MODEL_SOURCE_NOT_CONFIGURED') })
    this.onEvent = options.onEvent
    this.coordinator = new TurnCoordinator(options.storage, options.deps, undefined, (turnId) => {
      const turn = this.coordinator.getTurn(turnId)
      if (turn) options.onCancel?.(turn)
    })
  }

  prepare(intent: TurnIntent): TurnStarted { return this.coordinator.prepare(intent) }

  bindRequest(requestId: string, turnId: string): void {
    const turn = this.coordinator.getTurn(turnId)
    if (!turn || turn.requestId !== requestId) throw new Error('turn request mismatch')
    this.requestToTurn.set(requestId, turnId)
  }

  subscribe(listener: TurnProjectionListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  unbindRequest(requestId: string): void { this.requestToTurn.delete(requestId); this.requestEventSeq.delete(requestId) }

  consumeForRequest(requestId: string, event: AssistantFactEvent): TurnStarted {
    const turnId = this.requestToTurn.get(requestId)
    if (!turnId) throw new Error('unknown turn request')
    const nextEvent = event.eventSeq == null
      ? { ...event, eventSeq: (this.requestEventSeq.get(requestId) ?? 0) + 1 }
      : event
    const turn = this.consume(turnId, nextEvent)
    if (nextEvent.eventSeq != null) this.requestEventSeq.set(requestId, nextEvent.eventSeq)
    if (nextEvent.type === 'source-completed' || nextEvent.type === 'source-failed' || nextEvent.type === 'source-cancelled' || nextEvent.type === 'source-timeout') this.unbindRequest(requestId)
    return turn
  }

  consume(turnId: string, event: AssistantFactEvent): TurnStarted {
    const before = this.coordinator.getTurn(turnId)?.version
    const turn = this.coordinator.consume(turnId, event)
    if (before === turn.version) return turn
    this.onEvent?.(turn, event)
    for (const listener of this.listeners) listener(turn, event)
    return turn
  }

  async execute(turnId: string, token: string): Promise<ModelResult | void> {
    const before = this.coordinator.getTurn(turnId)?.version
    const result = await this.coordinator.execute(turnId, token, this.source)
    this.publishTerminalResultProjection(turnId, before, result)
    return result
  }

  async executeWithSource(turnId: string, token: string, source: ModelSource): Promise<ModelResult | void> {
    const before = this.coordinator.getTurn(turnId)?.version
    const result = await this.coordinator.execute(turnId, token, async (turn, startToken) => {
      try {
        return await source(turn, startToken)
      } catch (error) {
        const current = this.coordinator.getTurn(turnId)
        if (current && current.assistantMessage.status !== 'completed' && current.assistantMessage.status !== 'failed') {
          this.consume(turnId, { type: 'source-failed' })
        }
        throw error
      }
    })
    this.publishTerminalResultProjection(turnId, before, result)
    return result
  }

  cancel(turnId: string): boolean {
    const before = this.coordinator.getTurn(turnId)?.version
    const accepted = this.coordinator.cancel(turnId)
    this.publishControlProjection(turnId, before, 'source-cancelled')
    return accepted
  }

  timeout(turnId: string): boolean {
    const before = this.coordinator.getTurn(turnId)?.version
    const accepted = this.coordinator.timeout(turnId)
    this.publishControlProjection(turnId, before, 'source-timeout')
    return accepted
  }

  private publishControlProjection(turnId: string, before: number | undefined, type: 'source-cancelled' | 'source-timeout'): void {
    const turn = this.coordinator.getTurn(turnId)
    if (!turn || before === turn.version) return
    const event: AssistantFactEvent = { type }
    this.onEvent?.(turn, event)
    for (const listener of this.listeners) listener(turn, event)
  }

  private publishTerminalResultProjection(turnId: string, before: number | undefined, result: ModelResult | void): void {
    if (!result || (result.outcome !== 'cancelled' && result.outcome !== 'timed-out')) return
    this.publishControlProjection(turnId, before, result.outcome === 'cancelled' ? 'source-cancelled' : 'source-timeout')
  }
  recover(): number { return this.coordinator.recover() }
  terminal(turnId: string): TurnTerminal | undefined { return this.coordinator.getTerminal(turnId) }
  listActive(sessionId?: string): ReturnType<TurnRuntime['coordinator']['listActive']> { return this.coordinator.listActive(sessionId) }
}
