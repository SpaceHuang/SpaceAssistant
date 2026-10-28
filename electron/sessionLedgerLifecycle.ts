import type { DatabaseSync } from 'node:sqlite'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { SessionEventInput } from './sessionEvents'
import {
  advanceSessionLedgerOwnerReconciliation,
  beginSessionLedgerBootstrap,
  beginSessionLedgerCheck,
  beginSessionLedgerTargetCheck,
  completeSessionLedgerBootstrap,
  completeSessionLedgerCheck,
  completeSessionLedgerTargetCheck,
  decideSessionLedgerGate,
  ensureLegacyLedgerReadiness,
  invalidateSessionLedgerProof,
  markMissingLegacyLedgerBlocked,
  markSessionLedgerBlocked,
  readUsableSessionLedgerAdmission,
  readSessionLedgerReadiness,
  recoverInterruptedSessionLedgerCheck,
  reopenBlockedSessionLedger,
  refreshSessionLedgerReadyProof,
  type SessionLedgerReadyProof,
  type SessionLedgerReadiness
} from './sessionLedgerReadiness'
import { drainCanonicalLedgerProjectionOutbox, type CanonicalLedgerProjectionTarget } from './sessionLedgerOutbox'
import type { SessionLedgerLocationInput } from './sessionLedgerIdentity'
import { withSessionEventWriterDrain } from './sessionEvents'
import { withSessionLedgerProcessLock } from './sessionLedgerProcessLock'

type LockEntry = { tail: Promise<void>; users: number }

const locationLocks = new Map<string, LockEntry>()
const heldLocationLocks = new AsyncLocalStorage<ReadonlySet<string>>()

export function isSessionLedgerLifecycleLockHeld(locationKey: string): boolean {
  return Boolean(heldLocationLocks.getStore()?.has(locationKey))
}

/** Runs background recovery without inheriting a caller's per-location lock context. */
export function runOutsideSessionLedgerLifecycleLock<T>(operation: () => T): T {
  return heldLocationLocks.exit(operation)
}

/** Serializes readiness transitions and JSONL projection writes for one stable ledger location. */
export async function withSessionLedgerLifecycleLock<T>(locationKey: string, operation: () => Promise<T>): Promise<T> {
  if (!locationKey) throw new Error('SESSION_LEDGER_LOCATION_KEY_REQUIRED')
  if (heldLocationLocks.getStore()?.has(locationKey)) return operation()
  const entry = locationLocks.get(locationKey) ?? { tail: Promise.resolve(), users: 0 }
  entry.users += 1
  locationLocks.set(locationKey, entry)
  let release!: () => void
  const turn = new Promise<void>((resolve) => { release = resolve })
  const previous = entry.tail
  entry.tail = previous.then(() => turn, () => turn)
  await previous
  try {
    const held = new Set(heldLocationLocks.getStore() ?? [])
    held.add(locationKey)
    return await heldLocationLocks.run(held, () => /^[a-f0-9]{64}$/.test(locationKey)
      ? withSessionLedgerProcessLock(locationKey, operation)
      : operation())
  } finally {
    release()
    entry.users -= 1
    if (entry.users === 0 && locationLocks.get(locationKey) === entry) locationLocks.delete(locationKey)
  }
}

export function withSessionLedgerLifecycleLocks<T>(locationKeys: readonly string[], operation: () => Promise<T>): Promise<T> {
  const unique = [...new Set(locationKeys)].sort()
  const acquire = (index: number): Promise<T> => index === unique.length
    ? operation()
    : withSessionLedgerLifecycleLock(unique[index]!, () => acquire(index + 1))
  return acquire(0)
}

