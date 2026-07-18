import type { WorkDirProfile } from '../../src/shared/feishuTypes'
import type { AppDatabase } from '../database'
import { getSession } from '../database'
import { ArtifactRepository } from './artifactRepository'
import { resolveArtifactMutationWorkspace } from './artifactMutationGuard'
import { assertRelocateWorkspaceReady } from './relocateMutationGuard'
import { artifactPathIdentity } from './pathIdentity'
import type { ArtifactPathLeaseRegistry } from './pathLeaseRegistry'
import {
  atomicReplaceWithTemp,
  deleteIfIdentityMatches,
  fileExists,
  readFileMetadata,
  restoreBackupToTarget,
  sameDeviceRename,
  verifyIdentity
} from './relocateFs'
import { RelocateOperationRepository } from './relocateOperationRepository'
import type { ArtifactOperationRecord } from './relocateTypes'
import { relocateArtifact, type RelocateServiceDeps } from './relocateService'

export type RelocateRecoveryDeps = RelocateServiceDeps

async function recoverPreparedOrBackup(
  operations: RelocateOperationRepository,
  operation: ArtifactOperationRecord,
  input: { sourcePath: string; targetPath: string; backupPath?: string; tempPath?: string }
): Promise<void> {
  const targetCommitted =
    (await fileExists(input.targetPath)) &&
    operation.expectedDigest &&
    (await readFileMetadata(input.targetPath)).digest === operation.expectedDigest

  if (targetCommitted) {
    operations.updatePhase(operation.id, 'target_committed')
    return
  }

  if (operation.phase === 'backup_committed' && input.backupPath && operation.targetBackupIdentity) {
    if (await verifyIdentity(input.backupPath, operation.targetBackupIdentity)) {
      operations.updatePhase(operation.id, 'backup_committed')
      return
    }
  }

  if (input.tempPath) await deleteIfIdentityMatches(input.tempPath, operation.tempIdentity!).catch(() => {})
  if (input.backupPath && operation.targetBackupIdentity) {
    if (await verifyIdentity(input.backupPath, operation.targetBackupIdentity)) {
      if (operation.targetOriginalIdentity && (await fileExists(input.targetPath))) {
        await restoreBackupToTarget(input.backupPath, input.targetPath, operation.targetBackupIdentity)
      }
    }
  }
  if ((await fileExists(input.targetPath)) && !(await fileExists(input.sourcePath)) && operation.moveMode === 'same-device-move') {
    await sameDeviceRename(input.targetPath, input.sourcePath).catch(() => {})
  }
  operations.updatePhase(operation.id, 'rolled_back', { error: 'Recovered unfinished prepared operation' })
}

async function recoverTargetCommitted(
  operations: RelocateOperationRepository,
  operation: ArtifactOperationRecord,
  artifactRepo: ArtifactRepository
): Promise<void> {
  const artifact = artifactRepo.find(operation.artifactId)
  if (!artifact) {
    operations.updatePhase(operation.id, 'recovery_required', { error: 'Artifact missing during recovery' })
    return
  }
  const targetIdentity = artifactPathIdentity(operation.targetPath)
  if (artifact.canonicalPath === operation.targetPath || artifact.pathIdentityKey === targetIdentity) {
    operations.updatePhase(operation.id, operation.moveMode === 'cross-device-move' ? 'source_cleanup_pending' : 'cleanup_pending')
    return
  }
  try {
    operations.commitArtifactAndPhase({
      operationId: operation.id,
      phase: operation.moveMode === 'cross-device-move' ? 'source_cleanup_pending' : 'cleanup_pending',
      artifactId: operation.artifactId,
      canonicalPath: operation.targetPath,
      pathIdentityKey: targetIdentity
    })
  } catch {
    operations.updatePhase(operation.id, 'recovery_required', { error: 'Failed to replay DB commit' })
  }
}

async function recoverSourceCleanupPending(
  operations: RelocateOperationRepository,
  operation: ArtifactOperationRecord
): Promise<void> {
  if (!operation.expectedDigest) return
  const sourceExists = await fileExists(operation.sourcePath)
  if (!sourceExists) {
    operations.updatePhase(operation.id, 'cleanup_pending')
    return
  }
  const sourceMeta = await readFileMetadata(operation.sourcePath)
  if (sourceMeta.digest !== operation.expectedDigest) {
    operations.updatePhase(operation.id, 'recovery_required', { error: 'Source identity changed during cleanup recovery' })
    return
  }
  const deleted = await deleteIfIdentityMatches(operation.sourcePath, sourceMeta.identity)
  operations.updatePhase(operation.id, deleted ? 'cleanup_pending' : 'source_cleanup_pending', deleted ? {} : { error: 'Source cleanup retry failed' })
}

