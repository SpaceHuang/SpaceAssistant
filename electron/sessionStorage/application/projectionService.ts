import { MAX_INLINE_PROJECTION_PAYLOAD_BYTES, type ProjectionStateCommand, type ProjectionStateRecord } from '../domain/projectionState'
import { parseProjectionBuildCheckpoint } from '../domain/projectionBuild'
import type { ProjectionCacheBlobReference, ProjectionCacheCandidate, ProjectionStateStore } from './ports'

export type ProjectionRebuildLease = Readonly<{
  sessionId: string
  scopeKey: string
  sessionGeneration: string
  connectionEpoch: number
  processGeneration: number
  rebuildToken: string
  sourceIdentityJson: string
}>

type ProjectionBuildOutputBase = Readonly<{
  sourceIdentityJson: string
  payloadGeneration: string
  payloadDigest: string
  validatedRangeJson: string
}>
type ProjectionBuildOutput = ProjectionBuildOutputBase &
  (Readonly<{ inlinePayload: string; blobLocator?: never; blobByteLength?: never }> |
   Readonly<{ inlinePayload?: never; blobLocator: string; blobByteLength: number }>) &
  Readonly<{ blobReferences?: readonly ProjectionCacheBlobReference[] }>

export interface SessionProjectionService {
  get(sessionId: string, scopeKey: string): ProjectionStateRecord | null
  readCheckpoint(sessionId: string, scopeKey: string): string | null
  saveCheckpoint(lease: ProjectionRebuildLease, checkpointJson: string): boolean
  invalidateLease(lease: ProjectionRebuildLease): boolean
  releaseLease(lease: ProjectionRebuildLease): boolean
  ensureInvalid(input: Readonly<{ sessionId: string; scopeKey: string; sessionGeneration: string }>): ProjectionStateRecord | null
  beginRebuild(input: Readonly<{ sessionId: string; scopeKey: string; sessionGeneration: string }>): ProjectionRebuildLease | null
  publish(lease: ProjectionRebuildLease, output: ProjectionBuildOutput): ProjectionStateRecord | null
  reject(lease: ProjectionRebuildLease, input: Readonly<{ failureCaseJson: string; attempts: number; retryAfter: number }>): ProjectionStateRecord | null
  scheduleRejectedRetry(input: Readonly<{ sessionId: string; scopeKey: string; sessionGeneration: string; failureCaseJson: string; retryAfter: number }>): ProjectionStateRecord | null
  invalidateInTransaction(input: Readonly<{ sessionId: string; scopeKey: string; sessionGeneration: string }>): ProjectionStateRecord | null
}

