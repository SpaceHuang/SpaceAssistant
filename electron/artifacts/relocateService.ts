import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { WorkDirProfile } from '../../src/shared/feishuTypes'
import type { AppDatabase } from '../database'
import { identitiesMatch, type FileIdentity } from '../safeAtomicWrite'
import { ArtifactRepository, type ArtifactRecord } from './artifactRepository'
import { resolveArtifactMutationWorkspace } from './artifactMutationGuard'
import { assertRelocateWorkspaceReady } from './relocateMutationGuard'
import { resolveArtifactSafeTarget } from './safeTarget'
import { artifactPathIdentity } from './pathIdentity'
import type { ArtifactPathLeaseRegistry } from './pathLeaseRegistry'
import {
  atomicReplaceWithTemp,
  buildControlledBackupPath,
  buildControlledTempPath,
  copySourceToTemp,
  createExclusiveBackup,
  deleteIfIdentityMatches,
  detectMoveMode,
  fileExists,
  readFileMetadata,
  restoreBackupToTarget,
  sameDeviceRename,
  verifyIdentity
} from './relocateFs'
import { RelocateOperationRepository } from './relocateOperationRepository'
import type { ArtifactOperationRecord, RelocateMoveMode, RelocateRequest, RelocateResult } from './relocateTypes'

export type RelocateServiceDeps = {
  db: AppDatabase
  profiles: WorkDirProfile[]
  registry: ArtifactPathLeaseRegistry
}

function targetNeedsOverwrite(input: {
  artifacts: ArtifactRecord[]
  artifactId: string
  targetIdentityKey: string
  targetExisted: boolean
}): boolean {
  if (input.targetExisted) return true
  return input.artifacts.some(
    (item) => item.status === 'active' && item.id !== input.artifactId && item.pathIdentityKey === input.targetIdentityKey
  )
}

async function prepareRelocateContext(
  deps: RelocateServiceDeps,
  request: RelocateRequest
): Promise<
  | { ok: false; error: string }
  | {
      ok: true
      workspace: { workDir: string }
      artifact: ArtifactRecord
      sourcePath: string
      targetPath: string
      sourceIdentityKey: string
      targetIdentityKey: string
      moveMode: RelocateMoveMode
      sourceMeta: Awaited<ReturnType<typeof readFileMetadata>>
      targetExisted: boolean
      targetOriginal?: Awaited<ReturnType<typeof readFileMetadata>>
    }
