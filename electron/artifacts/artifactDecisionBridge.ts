import type { ArtifactDecisionResponsePayload } from '../../src/shared/api'
import type {
  ArtifactDecisionRequest,
  ArtifactDecisionSubmitResult,
  RemoteArtifactDecisionOwner
} from '../../src/shared/artifactDecisionTypes'
import type { ArtifactPathProvenance } from '../../src/shared/artifactTypes'
import { ArtifactDecisionRegistry } from './decisionRegistry'

const CONFIRM_MS = 5 * 60 * 1000
const TOMBSTONE_TTL_MS = 10 * 60 * 1000
const TOMBSTONE_LIMIT_PER_OWNER = 100

export type ArtifactDecisionWaitResult = {
  choice: string
  provenance: Extract<ArtifactPathProvenance, { pathSource: 'user-decision' }>
}

export type ArtifactDecisionCandidate = {
  owner: RemoteArtifactDecisionOwner
  request: ArtifactDecisionRequest
}

export type RemoteArtifactDecisionOwnerInput = Omit<RemoteArtifactDecisionOwner, 'decisionId'>

export type { ArtifactDecisionSubmitResult }

export type ArtifactDecisionEndReason =
  | 'resolved'
  | 'timeout'
  | 'abort'
  | 'cancelled'
  | 'outbound_failed'
  | 'replaced'

export type ArtifactDecisionTombstone = {
  decisionId: string
  ownerKey: string
  endedAt: number
}

type Waiter = {
  resolve: (result: ArtifactDecisionWaitResult | null) => void
  timeoutId: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  onAbort?: () => void
}

type ActiveArtifactDecision = {
  request: ArtifactDecisionRequest
  owner?: RemoteArtifactDecisionOwner
  waiter?: Waiter
  registeredAt: number
}

type ArtifactDecisionSettledEvent = {
  decisionId: string
  reason: ArtifactDecisionEndReason | 'resolved'
}

let settledNotify: ((event: ArtifactDecisionSettledEvent) => void) | undefined

export function setArtifactDecisionSettledNotify(
  notify: ((event: ArtifactDecisionSettledEvent) => void) | undefined
): void {
  settledNotify = notify
}

function emitSettled(decisionId: string, reason: ArtifactDecisionEndReason | 'resolved'): void {
  try {
    settledNotify?.({ decisionId, reason })
  } catch {
    // Renderer notify must not break settle/submit.
  }
}

/** Bridge owns TTL via waiters; registry auto-timeout is disabled (timeoutMs: 0). */
const registry = new ArtifactDecisionRegistry({ timeoutMs: 0 })
const activeByDecisionId = new Map<string, ActiveArtifactDecision>()
const decisionIdByWaiterKey = new Map<string, string>()
const decisionIdsByInboundOwner = new Map<string, Set<string>>()
const tombstonesByOwnerKey = new Map<string, ArtifactDecisionTombstone[]>()
let registrationSeq = 0

function waiterKey(requestId: string, toolUseId: string): string {
  return `${requestId}\0${toolUseId}`
}

function inboundOwnerKey(
  owner: Pick<RemoteArtifactDecisionOwner, 'source' | 'authOwner' | 'privateChatTarget'>
): string {
  return JSON.stringify([owner.source, owner.authOwner, owner.privateChatTarget])
}

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.length === 0
}

function assertRemoteOwnerInput(owner: RemoteArtifactDecisionOwnerInput): void {
  if (owner.source !== 'feishu' && owner.source !== 'wechat') {
    throw new Error('invalid remote artifact decision owner source')
  }
  if (
    isBlank(owner.authOwner) ||
    isBlank(owner.privateChatTarget) ||
    isBlank(owner.originSessionId) ||
    isBlank(owner.requestId)
  ) {
    throw new Error(
      'remote artifact decision owner requires authOwner, privateChatTarget, originSessionId, and requestId'
    )
  }
}

function indexOwner(owner: RemoteArtifactDecisionOwner): void {
  const key = inboundOwnerKey(owner)
  let set = decisionIdsByInboundOwner.get(key)
  if (!set) {
    set = new Set()
    decisionIdsByInboundOwner.set(key, set)
  }
  set.add(owner.decisionId)
}

function unindexOwner(owner: RemoteArtifactDecisionOwner | undefined): void {
  if (!owner) return
  const key = inboundOwnerKey(owner)
  const set = decisionIdsByInboundOwner.get(key)
  if (!set) return
  set.delete(owner.decisionId)
  if (set.size === 0) decisionIdsByInboundOwner.delete(key)
}

function detachWaiterListener(waiter: Waiter | undefined): void {
  if (!waiter?.signal || !waiter.onAbort) return
  waiter.signal.removeEventListener('abort', waiter.onAbort)
  waiter.onAbort = undefined
  waiter.signal = undefined
}