async function recoverCleanupPending(
  operations: RelocateOperationRepository,
  operation: ArtifactOperationRecord
): Promise<void> {
  if (operation.tempPath && operation.tempIdentity) {
    await deleteIfIdentityMatches(operation.tempPath, operation.tempIdentity)
  }
  if (operation.targetBackupPath && operation.targetBackupIdentity) {
    await deleteIfIdentityMatches(operation.targetBackupPath, operation.targetBackupIdentity)
  }
  operations.updatePhase(operation.id, 'completed')
}

/** Resumes a single non-terminal relocate operation idempotently. */
export async function recoverRelocateOperation(
  deps: RelocateRecoveryDeps,
  operationId: string
): Promise<{ ok: boolean; phase: string }> {
  const operations = new RelocateOperationRepository(deps.db)
  const operation = operations.find(operationId)
  if (!operation) return { ok: false, phase: 'missing' }
  if (operation.phase === 'completed' || operation.phase === 'rolled_back' || operation.phase === 'recovery_required') {
    return { ok: true, phase: operation.phase }
  }

  const artifactRepo = new ArtifactRepository(deps.db)
  const artifact = artifactRepo.find(operation.artifactId)
  if (!artifact) {
    operations.updatePhase(operation.id, 'recovery_required', { error: 'Artifact not found' })
    return { ok: false, phase: 'recovery_required' }
  }
  const session = getSession(deps.db, artifact.sessionId)
  if (!session) {
    operations.updatePhase(operation.id, 'recovery_required', { error: 'Session not found' })
    return { ok: false, phase: 'recovery_required' }
  }

  const workspace = resolveArtifactMutationWorkspace({
    db: deps.db,
    sessionId: artifact.sessionId,
    profiles: deps.profiles,
    artifact
  })
  if (!workspace.ok) {
    operations.updatePhase(operation.id, 'recovery_required', { error: workspace.errorCode })
    return { ok: false, phase: 'recovery_required' }
  }

  await assertRelocateWorkspaceReady({ workDir: workspace.workDir, expectedWorkspaceRootReal: artifact.workspaceRootReal })

  const lease = deps.registry.acquireWrites([artifact.pathIdentityKey, artifactPathIdentity(operation.targetPath)])
  try {
    let current = operations.find(operation.id)!
    if (current.phase === 'prepared' || current.phase === 'backup_committed') {
      await recoverPreparedOrBackup(operations, current, {
        sourcePath: current.sourcePath,
        targetPath: current.targetPath,
        ...(current.targetBackupPath ? { backupPath: current.targetBackupPath } : {}),
        ...(current.tempPath ? { tempPath: current.tempPath } : {})
      })
      current = operations.find(operation.id)!
    }

    if (current.phase === 'target_committed') {
      await recoverTargetCommitted(operations, current, artifactRepo)
      current = operations.find(operation.id)!
    }

    if (current.phase === 'source_cleanup_pending') {
      await recoverSourceCleanupPending(operations, current)
      current = operations.find(operation.id)!
    }

    if (current.phase === 'cleanup_pending') {
      await recoverCleanupPending(operations, current)
      current = operations.find(operation.id)!
    }

    if (current.phase === 'target_committed' && (await fileExists(current.targetPath))) {
      if (current.tempPath && current.tempIdentity && (await fileExists(current.tempPath))) {
        await atomicReplaceWithTemp(current.tempPath, current.targetPath, current.tempIdentity).catch(() => {})
      }
    }

    return { ok: true, phase: operations.find(operation.id)!.phase }
  } finally {
    lease.release()
  }
}

/** Scans and resumes all non-terminal relocate operations at startup. */
export async function recoverPendingRelocateOperations(deps: RelocateRecoveryDeps): Promise<number> {
  const operations = new RelocateOperationRepository(deps.db).listNonTerminal()
  let recovered = 0
  for (const operation of operations) {
    const result = await recoverRelocateOperation(deps, operation.id)
    if (result.ok) recovered += 1
  }
  return recovered
}

export { relocateArtifact }