> {
  const repository = new ArtifactRepository(deps.db)
  const artifact = repository.find(request.artifactId)
  if (!artifact || artifact.status !== 'active' || artifact.sessionId !== request.sessionId) {
    return { ok: false, error: 'Artifact not found' }
  }
  const workspace = resolveArtifactMutationWorkspace({
    db: deps.db,
    sessionId: request.sessionId,
    profiles: deps.profiles,
    artifact
  })
  if (!workspace.ok) return { ok: false, error: workspace.errorCode }

  const targetSafe = await resolveArtifactSafeTarget(workspace.workDir, request.target, artifact.workspaceRootReal)
  const sourcePath = artifact.canonicalPath
  const targetPath = targetSafe.targetPath
  if (sourcePath === targetPath) return { ok: false, error: 'Relocate target matches source path' }

  const targetIdentityKey = artifactPathIdentity(targetPath)
  const needsOverwrite = targetNeedsOverwrite({
    artifacts: repository.listBySession(request.sessionId),
    artifactId: artifact.id,
    targetIdentityKey,
    targetExisted: targetSafe.existed
  })
  if (needsOverwrite && request.overwriteAuthorized !== true) {
    return { ok: false, error: 'ARTIFACT_RELOCATE_OVERWRITE_REQUIRED' }
  }

  try {
    await assertRelocateWorkspaceReady({ workDir: workspace.workDir, expectedWorkspaceRootReal: artifact.workspaceRootReal })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  const sourceMeta = await readFileMetadata(sourcePath)
  const targetOriginal = targetSafe.existed ? await readFileMetadata(targetPath) : undefined
  const moveMode = await detectMoveMode(sourcePath, targetPath, request.mode)

  return {
    ok: true,
    workspace: { workDir: workspace.workDir },
    artifact,
    sourcePath,
    targetPath,
    sourceIdentityKey: artifactPathIdentity(sourcePath),
    targetIdentityKey,
    moveMode,
    sourceMeta,
    targetExisted: targetSafe.existed,
    ...(targetOriginal ? { targetOriginal } : {})
  }
}

async function runBackupPhase(
  operations: RelocateOperationRepository,
  operation: ArtifactOperationRecord,
  backupPath: string,
  targetPath: string,
  targetOriginal: { digest: string }
): Promise<void> {
  const backupIdentity = await createExclusiveBackup(targetPath, backupPath)
  if (targetOriginal.digest !== operation.targetOriginalDigest) throw new Error('Target digest mismatch during backup')
  operations.updatePhase(operation.id, 'backup_committed', { targetBackupPath: backupPath, targetBackupIdentity: backupIdentity })
}

async function removeTargetIfBackedUp(targetPath: string, targetOriginalIdentity: FileIdentity, backupIdentity?: FileIdentity): Promise<void> {
  if (!backupIdentity) throw new Error('Missing backup identity')
  if (!(await verifyIdentity(targetPath, targetOriginalIdentity))) throw new Error('Target changed before replace')
  await deleteIfIdentityMatches(targetPath, targetOriginalIdentity)
}

async function runTargetCommitPhase(
  operations: RelocateOperationRepository,
  operation: ArtifactOperationRecord,
  input: {
    moveMode: RelocateMoveMode
    sourcePath: string
    targetPath: string
    tempPath?: string
    backupPath?: string
    targetOriginalIdentity?: FileIdentity
    sourceDigest: string
  }
): Promise<void> {
  if (input.moveMode === 'same-device-move') {
    if (input.targetOriginalIdentity && input.backupPath) {
      await removeTargetIfBackedUp(input.targetPath, input.targetOriginalIdentity, operation.targetBackupIdentity)
    }
    await sameDeviceRename(input.sourcePath, input.targetPath)
    const committed = await readFileMetadata(input.targetPath)
    if (committed.digest !== input.sourceDigest) throw new Error('Committed digest mismatch after same-device move')
    operations.updatePhase(operation.id, 'target_committed')
    return
  }

  const tempPath = input.tempPath!
  await fs.mkdir(path.dirname(tempPath), { recursive: true })
  await fs.mkdir(path.dirname(input.targetPath), { recursive: true })
  const copied = await copySourceToTemp(input.sourcePath, tempPath)
  if (copied.digest !== input.sourceDigest) throw new Error('Temp digest mismatch')
  operations.updatePhase(operation.id, operation.phase, { tempIdentity: copied.identity, tempPath })

  if (input.targetOriginalIdentity) {
    await removeTargetIfBackedUp(input.targetPath, input.targetOriginalIdentity, operation.targetBackupIdentity)
  }

  await atomicReplaceWithTemp(tempPath, input.targetPath, copied.identity)
  operations.updatePhase(operation.id, 'target_committed', { tempIdentity: copied.identity })
}

async function compensatePreCommitFailure(
  operation: ArtifactOperationRecord,
  input: {
    moveMode: RelocateMoveMode
    sourcePath: string
    targetPath: string
    backupPath?: string
    tempPath?: string
    sourceMeta: { identity: FileIdentity; digest: string }
    targetOriginal?: { identity: FileIdentity; digest: string }
  }
): Promise<'rolled_back' | 'recovery_required'> {
  try {
    const sourceExists = await fileExists(input.sourcePath)
    const targetExists = await fileExists(input.targetPath)

    if (input.moveMode === 'same-device-move' && targetExists && !sourceExists) {
      const targetMeta = await readFileMetadata(input.targetPath)
      if (targetMeta.digest !== input.sourceMeta.digest || !identitiesMatch(targetMeta.identity, input.sourceMeta.identity)) {
        return 'recovery_required'
      }
      await sameDeviceRename(input.targetPath, input.sourcePath)
    } else if (input.moveMode !== 'same-device-move' && targetExists) {
      const targetMeta = await readFileMetadata(input.targetPath)
      const matchesNewContent = targetMeta.digest === input.sourceMeta.digest
      const matchesOldContent = input.targetOriginal ? targetMeta.digest === input.targetOriginal.digest : false
      if (matchesNewContent && !matchesOldContent) {
        await fs.unlink(input.targetPath).catch(() => {})
      } else if (!matchesOldContent) {
        return 'recovery_required'
      }
    }

    if (input.tempPath) await fs.unlink(input.tempPath).catch(() => {})

    if (input.targetOriginal && input.backupPath && operation.targetBackupIdentity) {
      if (!(await verifyIdentity(input.backupPath, operation.targetBackupIdentity))) return 'recovery_required'
      if (input.targetOriginal.digest !== operation.targetOriginalDigest) return 'recovery_required'
      await restoreBackupToTarget(input.backupPath, input.targetPath, operation.targetBackupIdentity)
    }

    const sourceOk = await fileExists(input.sourcePath)
    const targetOk = input.targetOriginal
      ? (await fileExists(input.targetPath)) && (await readFileMetadata(input.targetPath)).digest === input.targetOriginal.digest
      : !(await fileExists(input.targetPath)) || (await readFileMetadata(input.targetPath)).digest === input.sourceMeta.digest
    return sourceOk && targetOk ? 'rolled_back' : 'recovery_required'
  } catch {
    return 'recovery_required'
  }
}

async function runCleanupPhase(
  operations: RelocateOperationRepository,
  operation: ArtifactOperationRecord,
  input: { backupPath?: string; tempPath?: string }
): Promise<void> {
  if (input.tempPath && operation.tempIdentity) {
    await deleteIfIdentityMatches(input.tempPath, operation.tempIdentity)
  }
  if (input.backupPath && operation.targetBackupIdentity) {
    await deleteIfIdentityMatches(input.backupPath, operation.targetBackupIdentity)
  }
  operations.updatePhase(operation.id, 'completed')
}

async function runSourceCleanup(
  operations: RelocateOperationRepository,
  operation: ArtifactOperationRecord,
  sourcePath: string,
  sourceIdentity: FileIdentity
): Promise<'cleanup_pending' | 'source_cleanup_pending'> {
  const deleted = await deleteIfIdentityMatches(sourcePath, sourceIdentity)
  operations.updatePhase(
    operation.id,
    deleted ? 'cleanup_pending' : 'source_cleanup_pending',
    deleted ? {} : { error: 'Source cleanup failed' }
  )
  return deleted ? 'cleanup_pending' : 'source_cleanup_pending'
}

function postCommitPhase(moveMode: RelocateMoveMode, mode: 'move' | 'copy'): 'cleanup_pending' | 'source_cleanup_pending' {
  if (mode === 'move' && moveMode === 'cross-device-move') return 'source_cleanup_pending'
  return 'cleanup_pending'
}

/** Executes a relocate request with operation journal phases and lease ordering. */
export async function relocateArtifact(deps: RelocateServiceDeps, request: RelocateRequest): Promise<RelocateResult> {
  const prepared = await prepareRelocateContext(deps, request)
  if (!prepared.ok) return prepared

  const operations = new RelocateOperationRepository(deps.db)
  const operationId = randomUUID()
  const {
    artifact,
    sourcePath,
    targetPath,
    sourceIdentityKey,
    targetIdentityKey,
    moveMode,
    sourceMeta,
    targetExisted,
    targetOriginal
  } = prepared
  const backupPath = targetExisted ? buildControlledBackupPath(targetPath, operationId) : undefined
  const tempPath = moveMode === 'same-device-move' ? undefined : buildControlledTempPath(targetPath, operationId)

  const operation = operations.createPrepared({
    id: operationId,
    artifactId: artifact.id,
    moveMode,
    sourcePath,
    targetPath,
    ...(tempPath ? { tempPath } : {}),
    targetExisted,
    ...(backupPath ? { targetBackupPath: backupPath } : {}),
    ...(targetOriginal
      ? { targetOriginalIdentity: targetOriginal.identity, targetOriginalSize: targetOriginal.size, targetOriginalDigest: targetOriginal.digest }
      : {}),
    expectedSize: sourceMeta.size,
    expectedDigest: sourceMeta.digest
  })

  const lease = deps.registry.acquireWrites([sourceIdentityKey, targetIdentityKey])
  try {
    await assertRelocateWorkspaceReady({ workDir: prepared.workspace.workDir, expectedWorkspaceRootReal: artifact.workspaceRootReal })

    let current = operations.find(operation.id)!
    if (current.targetExisted && current.targetBackupPath && targetOriginal && current.phase === 'prepared') {
      await runBackupPhase(operations, current, current.targetBackupPath, targetPath, targetOriginal)
      current = operations.find(operation.id)!
    }

    if (current.phase === 'prepared' || current.phase === 'backup_committed') {
      try {
        await runTargetCommitPhase(operations, current, {
          moveMode,
          sourcePath,
          targetPath,
          ...(tempPath ? { tempPath } : {}),
          ...(backupPath ? { backupPath } : {}),
          ...(targetOriginal ? { targetOriginalIdentity: targetOriginal.identity } : {}),
          sourceDigest: sourceMeta.digest
        })
      } catch (error) {
        current = operations.find(operation.id)!
        const outcome = await compensatePreCommitFailure(current, {
          moveMode,
          sourcePath,
          targetPath,
          ...(backupPath ? { backupPath } : {}),
          ...(tempPath ? { tempPath } : {}),
          sourceMeta,
          ...(targetOriginal ? { targetOriginal } : {})
        })
        operations.updatePhase(operation.id, outcome, { error: error instanceof Error ? error.message : String(error) })
        return { ok: false, error: outcome === 'recovery_required' ? 'ARTIFACT_RELOCATE_RECOVERY_REQUIRED' : 'ARTIFACT_RELOCATE_ROLLED_BACK' }
      }
    }

    current = operations.find(operation.id)!
    const newArtifactId = request.mode === 'copy' ? randomUUID() : artifact.id
    try {
      operations.commitArtifactAndPhase({
        operationId: operation.id,
        phase: postCommitPhase(moveMode, request.mode),
        artifactId: artifact.id,
        canonicalPath: targetPath,
        pathIdentityKey: targetIdentityKey,
        ...(request.mode === 'copy'
          ? {
              createCopy: {
                record: {
                  id: newArtifactId,
                  sessionId: artifact.sessionId,
                  workDirProfileId: artifact.workDirProfileId,
                  workspaceRootReal: artifact.workspaceRootReal,
                  ...(artifact.packageId ? { packageId: artifact.packageId } : {}),
                  container: artifact.container,
                  role: artifact.role,
                  title: artifact.title,
                  ...(artifact.stage ? { stage: artifact.stage } : {}),
                  canonicalPath: targetPath,
                  pathIdentityKey: targetIdentityKey,
                  requestedPath: request.target,
                  pathSource: artifact.pathSource,
                  ...(artifact.pathEvidenceId ? { pathEvidenceId: artifact.pathEvidenceId } : {}),
                  ...(artifact.pathDecisionId ? { pathDecisionId: artifact.pathDecisionId } : {})
                }
              }
            }
          : {})
      })
    } catch (error) {
      current = operations.find(operation.id)!
      const outcome = await compensatePreCommitFailure(current, {
        moveMode,
        sourcePath,
        targetPath,
        ...(backupPath ? { backupPath } : {}),
        ...(tempPath ? { tempPath } : {}),
        sourceMeta,
        ...(targetOriginal ? { targetOriginal } : {})
      })
      operations.updatePhase(operation.id, outcome, { error: error instanceof Error ? error.message : String(error) })
      return { ok: false, error: 'ARTIFACT_RELOCATE_DB_COMMIT_FAILED' }
    }

    current = operations.find(operation.id)!
    if (current.phase === 'source_cleanup_pending') {
      const phase = await runSourceCleanup(operations, current, sourcePath, sourceMeta.identity)
      current = operations.find(operation.id)!
      if (phase === 'source_cleanup_pending') {
        return { ok: true, artifactId: newArtifactId, activeArtifactId: request.mode === 'copy' && request.switchToCopy ? newArtifactId : artifact.id }
      }
    }

    if (current.phase === 'cleanup_pending') {
      try {
        await runCleanupPhase(operations, current, { ...(backupPath ? { backupPath } : {}), ...(tempPath ? { tempPath } : {}) })
      } catch (error) {
        operations.updatePhase(operation.id, 'cleanup_pending', { error: error instanceof Error ? error.message : String(error) })
      }
    }

    const activeArtifactId = request.mode === 'copy' && request.switchToCopy ? newArtifactId : artifact.id
    return { ok: true, artifactId: newArtifactId, activeArtifactId }
  } finally {
    lease.release()
  }
}

export function listPreparedOperations(db: AppDatabase): ArtifactOperationRecord[] {
  return new RelocateOperationRepository(db).listNonTerminal()
}