export type SessionLedgerLifecycleDependencies = {
  fileExists(location: SessionLedgerLocationInput): Promise<boolean>
  readProof(location: SessionLedgerLocationInput): Promise<SessionLedgerReadyProof | undefined>
  verifyPhysicalContinuity?(location: SessionLedgerLocationInput, readiness: SessionLedgerReadiness): Promise<boolean>
  migrateLegacyReadyProof?(location: SessionLedgerLocationInput, readiness: SessionLedgerReadiness): Promise<SessionLedgerReadyProof | undefined>
  bootstrap(location: SessionLedgerLocationInput, bootstrapId: string): Promise<SessionLedgerReadyProof>
  baseline(location: SessionLedgerLocationInput): Promise<SessionLedgerReadyProof>
  /** Recreates a wholly missing legacy ledger from canonical history, never a damaged existing file. */
  rebuildMissingLegacyLedger?(location: SessionLedgerLocationInput): Promise<SessionLedgerReadyProof>
  /** Preserves the mismatched artifact, then rebuilds from canonical history. */
  rebuildPhysicalMismatch?(location: SessionLedgerLocationInput): Promise<SessionLedgerReadyProof>
  /** Preserves a degraded legacy ledger and records its quarantine before any later canonical rebuild. */
  quarantineDegradedLedger?(location: SessionLedgerLocationInput): Promise<void>
  applyTarget(location: SessionLedgerLocationInput, target: CanonicalLedgerProjectionTarget & { targetId: string }): Promise<{
    eventIds: readonly string[]; events: readonly SessionEventInput[]
  }>
  reconcilePreviousOwner?(location: SessionLedgerLocationInput, previousGeneration: number, processGeneration: number): Promise<void>
}

export type SessionLedgerLifecycleResult =
  | { status: 'ready'; readiness: SessionLedgerReadiness }
  | { status: 'blocked'; readiness: SessionLedgerReadiness }

export type SessionLedgerLifecycleTrace = {
  operation: 'proof-reused' | 'bootstrap' | 'baseline' | 'target'
  status: 'ready' | 'blocked'
  baselineScanCount: number
  projectedCount: number
  durationMs: number
  failureClass: string | null
}

function proofsEqual(readiness: SessionLedgerReadiness, proof: SessionLedgerReadyProof): boolean {
  return readiness.canonicalWatermark === proof.canonicalWatermark && readiness.ledgerGeneration === proof.ledgerGeneration &&
    readiness.proofFileIdentity === proof.fileIdentity && readiness.proofFileBytes === proof.fileBytes &&
    readiness.proofTailFrame === proof.tailFrame && readiness.proofIndexSeq === proof.indexSeq &&
    readiness.proofIndexEventCount === proof.indexEventCount && readiness.proofIndexBytes === proof.indexBytes &&
    readiness.proofIndexLastAt === proof.indexLastAt
}

/** Canonical watermarks may advance before projection; the physical proof must not. */
function physicalProofMatches(readiness: SessionLedgerReadiness, proof: SessionLedgerReadyProof): boolean {
  if (readiness.ledgerGeneration !== proof.ledgerGeneration || !readiness.proofFileIdentity) return false
  // Non-production dependencies have no byte-prefix verifier, so retain the
  // conservative metadata check used by their lifecycle unit tests.
  const oldInode = readiness.proofFileIdentity.split(':').slice(0, 2).join(':')
  const newInode = proof.fileIdentity.split(':').slice(0, 2).join(':')
  return oldInode === newInode && proof.fileBytes >= (readiness.proofFileBytes ?? 0) &&
    proof.indexSeq >= (readiness.proofIndexSeq ?? 0) &&
    proof.indexEventCount >= (readiness.proofIndexEventCount ?? 0) &&
    proof.indexBytes >= (readiness.proofIndexBytes ?? 0)
}

function physicalMetadataMatches(readiness: SessionLedgerReadiness, proof: SessionLedgerReadyProof): boolean {
  const oldInode = readiness.proofFileIdentity?.split(':').slice(0, 2).join(':')
  const newInode = proof.fileIdentity.split(':').slice(0, 2).join(':')
  return readiness.ledgerGeneration === proof.ledgerGeneration && Boolean(oldInode) && oldInode === newInode &&
    proof.fileBytes >= (readiness.proofFileBytes ?? 0) && proof.indexSeq >= (readiness.proofIndexSeq ?? 0) &&
    proof.indexEventCount >= (readiness.proofIndexEventCount ?? 0) && proof.indexBytes >= (readiness.proofIndexBytes ?? 0)
}

