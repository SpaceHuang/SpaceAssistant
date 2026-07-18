import type { Database } from 'better-sqlite3'
import { getDbConnection, type AppDatabase } from '../database'
import type { ArtifactOperationRecord, RelocateMoveMode, RelocatePhase } from './relocateTypes'
import type { FileIdentity } from '../safeAtomicWrite'
import { ArtifactRepository, type CreateArtifactInput } from './artifactRepository'

type OperationRow = {
  id: string
  artifact_id: string
  operation: string
  move_mode: RelocateMoveMode
  source_path: string
  target_path: string
  temp_path: string | null
  target_existed: number
  target_backup_path: string | null
  target_backup_identity: string | null
  target_original_identity: string | null
  target_original_size: number | null
  target_original_digest: string | null
  expected_size: number | null
  expected_digest: string | null
  temp_identity: string | null
  phase: RelocatePhase
  error: string | null
  created_at: number
  updated_at: number
}

function parseIdentity(raw: string | null): FileIdentity | undefined {
  if (!raw) return undefined
  return JSON.parse(raw) as FileIdentity
}

function serializeIdentity(identity: FileIdentity | undefined): string | null {
  return identity ? JSON.stringify(identity) : null
}

function fromRow(row: OperationRow): ArtifactOperationRecord {
  return {
    id: row.id,
    artifactId: row.artifact_id,
    operation: 'relocate',
    moveMode: row.move_mode,
    sourcePath: row.source_path,
    targetPath: row.target_path,
    ...(row.temp_path ? { tempPath: row.temp_path } : {}),
    targetExisted: row.target_existed === 1,
    ...(row.target_backup_path ? { targetBackupPath: row.target_backup_path } : {}),
    ...(parseIdentity(row.target_backup_identity) ? { targetBackupIdentity: parseIdentity(row.target_backup_identity) } : {}),
    ...(parseIdentity(row.target_original_identity) ? { targetOriginalIdentity: parseIdentity(row.target_original_identity) } : {}),
    ...(row.target_original_size != null ? { targetOriginalSize: row.target_original_size } : {}),
    ...(row.target_original_digest ? { targetOriginalDigest: row.target_original_digest } : {}),
    ...(row.expected_size != null ? { expectedSize: row.expected_size } : {}),
    ...(row.expected_digest ? { expectedDigest: row.expected_digest } : {}),
    ...(parseIdentity(row.temp_identity) ? { tempIdentity: parseIdentity(row.temp_identity) } : {}),
    phase: row.phase,
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export class RelocateOperationRepository {
  constructor(private readonly db: AppDatabase) {}

  private conn(): Database {
    return getDbConnection(this.db)
  }

  find(id: string): ArtifactOperationRecord | undefined {
    const row = this.conn().prepare('SELECT * FROM artifact_operations WHERE id = ?').get(id) as OperationRow | undefined
    return row ? fromRow(row) : undefined
  }

  listNonTerminal(): ArtifactOperationRecord[] {
    const rows = this.conn()
      .prepare(`SELECT * FROM artifact_operations
        WHERE phase NOT IN ('completed', 'rolled_back', 'recovery_required')
        ORDER BY created_at ASC`)
      .all() as OperationRow[]
    return rows.map(fromRow)
  }

  countNonTerminalForArtifact(artifactId: string): number {
    const row = this.conn()
      .prepare(`SELECT COUNT(*) AS count FROM artifact_operations
        WHERE artifact_id = ? AND phase NOT IN ('completed', 'rolled_back', 'recovery_required')`)
      .get(artifactId) as { count: number }
    return row.count
  }

  createPrepared(input: {
    id: string
    artifactId: string
    moveMode: RelocateMoveMode
    sourcePath: string
    targetPath: string
    tempPath?: string
    targetExisted: boolean
    targetBackupPath?: string
    targetOriginalIdentity?: FileIdentity
    targetOriginalSize?: number
    targetOriginalDigest?: string
    expectedSize: number
    expectedDigest: string
  }): ArtifactOperationRecord {
    const now = Date.now()
    this.conn()
      .prepare(`INSERT INTO artifact_operations (
        id, artifact_id, operation, move_mode, source_path, target_path, temp_path,
        target_existed, target_backup_path, target_original_identity, target_original_size,
        target_original_digest, expected_size, expected_digest, phase, created_at, updated_at
      ) VALUES (
        @id, @artifactId, 'relocate', @moveMode, @sourcePath, @targetPath, @tempPath,
        @targetExisted, @targetBackupPath, @targetOriginalIdentity, @targetOriginalSize,
        @targetOriginalDigest, @expectedSize, @expectedDigest, 'prepared', @now, @now
      )`)
      .run({
        id: input.id,
        artifactId: input.artifactId,
        moveMode: input.moveMode,
        sourcePath: input.sourcePath,
        targetPath: input.targetPath,
        tempPath: input.tempPath ?? null,
        targetExisted: input.targetExisted ? 1 : 0,
        targetBackupPath: input.targetBackupPath ?? null,
        targetOriginalIdentity: serializeIdentity(input.targetOriginalIdentity),
        targetOriginalSize: input.targetOriginalSize ?? null,
        targetOriginalDigest: input.targetOriginalDigest ?? null,
        expectedSize: input.expectedSize,
        expectedDigest: input.expectedDigest,
        now
      })
    return this.find(input.id)!
  }

  updatePhase(
    id: string,
    phase: RelocatePhase,
    patch: Partial<{
      tempPath: string
      targetBackupPath: string
      targetBackupIdentity: FileIdentity
      tempIdentity: FileIdentity
      error: string
    }> = {}
  ): void {
    const sets = ['phase = @phase', 'updated_at = @now']
    const params: Record<string, unknown> = { id, phase, now: Date.now() }
    if (patch.tempPath !== undefined) {
      sets.push('temp_path = @tempPath')
      params.tempPath = patch.tempPath
    }
    if (patch.targetBackupPath !== undefined) {
      sets.push('target_backup_path = @targetBackupPath')
      params.targetBackupPath = patch.targetBackupPath
    }
    if (patch.targetBackupIdentity !== undefined) {
      sets.push('target_backup_identity = @targetBackupIdentity')
      params.targetBackupIdentity = serializeIdentity(patch.targetBackupIdentity)
    }
    if (patch.tempIdentity !== undefined) {
      sets.push('temp_identity = @tempIdentity')
      params.tempIdentity = serializeIdentity(patch.tempIdentity)
    }
    if (patch.error !== undefined) {
      sets.push('error = @error')
      params.error = patch.error
    }
    this.conn().prepare(`UPDATE artifact_operations SET ${sets.join(', ')} WHERE id = @id`).run(params)
  }

  commitArtifactAndPhase(input: {
    operationId: string
    phase: RelocatePhase
    artifactId: string
    canonicalPath: string
    pathIdentityKey: string
    createCopy?: {
      record: CreateArtifactInput
    }
  }): void {
    this.conn().transaction(() => {
      if (input.createCopy) {
        new ArtifactRepository(this.db).create(input.createCopy.record)
      } else {
        this.conn()
          .prepare('UPDATE session_artifacts SET canonical_path = ?, path_identity_key = ?, updated_at = ? WHERE id = ? AND status = ?')
          .run(input.canonicalPath, input.pathIdentityKey, Date.now(), input.artifactId, 'active')
      }
      this.updatePhase(input.operationId, input.phase)
    })()
  }
}
