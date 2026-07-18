import fs from 'node:fs'
import type { WorkDirProfile } from '../../src/shared/feishuTypes'
import { getSession, updateSession, type AppDatabase } from '../database'
import { ErrorCodes } from '../../src/shared/errorCodes'

export type StrictWorkspaceResult =
  | { ok: true; profileId: string; workDir: string; workspaceRootReal: string }
  | { ok: false; errorCode: typeof ErrorCodes.ARTIFACT_WORKSPACE_UNAVAILABLE | typeof ErrorCodes.ARTIFACT_WORKSPACE_CHANGED }

export function resolveArtifactWorkspaceStrict(input: {
  db: AppDatabase
  sessionId: string
  profiles: WorkDirProfile[]
  legacyResolved?: { profileId: string; workDir: string }
  expectedWorkspaceRootReal?: string
  /** Present for callers that also know the active workspace; it is intentionally never used as a fallback. */
  activeWorkDir?: string
}): StrictWorkspaceResult {
  const session = getSession(input.db, input.sessionId)
  if (!session) return { ok: false, errorCode: ErrorCodes.ARTIFACT_WORKSPACE_UNAVAILABLE }
  const profileId = session.workDirProfileId ?? input.legacyResolved?.profileId
  const profile = input.profiles.find((candidate) => candidate.id === profileId)
  if (!profile) return { ok: false, errorCode: ErrorCodes.ARTIFACT_WORKSPACE_UNAVAILABLE }
  const workDir = session.workDirProfileId ? profile.path : input.legacyResolved?.workDir
  if (!workDir) return { ok: false, errorCode: ErrorCodes.ARTIFACT_WORKSPACE_UNAVAILABLE }
  let workspaceRootReal: string
  try {
    workspaceRootReal = fs.realpathSync(workDir)
  } catch {
    return { ok: false, errorCode: ErrorCodes.ARTIFACT_WORKSPACE_UNAVAILABLE }
  }
  if (input.expectedWorkspaceRootReal && workspaceRootReal !== input.expectedWorkspaceRootReal) {
    return { ok: false, errorCode: ErrorCodes.ARTIFACT_WORKSPACE_CHANGED }
  }
  if (!session.workDirProfileId) updateSession(input.db, session.id, { workDirProfileId: profile.id })
  return { ok: true, profileId: profile.id, workDir, workspaceRootReal }
}