function hasCredentialedBootstrap(readiness: SessionLedgerReadiness): boolean {
  return readiness.origin === 'new_location' && Boolean(readiness.bootstrapId) &&
    (readiness.state === 'uninitialized' || readiness.state === 'initializing')
}

/** Ensures only the requested session ledger. Canonical chat history remains outside this gate. */
export async function ensureSessionLedgerReady(input: {
  conn: DatabaseSync
  location: SessionLedgerLocationInput
  sessionGeneration: string
  processGeneration: number
  retryBlocked?: boolean
  dependencies: SessionLedgerLifecycleDependencies
  onTrace?: (trace: SessionLedgerLifecycleTrace) => void
  now?: () => number
}): Promise<SessionLedgerLifecycleResult> {
  const readiness = ensureLegacyLedgerReadiness(input.conn, input.location, input.sessionGeneration, input.now?.())
  const startedAt = Date.now()
  let operation: SessionLedgerLifecycleTrace['operation'] = 'proof-reused'
  let baselineScanCount = 0
  let projectedCount = 0
  const runLifecycle = () => withSessionLedgerLifecycleLock(readiness.ledgerLocationKey, async (): Promise<SessionLedgerLifecycleResult> => {
    const now = input.now ?? Date.now
    let current = readSessionLedgerReadiness(input.conn, readiness.ledgerLocationKey)!
    const resumeCredentialedBootstrap = hasCredentialedBootstrap(current)
    if (resumeCredentialedBootstrap && current.ownerReconciledProcessGeneration < input.processGeneration) {
      advanceSessionLedgerOwnerReconciliation(input.conn, current.ledgerLocationKey, input.processGeneration, now())
      current = readSessionLedgerReadiness(input.conn, current.ledgerLocationKey)!
    }
    const canRebuildMissingLegacyLedger = input.retryBlocked && current.origin === 'legacy' &&
      current.state === 'blocked' && current.failureClass === 'ledger_missing' && Boolean(input.dependencies.rebuildMissingLegacyLedger)
    if (!resumeCredentialedBootstrap && current.ownerReconciledProcessGeneration < input.processGeneration) {
      if (!canRebuildMissingLegacyLedger && input.dependencies.reconcilePreviousOwner && (current.ownerReconciledProcessGeneration > 0 || current.origin === 'legacy')) {
        try {
          await input.dependencies.reconcilePreviousOwner(input.location, current.ownerReconciledProcessGeneration, input.processGeneration)
        } catch (error) {
          if (error instanceof Error && error.message === 'SESSION_LEDGER_BASELINE_FILE_MISSING') {
            markMissingLegacyLedgerBlocked(input.conn, current.ledgerLocationKey, now())
          } else {
            markSessionLedgerBlocked(input.conn, current.ledgerLocationKey, 'baseline', 'owner_reconciliation_failed', now())
          }
          current = readSessionLedgerReadiness(input.conn, current.ledgerLocationKey)!
          return { status: 'blocked', readiness: current }
        }
      }
      advanceSessionLedgerOwnerReconciliation(input.conn, current.ledgerLocationKey, input.processGeneration, now())
      current = readSessionLedgerReadiness(input.conn, readiness.ledgerLocationKey)!
    }

    const rebuildPhysicallyMismatchedLedger = async (): Promise<SessionLedgerReadiness> => {
      if (!input.dependencies.rebuildPhysicalMismatch) return current
      reopenBlockedSessionLedger(input.conn, current.ledgerLocationKey, now())
      current = readSessionLedgerReadiness(input.conn, current.ledgerLocationKey)!
      const initialToken = beginSessionLedgerCheck(input.conn, current.ledgerLocationKey, now())
      if (!initialToken) return readSessionLedgerReadiness(input.conn, current.ledgerLocationKey)!
      try {
        const rebuiltProof = await input.dependencies.rebuildPhysicalMismatch(input.location)
        const afterRebuild = readSessionLedgerReadiness(input.conn, current.ledgerLocationKey)!
        const currentToken = afterRebuild.state === 'unknown'
          ? beginSessionLedgerCheck(input.conn, current.ledgerLocationKey, now())
          : afterRebuild.state === 'checking' ? afterRebuild.checkToken : null
        if (currentToken && !completeSessionLedgerCheck(input.conn, current.ledgerLocationKey, currentToken, rebuiltProof, now())) {
          markSessionLedgerBlocked(input.conn, current.ledgerLocationKey, 'baseline', 'physical_mismatch_rebuild_failed', now())
        }
      } catch {
        markSessionLedgerBlocked(input.conn, current.ledgerLocationKey, 'baseline', 'physical_mismatch_rebuild_failed', now())
      }
      return readSessionLedgerReadiness(input.conn, current.ledgerLocationKey)!
    }

    if (current.state === 'blocked') {
      // A physical mismatch invalidates the old completeness claim. Retrying the
      // incremental path could otherwise mint a new proof over the shortened file.
      if (!input.retryBlocked) return { status: 'blocked', readiness: current }
      if (current.failureClass === 'physical_proof_mismatch') {
        if (!input.dependencies.rebuildPhysicalMismatch) return { status: 'blocked', readiness: current }
        operation = 'baseline'
        current = await rebuildPhysicallyMismatchedLedger()
        if (current.state === 'blocked') return { status: 'blocked', readiness: current }
      }
      reopenBlockedSessionLedger(input.conn, current.ledgerLocationKey, now())
      current = readSessionLedgerReadiness(input.conn, current.ledgerLocationKey)!
    }
    if (current.state === 'checking') {
      recoverInterruptedSessionLedgerCheck(input.conn, current.ledgerLocationKey, now())
      current = readSessionLedgerReadiness(input.conn, current.ledgerLocationKey)!
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const decision = decideSessionLedgerGate(current)
      if (decision.kind === 'allow-ready') {
        if (input.dependencies.verifyPhysicalContinuity &&
          (!current.proofTailFrame || !current.proofTailFrame.startsWith('full:'))) {
          const migratedProof = await (input.dependencies.migrateLegacyReadyProof?.(input.location, current) ?? Promise.resolve(undefined))
            .catch(() => undefined)
          if (!migratedProof || !refreshSessionLedgerReadyProof(input.conn, current.ledgerLocationKey, migratedProof, now())) {
            markSessionLedgerBlocked(input.conn, current.ledgerLocationKey, 'baseline', 'physical_proof_mismatch', now())
            return { status: 'blocked', readiness: readSessionLedgerReadiness(input.conn, current.ledgerLocationKey)! }
          }
          current = readSessionLedgerReadiness(input.conn, current.ledgerLocationKey)!
          return { status: 'ready', readiness: current }
        }
        let observed: SessionLedgerReadyProof | undefined
        let proofReadError: unknown
        try { observed = await input.dependencies.readProof(input.location) }
        catch (error) { proofReadError = error }
        if (observed && proofsEqual(current, observed)) return { status: 'ready', readiness: current }
        const physicalContinuity = input.dependencies.verifyPhysicalContinuity
          ? await input.dependencies.verifyPhysicalContinuity(input.location, current).catch(() => false)
          : observed ? physicalProofMatches(current, observed) : false
        const fileStillExists = !observed && proofReadError
          ? await input.dependencies.fileExists(input.location).catch(() => false)
          : Boolean(observed)
        const failedIndexProof = proofReadError instanceof Error && proofReadError.message === 'SESSION_LEDGER_INDEX_PROOF_INVALID'
        if ((!observed && failedIndexProof && fileStillExists && !physicalContinuity) || (observed && !physicalContinuity)) {
          markSessionLedgerBlocked(input.conn, current.ledgerLocationKey, 'baseline', 'physical_proof_mismatch', now())
          current = readSessionLedgerReadiness(input.conn, current.ledgerLocationKey)!
          if (input.retryBlocked && input.dependencies.rebuildPhysicalMismatch) {
            operation = 'baseline'
            current = await rebuildPhysicallyMismatchedLedger()
            if (current.state === 'blocked') return { status: 'blocked', readiness: current }
            if (current.state === 'ready') return { status: 'ready', readiness: current }
          } else {
            return { status: 'blocked', readiness: current }
          }
          continue
        }
        invalidateSessionLedgerProof(input.conn, current.ledgerLocationKey, now())
        current = readSessionLedgerReadiness(input.conn, current.ledgerLocationKey)!
        continue
      }
      if (decision.kind === 'retry-blocked') {
        if (input.retryBlocked && current.failureClass === 'physical_proof_mismatch' && input.dependencies.rebuildPhysicalMismatch) {
          operation = 'baseline'
          current = await rebuildPhysicallyMismatchedLedger()
          if (current.state === 'blocked') return { status: 'blocked', readiness: current }
          continue
        }
        return { status: 'blocked', readiness: current }
      }
      if (decision.kind === 'bootstrap' || decision.kind === 'resume-bootstrap') {
        operation = 'bootstrap'
        if (!beginSessionLedgerBootstrap(input.conn, current.ledgerLocationKey, decision.bootstrapId, now()) && current.state === 'uninitialized') {
          return { status: 'blocked', readiness: current }
        }
        try {
          const proof = await input.dependencies.bootstrap(input.location, decision.bootstrapId)
          completeSessionLedgerBootstrap(input.conn, current.ledgerLocationKey, decision.bootstrapId, proof, now())
        } catch {
          markSessionLedgerBlocked(input.conn, current.ledgerLocationKey, 'baseline', 'bootstrap_failed', now())
        }
      } else if (decision.kind === 'check-baseline' || decision.kind === 'recover-check') {
        operation = 'baseline'
        baselineScanCount += 1
        const ledgerExists = await input.dependencies.fileExists(input.location)
        if (current.origin === 'legacy' && !ledgerExists && !input.dependencies.rebuildMissingLegacyLedger) {
          markMissingLegacyLedgerBlocked(input.conn, current.ledgerLocationKey, now())
          current = readSessionLedgerReadiness(input.conn, current.ledgerLocationKey)!
          return { status: 'blocked', readiness: current }
        }
        const token = beginSessionLedgerCheck(input.conn, current.ledgerLocationKey, now())
        if (!token) return { status: 'blocked', readiness: readSessionLedgerReadiness(input.conn, current.ledgerLocationKey)! }
        try {
          const proof = current.origin === 'legacy' && !ledgerExists
            ? await input.dependencies.rebuildMissingLegacyLedger!(input.location)
            : await input.dependencies.baseline(input.location)
          const afterBaseline = readSessionLedgerReadiness(input.conn, current.ledgerLocationKey)!
          const currentToken = afterBaseline.state === 'unknown'
            ? beginSessionLedgerCheck(input.conn, current.ledgerLocationKey, now())
            : afterBaseline.state === 'checking' ? afterBaseline.checkToken : null
          if (currentToken) completeSessionLedgerCheck(input.conn, current.ledgerLocationKey, currentToken, proof, now())
        } catch (error) {
          let failureClass = 'baseline_failed'
          if ((error as { code?: string })?.code === 'SESSION_LEDGER_BASELINE_DEGRADED' && input.dependencies.quarantineDegradedLedger) {
            try {
              await input.dependencies.quarantineDegradedLedger(input.location)
              failureClass = 'ledger_degraded_quarantined'
            } catch {
              failureClass = 'ledger_quarantine_failed'
            }
          }
          markSessionLedgerBlocked(input.conn, current.ledgerLocationKey, 'baseline', failureClass, now())
        }
      } else if (decision.kind === 'check-target') {
        operation = 'target'
        const existingProof = await input.dependencies.readProof(input.location).catch(() => undefined)
        const continuous = existingProof && (input.dependencies.verifyPhysicalContinuity
          ? await input.dependencies.verifyPhysicalContinuity(input.location, current).catch(() => false)
          : physicalProofMatches(current, existingProof))
        const metadataMatches = existingProof && (input.dependencies.verifyPhysicalContinuity
          ? physicalMetadataMatches(current, existingProof)
          : physicalProofMatches(current, existingProof))
        if (!existingProof || !continuous || !metadataMatches) {
          markSessionLedgerBlocked(input.conn, current.ledgerLocationKey, 'baseline', 'physical_proof_mismatch', now())
          current = readSessionLedgerReadiness(input.conn, current.ledgerLocationKey)!
          return { status: 'blocked', readiness: current }
        }
        const token = beginSessionLedgerTargetCheck(input.conn, current.ledgerLocationKey, now())
        if (!token) return { status: 'blocked', readiness: readSessionLedgerReadiness(input.conn, current.ledgerLocationKey)! }
        const drained = await drainCanonicalLedgerProjectionOutbox(input.conn, current.ledgerLocationKey,
          (target) => input.dependencies.applyTarget(input.location, target), now())
        projectedCount += drained.projected
        if (drained.failedTargetId) {
          markSessionLedgerBlocked(input.conn, current.ledgerLocationKey, 'target', 'projection_failed', now())
        } else {
          const proof = await input.dependencies.readProof(input.location).catch(() => undefined)
          if (!proof || !completeSessionLedgerTargetCheck(input.conn, current.ledgerLocationKey, token, proof, now())) {
            markSessionLedgerBlocked(input.conn, current.ledgerLocationKey, 'target', 'target_proof_failed', now())
          }
        }
      }
      current = readSessionLedgerReadiness(input.conn, current.ledgerLocationKey)!
      if (current.state === 'blocked') return { status: 'blocked', readiness: current }
    }
    const latest = readSessionLedgerReadiness(input.conn, readiness.ledgerLocationKey)!
    if (latest.state !== 'blocked') markSessionLedgerBlocked(input.conn, latest.ledgerLocationKey,
      latest.canonicalWatermark ? 'target' : 'baseline', 'state_transition_exhausted', now())
    return { status: 'blocked', readiness: readSessionLedgerReadiness(input.conn, latest.ledgerLocationKey)! }
  })
  const initial = readSessionLedgerReadiness(input.conn, readiness.ledgerLocationKey)!
  // Read-only consumers (currently compaction-marker hydration during a session switch) fall back
  // to canonical History when the ledger is blocked. They must not wait for an active writer just
  // to refresh a verdict that they are explicitly forbidden to retry.
  const canReuseBlockedVerdictWithoutWriterDrain = input.retryBlocked === false &&
    initial.state === 'blocked' && !hasCredentialedBootstrap(initial)
  const result = canReuseBlockedVerdictWithoutWriterDrain
    ? { status: 'blocked' as const, readiness: initial }
    : hasCredentialedBootstrap(initial)
    ? await runLifecycle()
    : await withSessionEventWriterDrain(input.location.workDir, input.location.sessionId, runLifecycle)
  try {
    input.onTrace?.({ operation, status: result.status, baselineScanCount, projectedCount,
      durationMs: Math.max(0, Date.now() - startedAt), failureClass: result.readiness.failureClass })
  } catch { /* Diagnostics must never affect the readiness decision. */ }
  return result
}

/** Fast admission check for already usable ledgers; stale/absent ledgers use the full repair lifecycle. */
export async function ensureSessionLedgerAdmission(input: Parameters<typeof ensureSessionLedgerReady>[0]): Promise<SessionLedgerLifecycleResult> {
  const admission = readUsableSessionLedgerAdmission(input.conn, input.location, input.sessionGeneration, input.processGeneration)
  return admission ? { status: 'ready', readiness: admission } : ensureSessionLedgerReady(input)
}
