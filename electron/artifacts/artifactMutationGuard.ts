import type { WorkDirProfile } from '../../src/shared/feishuTypes'
import { ErrorCodes } from '../../src/shared/errorCodes'
import type { AppDatabase } from '../database'
import { getSession } from '../database'
import type { ArtifactRecord } from './artifactRepository'
import { resolveArtifactWorkspaceStrict, type StrictWorkspaceResult } from './workspaceResolver'

export type ArtifactMutationWorkspace =
  | (Extract<StrictWorkspaceResult, { ok: true }> & { artifact?: ArtifactRecord })
  | StrictWorkspaceResult

/** Resolves strict workspace for artifact IPC mutations; never trusts renderer-supplied paths. */
export function resolveArtifactMutationWorkspace(input: {
  db: AppDatabase
  sessionId: string
  profiles: WorkDirProfile[]
  artifact?: ArtifactRecord
}): ArtifactMutationWorkspace {
  const session = getSession(input.db, input.sessionId)
  if (!session) return { ok: false, errorCode: ErrorCodes.ARTIFACT_WORKSPACE_UNAVAILABLE }
  if (input.artifact && input.artifact.sessionId !== input.sessionId) {
    return { ok: false, errorCode: ErrorCodes.ARTIFACT_WORKSPACE_UNAVAILABLE }
  }
  const resolved = resolveArtifactWorkspaceStrict({
    db: input.db,
    sessionId: input.sessionId,
    profiles: input.profiles,
    expectedWorkspaceRootReal: input.artifact?.workspaceRootReal
  })
  if (!resolved.ok) return resolved
  return { ...resolved, ...(input.artifact ? { artifact: input.artifact } : {}) }
}