export function createProjectionService(store: ProjectionStateStore, options: Readonly<{
  processGeneration: () => number
  connectionEpoch: () => number
  createToken: () => string
  now: () => number
}>): SessionProjectionService {
  const issuedLeases = new WeakSet<object>()

  const get = (sessionId: string, scopeKey: string) => store.get(sessionId, scopeKey)

  const readCheckpoint: SessionProjectionService['readCheckpoint'] = (sessionId, scopeKey) => {
    const state = store.get(sessionId, scopeKey)
    if (state?.status !== 'rebuilding' || !state.sourceIdentityJson || state.processGeneration === null || !state.rebuildToken) return null
    const checkpointJson = store.readCheckpoint(sessionId, scopeKey)
    if (!checkpointJson) return null
    const checkpoint = parseProjectionBuildCheckpoint(checkpointJson)
    return checkpoint && checkpoint.sessionId === sessionId && checkpoint.sessionGeneration === state.sessionGeneration &&
        checkpoint.scopeKey === scopeKey && checkpoint.sourceIdentityJson === state.sourceIdentityJson
        ? checkpointJson : null
  }

  const saveCheckpoint: SessionProjectionService['saveCheckpoint'] = (lease, checkpointJson) => {
    if (!ownsLease(lease) || !checkpointJson.trim()) return false
    const checkpoint = parseProjectionBuildCheckpoint(checkpointJson)
    if (!checkpoint || checkpoint.sessionId !== lease.sessionId || checkpoint.sessionGeneration !== lease.sessionGeneration ||
      checkpoint.scopeKey !== lease.scopeKey || checkpoint.sourceIdentityJson !== lease.sourceIdentityJson ||
      checkpoint.processGeneration !== lease.processGeneration || checkpoint.rebuildToken !== lease.rebuildToken) return false
    return store.saveCheckpoint({ sessionId: lease.sessionId, scopeKey: lease.scopeKey, sessionGeneration: lease.sessionGeneration,
      sourceIdentityJson: lease.sourceIdentityJson, processGeneration: lease.processGeneration, rebuildToken: lease.rebuildToken,
      checkpointJson, now: options.now() })
  }

  const ensureInvalid: SessionProjectionService['ensureInvalid'] = (input) =>
    store.ensureInvalid({ ...input, now: options.now() })

  const beginRebuild: SessionProjectionService['beginRebuild'] = (input) => {
    const current = store.ensureInvalid({ ...input, now: options.now() })
    if (!current) return null
    const processGeneration = options.processGeneration()
    const connectionEpoch = options.connectionEpoch()
    const rebuildToken = options.createToken()
    if (!Number.isSafeInteger(processGeneration) || processGeneration < 0 || !Number.isSafeInteger(connectionEpoch) ||
      connectionEpoch < 0 || !rebuildToken.trim()) return null
    const command: ProjectionStateCommand = { type: 'claim', processGeneration, rebuildToken, now: options.now() }
    const claimed = store.transition({ ...input, command })
    if (!claimed || claimed.status !== 'rebuilding' || claimed.sourceIdentityJson === null) return null
    const lease: ProjectionRebuildLease = Object.freeze({
      sessionId: claimed.sessionId, scopeKey: claimed.scopeKey, sessionGeneration: claimed.sessionGeneration,
      connectionEpoch, processGeneration, rebuildToken, sourceIdentityJson: claimed.sourceIdentityJson,
    })
    issuedLeases.add(lease)
    return lease
  }

  const ownsLease = (lease: ProjectionRebuildLease): boolean =>
    typeof lease === 'object' && lease !== null && issuedLeases.has(lease) && options.connectionEpoch() === lease.connectionEpoch

  const publish: SessionProjectionService['publish'] = (lease, output) => {
    if (!ownsLease(lease) || output.sourceIdentityJson !== lease.sourceIdentityJson || !output.payloadGeneration.trim() || !output.payloadDigest.trim()) return null
    if (typeof output.inlinePayload === 'string' && Buffer.byteLength(output.inlinePayload, 'utf8') > MAX_INLINE_PROJECTION_PAYLOAD_BYTES) return null
    if (output.blobReferences !== undefined && (!Array.isArray(output.blobReferences) || output.blobReferences.length < 1 ||
      output.blobReferences.length > 100_000 || output.blobReferences.some((reference) => !reference ||
        !/^projection-[0-9a-f-]{36}\.blob$/.test(reference.locator) || !Number.isSafeInteger(reference.byteLength) || reference.byteLength < 1 ||
        !/^[a-f0-9]{64}$/.test(reference.payloadDigest) || !['body-block','sequence-directory','id-directory','body-manifest'].includes(reference.kind)) ||
      new Set(output.blobReferences.map(({ locator }) => locator)).size !== output.blobReferences.length)) return null
    let source: { formatVersion?: unknown; sessionGeneration?: unknown; messageRevision?: unknown; historyWatermark?: unknown }
    try { source = JSON.parse(lease.sourceIdentityJson) as typeof source } catch { return null }
    if ((source.formatVersion !== 1 && source.formatVersion !== 2) || source.sessionGeneration !== lease.sessionGeneration ||
      !Number.isSafeInteger(source.messageRevision)) return null
    const command: ProjectionStateCommand = {
      type: 'publish', processGeneration: lease.processGeneration, rebuildToken: lease.rebuildToken,
      expectedSourceIdentityJson: lease.sourceIdentityJson, historyWatermarkJson: JSON.stringify(source.historyWatermark ?? null),
      messageRevision: source.messageRevision as number, payloadGeneration: output.payloadGeneration,
      payloadDigest: output.payloadDigest, validatedRangeJson: output.validatedRangeJson, now: options.now(),
    }
    const cache: ProjectionCacheCandidate = {
      sourceIdentityJson: lease.sourceIdentityJson, payloadGeneration: output.payloadGeneration,
      payloadDigest: output.payloadDigest, validatedRangeJson: output.validatedRangeJson,
      ...(output.inlinePayload === undefined
        ? { blobLocator: output.blobLocator, blobByteLength: output.blobByteLength }
        : { inlinePayload: output.inlinePayload }),
      ...(output.blobReferences ? { blobReferences: output.blobReferences } : {}),
    }
    return store.transition({ sessionId: lease.sessionId, scopeKey: lease.scopeKey, sessionGeneration: lease.sessionGeneration, command, cache })
  }

  const reject: SessionProjectionService['reject'] = (lease, input) => {
    if (!ownsLease(lease)) return null
    const command: ProjectionStateCommand = {
      type: 'reject', processGeneration: lease.processGeneration, rebuildToken: lease.rebuildToken,
      failureCaseJson: input.failureCaseJson, attempts: input.attempts, retryAfter: input.retryAfter, now: options.now(),
    }
    return store.transition({ sessionId: lease.sessionId, scopeKey: lease.scopeKey, sessionGeneration: lease.sessionGeneration, command })
  }

  const scheduleRejectedRetry: SessionProjectionService['scheduleRejectedRetry'] = (input) => {
    const current = store.get(input.sessionId, input.scopeKey)
    if (!current || current.status !== 'rejected' || !current.failureCaseJson) return null
    const now = options.now()
    return store.transition({ sessionId: input.sessionId, scopeKey: input.scopeKey, sessionGeneration: input.sessionGeneration,
      command: { type: 'scheduleRetry', expectedFailureCaseJson: current.failureCaseJson,
        failureCaseJson: input.failureCaseJson, retryAfter: Math.max(input.retryAfter, now), now } })
  }

  const invalidateLease: SessionProjectionService['invalidateLease'] = (lease) => {
    if (!ownsLease(lease)) return false
    const current = store.get(lease.sessionId, lease.scopeKey)
    if (!current || current.status !== 'rebuilding' || current.sessionGeneration !== lease.sessionGeneration ||
      current.processGeneration !== lease.processGeneration || current.rebuildToken !== lease.rebuildToken) return false
    return store.transition({ sessionId: lease.sessionId, scopeKey: lease.scopeKey, sessionGeneration: lease.sessionGeneration,
      command: { type: 'invalidate', sessionGeneration: lease.sessionGeneration, now: options.now() } })?.status === 'invalid'
  }

  const releaseLease: SessionProjectionService['releaseLease'] = (lease) => {
    if (!ownsLease(lease) || lease.processGeneration < 1) return false
    const current = store.get(lease.sessionId, lease.scopeKey)
    if (!current || current.status !== 'rebuilding' || current.sessionGeneration !== lease.sessionGeneration ||
      current.processGeneration !== lease.processGeneration || current.rebuildToken !== lease.rebuildToken) return false
    return store.releaseLease({ sessionId: lease.sessionId, scopeKey: lease.scopeKey, sessionGeneration: lease.sessionGeneration,
      processGeneration: lease.processGeneration, rebuildToken: lease.rebuildToken, now: options.now() })
  }

  const invalidateInTransaction: SessionProjectionService['invalidateInTransaction'] = (input) =>
    store.invalidateInTransaction({ ...input, now: options.now() })

  return Object.freeze({ get, readCheckpoint, saveCheckpoint, invalidateLease, releaseLease, ensureInvalid, beginRebuild, publish, reject,
    scheduleRejectedRetry, invalidateInTransaction })
}
