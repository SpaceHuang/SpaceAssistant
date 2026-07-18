import { randomUUID } from 'node:crypto'
import type { ArtifactWriteIntent } from '../../src/shared/artifactTypes'
import type { ResolvedArtifactOutput } from './artifactResolver'
import { ArtifactRepository, type ArtifactRecord } from './artifactRepository'
import {
  artifactPathIdentityForRelative,
  toArtifactRelativePath
} from './artifactPathKeys'
import { resolveWorkspaceRootReal } from './toolArtifactPath'

/** Persists a resolved artifact only after the caller has completed a successful file write. */
export function registerResolvedArtifactWrite(input: {
  repository: ArtifactRepository
  sessionId: string
  workDirProfileId: string
  workDir: string
  workspaceRootReal?: string
  intent: ArtifactWriteIntent
  resolved: Pick<ResolvedArtifactOutput, 'finalPath' | 'canonicalPath' | 'provenance'>
}): ArtifactRecord {
  if (input.intent.artifactId) {
    const existing = input.repository.find(input.intent.artifactId)
    if (existing) {
      if (input.intent.stage && input.intent.stage !== existing.stage) {
        input.repository.updateStage(existing.id, input.intent.stage)
      }
      return {
        ...existing,
        ...(input.intent.stage ? { stage: input.intent.stage } : {})
      }
    }
  }
  const relativePath = toArtifactRelativePath(input.workDir, input.resolved.finalPath || input.resolved.canonicalPath)
  const workspaceRootReal = input.workspaceRootReal ?? resolveWorkspaceRootReal(input.workDir)
  return input.repository.create({
    id: input.intent.artifactId ?? randomUUID(),
    sessionId: input.sessionId,
    workDirProfileId: input.workDirProfileId,
    workspaceRootReal,
    packageId: input.intent.packageId,
    container: input.intent.container,
    role: input.intent.role,
    title: input.intent.title ?? '',
    stage: input.intent.stage,
    canonicalPath: relativePath,
    pathIdentityKey: artifactPathIdentityForRelative(input.workDir, relativePath),
    requestedPath: input.intent.requestedPath,
    ...input.resolved.provenance
  })
}
