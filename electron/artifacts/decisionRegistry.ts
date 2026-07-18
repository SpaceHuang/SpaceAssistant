import { randomUUID } from 'node:crypto'
import type { ArtifactPathProvenance } from '../../src/shared/artifactTypes'
import { ErrorCodes } from '../../src/shared/errorCodes'

export interface PendingArtifactDecision {
  decisionId: string
  requestId: string
  sessionId: string
  toolUseId: string
  attempt: number
  groupKey: string
}

/** Keeps request-scoped artifact decisions deduplicated until they are resolved. */
export class ArtifactDecisionRegistry {
  private readonly pendingByGroup = new Map<string, PendingArtifactDecision>()
  private readonly pendingById = new Map<string, PendingArtifactDecision>()
  private readonly timeoutById = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly consumed = new Set<string>()

  constructor(private readonly options: { timeoutMs?: number } = {}) {}

  createPending(input: Omit<PendingArtifactDecision, 'decisionId'>): PendingArtifactDecision {
    const key = `${input.requestId}\0${input.groupKey}`
    const existing = this.pendingByGroup.get(key)
    if (existing) return existing
    const decision = { ...input, decisionId: randomUUID() }
    this.pendingByGroup.set(key, decision)
    this.pendingById.set(decision.decisionId, decision)
    this.timeoutById.set(decision.decisionId, setTimeout(() => this.remove(decision.decisionId), this.options.timeoutMs ?? 5 * 60 * 1000))
    return decision
  }

  get(decisionId: string): PendingArtifactDecision | undefined {
    return this.pendingById.get(decisionId)
  }

  cancelForRequest(requestId: string): void {
    this.removeWhere((decision) => decision.requestId === requestId)
  }

  clearForSession(sessionId: string): void {
    this.removeWhere((decision) => decision.sessionId === sessionId)
  }

  clearAll(): void {
    this.removeWhere(() => true)
  }

  consume(input: Pick<PendingArtifactDecision, 'decisionId' | 'requestId' | 'sessionId' | 'toolUseId' | 'attempt'>): PendingArtifactDecision {
    const decision = this.pendingById.get(input.decisionId)
    if (!decision) {
      const code = this.consumed.has(input.decisionId) ? ErrorCodes.ARTIFACT_DECISION_ALREADY_CONSUMED : ErrorCodes.ARTIFACT_DECISION_INVALID
      throw new Error(`${code}: unknown artifact decision`)
    }
    if (decision.requestId !== input.requestId || decision.sessionId !== input.sessionId || decision.toolUseId !== input.toolUseId || decision.attempt !== input.attempt) {
      throw new Error(`${ErrorCodes.ARTIFACT_DECISION_INVALID}: decision bindings do not match`)
    }
    this.consumed.add(decision.decisionId)
    this.remove(decision.decisionId)
    return decision
  }

  consumeAsUserDecision(input: Pick<PendingArtifactDecision, 'decisionId' | 'requestId' | 'sessionId' | 'toolUseId' | 'attempt'>): Extract<ArtifactPathProvenance, { pathSource: 'user-decision' }> {
    const decision = this.consume(input)
    return { pathSource: 'user-decision', pathDecisionId: decision.decisionId }
  }

  private removeWhere(predicate: (decision: PendingArtifactDecision) => boolean): void {
    for (const decision of this.pendingById.values()) if (predicate(decision)) this.remove(decision.decisionId)
  }

  private remove(decisionId: string): void {
    const decision = this.pendingById.get(decisionId)
    if (!decision) return
    this.pendingById.delete(decisionId)
    this.pendingByGroup.delete(`${decision.requestId}\0${decision.groupKey}`)
    const timeout = this.timeoutById.get(decisionId)
    if (timeout) clearTimeout(timeout)
    this.timeoutById.delete(decisionId)
  }
}