function pruneTombstones(ownerKey: string, now = Date.now()): ArtifactDecisionTombstone[] {
  const existing = tombstonesByOwnerKey.get(ownerKey) ?? []
  const fresh = existing.filter((entry) => now - entry.endedAt <= TOMBSTONE_TTL_MS)
  if (fresh.length === 0) {
    tombstonesByOwnerKey.delete(ownerKey)
    return []
  }
  tombstonesByOwnerKey.set(ownerKey, fresh)
  return fresh
}

function writeTombstone(owner: RemoteArtifactDecisionOwner | undefined, decisionId: string): void {
  if (!owner) return
  const ownerKey = inboundOwnerKey(owner)
  const now = Date.now()
  const next = pruneTombstones(ownerKey, now)
  next.push({ decisionId, ownerKey, endedAt: now })
  while (next.length > TOMBSTONE_LIMIT_PER_OWNER) next.shift()
  tombstonesByOwnerKey.set(ownerKey, next)
}

function clearActiveIndexes(active: ActiveArtifactDecision): void {
  const key = waiterKey(active.request.requestId, active.request.toolUseId)
  activeByDecisionId.delete(active.request.decisionId)
  unindexOwner(active.owner)
  if (decisionIdByWaiterKey.get(key) === active.request.decisionId) {
    decisionIdByWaiterKey.delete(key)
  }
  if (active.waiter) {
    clearTimeout(active.waiter.timeoutId)
    detachWaiterListener(active.waiter)
  }
}

/**
 * Unified settlement: drop registry/active/waiter/owner indexes, optionally write tombstone,
 * then asynchronously resume the waiter.
 */
export function settleArtifactDecision(
  decisionId: string,
  result: ArtifactDecisionWaitResult | null,
  _reason: ArtifactDecisionEndReason
): boolean {
  const active = activeByDecisionId.get(decisionId)
  if (!active) return false
  const waiter = active.waiter
  registry.tryConsumeAsUserDecision({
    decisionId: active.request.decisionId,
    requestId: active.request.requestId,
    sessionId: active.request.sessionId,
    toolUseId: active.request.toolUseId,
    attempt: active.request.attempt
  })
  writeTombstone(active.owner, decisionId)
  clearActiveIndexes(active)
  emitSettled(decisionId, _reason)
  if (waiter) {
    setImmediate(() => waiter.resolve(result))
  }
  return true
}

export function getSharedArtifactDecisionRegistry(): ArtifactDecisionRegistry {
  return registry
}

export function listArtifactDecisionCandidates(
  identity: Pick<RemoteArtifactDecisionOwner, 'source' | 'authOwner' | 'privateChatTarget'>
): ArtifactDecisionCandidate[] {
  const ids = decisionIdsByInboundOwner.get(inboundOwnerKey(identity))
  if (!ids || ids.size === 0) return []
  const candidates: ArtifactDecisionCandidate[] = []
  for (const decisionId of ids) {
    const active = activeByDecisionId.get(decisionId)
    if (!active?.owner) continue
    candidates.push({
      owner: { ...active.owner },
      request: {
        ...active.request,
        options: active.request.options.map((option) => ({ ...option }))
      }
    })
  }
  candidates.sort(
    (left, right) =>
      (activeByDecisionId.get(left.request.decisionId)?.registeredAt ?? 0) -
      (activeByDecisionId.get(right.request.decisionId)?.registeredAt ?? 0)
  )
  return candidates
}

export function findArtifactDecisionTombstone(
  identity: Pick<RemoteArtifactDecisionOwner, 'source' | 'authOwner' | 'privateChatTarget'>,
  decisionId: string
): ArtifactDecisionTombstone | undefined {
  const ownerKey = inboundOwnerKey(identity)
  const entries = pruneTombstones(ownerKey)
  return entries.find((entry) => entry.decisionId === decisionId)
}

export function registerArtifactDecisionRequest(
  request: Omit<ArtifactDecisionRequest, 'decisionId'>,
  ownerInput?: RemoteArtifactDecisionOwnerInput
): ArtifactDecisionRequest {
  if (ownerInput) {
    assertRemoteOwnerInput(ownerInput)
  }
  const pending = registry.createPending({
    requestId: request.requestId,
    sessionId: request.sessionId,
    toolUseId: request.toolUseId,
    attempt: request.attempt,
    groupKey: request.groupKey ?? request.kind
  })
  const stored = { ...request, decisionId: pending.decisionId }
  const owner = ownerInput ? { ...ownerInput, decisionId: stored.decisionId } : undefined
  try {
    activeByDecisionId.set(stored.decisionId, {
      request: stored,
      owner,
      registeredAt: registrationSeq++
    })
    if (owner) indexOwner(owner)
    return stored
  } catch (error) {
    activeByDecisionId.delete(stored.decisionId)
    unindexOwner(owner)
    registry.tryConsumeAsUserDecision({
      decisionId: stored.decisionId,
      requestId: stored.requestId,
      sessionId: stored.sessionId,
      toolUseId: stored.toolUseId,
      attempt: stored.attempt
    })
    throw error
  }
}

export function getArtifactDecisionRequest(decisionId: string): ArtifactDecisionRequest | undefined {
  return activeByDecisionId.get(decisionId)?.request
}

