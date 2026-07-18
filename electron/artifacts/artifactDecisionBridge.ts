import type { ArtifactDecisionResponsePayload } from '../../src/shared/api'
import type { ArtifactDecisionRequest } from '../../src/shared/artifactDecisionTypes'
import { ArtifactDecisionRegistry } from './decisionRegistry'

const CONFIRM_MS = 5 * 60 * 1000

type Waiter = {
  resolve: (choice: string | null) => void
  timeoutId: ReturnType<typeof setTimeout>
}

const registry = new ArtifactDecisionRegistry({ timeoutMs: CONFIRM_MS })
const requestsById = new Map<string, ArtifactDecisionRequest>()
const waiters = new Map<string, Waiter>()

function waiterKey(requestId: string, toolUseId: string): string {
  return `${requestId}\0${toolUseId}`
}

export function getSharedArtifactDecisionRegistry(): ArtifactDecisionRegistry {
  return registry
}

export function registerArtifactDecisionRequest(
  request: Omit<ArtifactDecisionRequest, 'decisionId'>
): ArtifactDecisionRequest {
  const pending = registry.createPending({
    requestId: request.requestId,
    sessionId: request.sessionId,
    toolUseId: request.toolUseId,
    attempt: request.attempt,
    groupKey: request.groupKey ?? request.kind
  })
  const stored = { ...request, decisionId: pending.decisionId }
  requestsById.set(stored.decisionId, stored)
  return stored
}

export function getArtifactDecisionRequest(decisionId: string): ArtifactDecisionRequest | undefined {
  return requestsById.get(decisionId)
}

export function waitForArtifactDecisionResponse(requestId: string, toolUseId: string): Promise<string | null> {
  const key = waiterKey(requestId, toolUseId)
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      waiters.delete(key)
      resolve(null)
    }, CONFIRM_MS)
    waiters.set(key, { resolve, timeoutId })
  })
}

export function submitArtifactDecisionResponse(payload: ArtifactDecisionResponsePayload): void {
  registry.consume({
    decisionId: payload.decisionId,
    requestId: payload.requestId,
    sessionId: payload.sessionId,
    toolUseId: payload.toolUseId,
    attempt: payload.attempt
  })
  requestsById.delete(payload.decisionId)
  const key = waiterKey(payload.requestId, payload.toolUseId)
  const waiter = waiters.get(key)
  if (!waiter) return
  clearTimeout(waiter.timeoutId)
  waiters.delete(key)
  setImmediate(() => waiter.resolve(payload.choice))
}

export function cancelArtifactDecisionsForRequest(requestId: string): void {
  registry.cancelForRequest(requestId)
  for (const [id, request] of requestsById) {
    if (request.requestId === requestId) requestsById.delete(id)
  }
  const prefix = `${requestId}\0`
  for (const [key, waiter] of waiters) {
    if (!key.startsWith(prefix)) continue
    clearTimeout(waiter.timeoutId)
    waiters.delete(key)
    setImmediate(() => waiter.resolve(null))
  }
}

export function clearArtifactDecisionsForSession(sessionId: string): void {
  registry.clearForSession(sessionId)
  for (const [id, request] of requestsById) {
    if (request.sessionId === sessionId) requestsById.delete(id)
  }
}

export function resetArtifactDecisionBridgeForTests(): void {
  registry.clearAll()
  requestsById.clear()
  for (const [, waiter] of waiters) {
    clearTimeout(waiter.timeoutId)
    setImmediate(() => waiter.resolve(null))
  }
  waiters.clear()
}
