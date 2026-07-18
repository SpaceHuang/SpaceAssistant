import { randomUUID } from 'node:crypto'

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

  createPending(input: Omit<PendingArtifactDecision, 'decisionId'>): PendingArtifactDecision {
    const key = `${input.requestId}\0${input.groupKey}`
    const existing = this.pendingByGroup.get(key)
    if (existing) return existing
    const decision = { ...input, decisionId: randomUUID() }
    this.pendingByGroup.set(key, decision)
    return decision
  }
}