export function waitForArtifactDecisionResponse(
  requestId: string,
  toolUseId: string,
  signal?: AbortSignal
): Promise<ArtifactDecisionWaitResult | null> {
  const key = waiterKey(requestId, toolUseId)
  return new Promise((resolve) => {
    if (signal?.aborted) {
      const activeAborted = [...activeByDecisionId.values()].find(
        (active) => active.request.requestId === requestId && active.request.toolUseId === toolUseId
      )
      if (activeAborted) {
        settleArtifactDecision(activeAborted.request.decisionId, null, 'abort')
      }
      resolve(null)
      return
    }
    const previousDecisionId = decisionIdByWaiterKey.get(key)
    if (previousDecisionId) {
      settleArtifactDecision(previousDecisionId, null, 'replaced')
    }
    const activeForKey = [...activeByDecisionId.values()].find(
      (active) => active.request.requestId === requestId && active.request.toolUseId === toolUseId
    )
    if (!activeForKey) {
      resolve(null)
      return
    }
    decisionIdByWaiterKey.set(key, activeForKey.request.decisionId)
    const timeoutId = setTimeout(() => {
      settleArtifactDecision(activeForKey.request.decisionId, null, 'timeout')
    }, CONFIRM_MS)
    const onAbort = () => {
      settleArtifactDecision(activeForKey.request.decisionId, null, 'abort')
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    const waiter: Waiter = { resolve, timeoutId, signal, onAbort: signal ? onAbort : undefined }
    activeForKey.waiter = waiter
  })
}

function isInvalidSubmitPayload(payload: ArtifactDecisionResponsePayload): boolean {
  if (
    typeof payload.decisionId !== 'string' ||
    payload.decisionId.length === 0 ||
    typeof payload.requestId !== 'string' ||
    payload.requestId.length === 0 ||
    typeof payload.sessionId !== 'string' ||
    payload.sessionId.length === 0 ||
    typeof payload.toolUseId !== 'string' ||
    payload.toolUseId.length === 0 ||
    typeof payload.choice !== 'string' ||
    payload.choice.length === 0
  ) {
    return true
  }
  if (typeof payload.attempt !== 'number' || !Number.isInteger(payload.attempt) || payload.attempt < 0) {
    return true
  }
  return false
}

export function submitArtifactDecisionResponse(
  payload: ArtifactDecisionResponsePayload
): ArtifactDecisionSubmitResult {
  if (isInvalidSubmitPayload(payload)) {
    return 'invalid'
  }
  const active = activeByDecisionId.get(payload.decisionId)
  if (!active?.waiter) {
    return 'stale'
  }
  if (
    active.request.requestId !== payload.requestId ||
    active.request.sessionId !== payload.sessionId ||
    active.request.toolUseId !== payload.toolUseId ||
    active.request.attempt !== payload.attempt
  ) {
    return 'binding_mismatch'
  }
  const consumed = registry.tryConsumeAsUserDecision({
    decisionId: payload.decisionId,
    requestId: payload.requestId,
    sessionId: payload.sessionId,
    toolUseId: payload.toolUseId,
    attempt: payload.attempt
  })
  if (!consumed.ok) {
    if (consumed.reason === 'stale') {
      // Registry lost the pending while bridge still held active — settle to clear indexes.
      settleArtifactDecision(payload.decisionId, null, 'cancelled')
      return 'stale'
    }
    return consumed.reason
  }
  const waiter = active.waiter
  writeTombstone(active.owner, payload.decisionId)
  clearActiveIndexes(active)
  emitSettled(payload.decisionId, 'resolved')
  setImmediate(() => waiter.resolve({ choice: payload.choice, provenance: consumed.provenance }))
  return 'resolved'
}

export function cancelArtifactDecision(
  decisionId: string,
  reason: ArtifactDecisionEndReason = 'cancelled'
): boolean {
  return settleArtifactDecision(decisionId, null, reason)
}

export function cancelArtifactDecisionsForRequest(requestId: string): number {
  let count = 0
  for (const active of [...activeByDecisionId.values()]) {
    if (active.request.requestId !== requestId) continue
    if (settleArtifactDecision(active.request.decisionId, null, 'cancelled')) count += 1
  }
  return count
}

export function clearArtifactDecisionsForSession(sessionId: string): number {
  let count = 0
  for (const active of [...activeByDecisionId.values()]) {
    if (active.request.sessionId !== sessionId) continue
    if (settleArtifactDecision(active.request.decisionId, null, 'cancelled')) count += 1
  }
  return count
}

export function resetArtifactDecisionBridgeForTests(): void {
  for (const active of [...activeByDecisionId.values()]) {
    settleArtifactDecision(active.request.decisionId, null, 'cancelled')
  }
  registry.clearAll()
  activeByDecisionId.clear()
  decisionIdByWaiterKey.clear()
  decisionIdsByInboundOwner.clear()
  tombstonesByOwnerKey.clear()
  registrationSeq = 0
}
