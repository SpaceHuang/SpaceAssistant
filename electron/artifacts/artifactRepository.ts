import type { ArtifactContainer, ArtifactPathProvenance, ArtifactRole, PrimaryStage } from '../../src/shared/artifactTypes'
import { getDbConnection, type AppDatabase } from '../database'

type ArtifactRow = {
  id: string
  session_id: string
  work_dir_profile_id: string
  workspace_root_real: string
  package_id: string | null
  container: ArtifactContainer
  role: ArtifactRole
  title: string
  stage: PrimaryStage | null
  canonical_path: string
  path_identity_key: string
  requested_path: string | null
  path_source: ArtifactPathProvenance['pathSource']
  path_evidence_id: string | null
  path_decision_id: string | null
  status: 'active' | 'deleted'
  created_at: number
  updated_at: number
}

export type ArtifactRecord = {
  id: string
  sessionId: string
  workDirProfileId: string
  workspaceRootReal: string
  packageId?: string
  container: ArtifactContainer
  role: ArtifactRole
  title: string
  stage?: PrimaryStage
  canonicalPath: string
  pathIdentityKey: string
  requestedPath?: string
  pathSource: ArtifactPathProvenance['pathSource']
  pathEvidenceId?: string
  pathDecisionId?: string
  status: 'active' | 'deleted'
  createdAt: number
  updatedAt: number
}

export type CreateArtifactInput = Omit<ArtifactRecord, 'status' | 'createdAt' | 'updatedAt'>

function fromRow(row: ArtifactRow): ArtifactRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    workDirProfileId: row.work_dir_profile_id,
    workspaceRootReal: row.workspace_root_real,
    ...(row.package_id ? { packageId: row.package_id } : {}),
    container: row.container,
    role: row.role,
    title: row.title,
    ...(row.stage ? { stage: row.stage } : {}),
    canonicalPath: row.canonical_path,
    pathIdentityKey: row.path_identity_key,
    ...(row.requested_path ? { requestedPath: row.requested_path } : {}),
    pathSource: row.path_source,
    ...(row.path_evidence_id ? { pathEvidenceId: row.path_evidence_id } : {}),
    ...(row.path_decision_id ? { pathDecisionId: row.path_decision_id } : {}),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export class ArtifactRepository {
  constructor(private readonly db: AppDatabase) {}

  create(input: CreateArtifactInput): ArtifactRecord {
    const now = Date.now()
    const record: ArtifactRecord = { ...input, title: input.title ?? '', status: 'active', createdAt: now, updatedAt: now }
    getDbConnection(this.db)
      .prepare(`INSERT INTO session_artifacts (
        id, session_id, work_dir_profile_id, workspace_root_real, package_id, container, role, title, stage,
        canonical_path, path_identity_key, requested_path, path_source, path_evidence_id, path_decision_id,
        status, created_at, updated_at
      ) VALUES (
        @id, @sessionId, @workDirProfileId, @workspaceRootReal, @packageId, @container, @role, @title, @stage,
        @canonicalPath, @pathIdentityKey, @requestedPath, @pathSource, @pathEvidenceId, @pathDecisionId,
        @status, @createdAt, @updatedAt
      )`)
      .run({
        ...record,
        packageId: record.packageId ?? null,
        stage: record.stage ?? null,
        requestedPath: record.requestedPath ?? null,
        pathEvidenceId: record.pathEvidenceId ?? null,
        pathDecisionId: record.pathDecisionId ?? null
      })
    return record
  }

  find(id: string): ArtifactRecord | undefined {
    const row = getDbConnection(this.db).prepare('SELECT * FROM session_artifacts WHERE id = ?').get(id) as ArtifactRow | undefined
    return row ? fromRow(row) : undefined
  }

  markDeleted(id: string): void {
    getDbConnection(this.db)
      .prepare("UPDATE session_artifacts SET status = 'deleted', updated_at = ? WHERE id = ? AND status = 'active'")
      .run(Date.now(), id)
  }
}
