import path from 'node:path'
import { ArtifactPathLeaseRegistry } from './pathLeaseRegistry'
import { deleteArtifactFile } from './artifactDeletion'
import type { ArtifactRecord, ArtifactRepository } from './artifactRepository'
import { artifactDeleteLeaseIdentity } from './toolPathLease'

export type CleanSkipReason = 'not-scratch' | 'in-use' | 'unsafe' | 'reference-opt-in-required'

export async function cleanArtifactSession(input: {
  repository: Pick<ArtifactRepository, 'listBySession' | 'markDeleted'>
  registry: ArtifactPathLeaseRegistry
  sessionId: string
  workDir?: string
  includeReferences?: boolean
  isSafePath?: (artifact: ArtifactRecord) => boolean
}): Promise<{ deleted: string[]; skipped: Array<{ id: string; reason: CleanSkipReason }> }> {
  const deleted: string[] = []
  const skipped: Array<{ id: string; reason: CleanSkipReason }> = []
  for (const artifact of input.repository.listBySession(input.sessionId)) {
    if (artifact.status !== 'active') continue
    const isScratch = artifact.container === 'scratch'
    const isReference = artifact.role === 'reference'
    if (!isScratch && !isReference) {
      skipped.push({ id: artifact.id, reason: 'not-scratch' })
      continue
    }
    if (isReference && !input.includeReferences) {
      skipped.push({ id: artifact.id, reason: 'reference-opt-in-required' })
      continue
    }
    if (input.isSafePath && !input.isSafePath(artifact)) {
      skipped.push({ id: artifact.id, reason: 'unsafe' })
      continue
    }
    try {
      const targetPath = input.workDir && !path.isAbsolute(artifact.canonicalPath)
        ? path.resolve(input.workDir, artifact.canonicalPath)
        : artifact.canonicalPath
      await deleteArtifactFile({
        registry: input.registry,
        identity: artifactDeleteLeaseIdentity(artifact.workspaceRootReal, artifact.pathIdentityKey),
        targetPath,
        workDir: input.workDir,
        expectedWorkspaceRootReal: artifact.workspaceRootReal,
        artifactId: artifact.id,
        repository: input.repository
      })
      deleted.push(artifact.id)
    } catch (error) {
      if (error instanceof Error && error.message.includes('lease')) {
        skipped.push({ id: artifact.id, reason: 'in-use' })
      } else if (error instanceof Error && /ARTIFACT_WORKSPACE_(CHANGED|UNAVAILABLE)/.test(error.message)) {
        skipped.push({ id: artifact.id, reason: 'unsafe' })
      } else {
        throw error
      }
    }
  }
  return { deleted, skipped }
}
