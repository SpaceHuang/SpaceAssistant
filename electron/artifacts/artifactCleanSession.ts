import { ArtifactPathLeaseRegistry } from './pathLeaseRegistry'
import { deleteArtifactFile } from './artifactDeletion'
import type { ArtifactRecord, ArtifactRepository } from './artifactRepository'

export type CleanSkipReason = 'not-scratch' | 'in-use' | 'unsafe' | 'reference-opt-in-required'

export async function cleanArtifactSession(input: {
  repository: Pick<ArtifactRepository, 'listBySession' | 'markDeleted'>
  registry: ArtifactPathLeaseRegistry
  sessionId: string
  includeReferences?: boolean
  isSafePath?: (artifact: ArtifactRecord) => boolean
}): Promise<{ deleted: string[]; skipped: Array<{ id: string; reason: CleanSkipReason }> }> {
  const deleted: string[] = []
  const skipped: Array<{ id: string; reason: CleanSkipReason }> = []
  for (const artifact of input.repository.listBySession(input.sessionId)) {
    if (artifact.status !== 'active' || (artifact.container !== 'scratch' && artifact.container !== 'reference')) {
      skipped.push({ id: artifact.id, reason: 'not-scratch' }); continue
    }
    if (artifact.container === 'reference' && !input.includeReferences) {
      skipped.push({ id: artifact.id, reason: 'reference-opt-in-required' }); continue
    }
    if (input.isSafePath && !input.isSafePath(artifact)) {
      skipped.push({ id: artifact.id, reason: 'unsafe' }); continue
    }
    try {
      await deleteArtifactFile({ registry: input.registry, identity: artifact.pathIdentityKey, targetPath: artifact.canonicalPath, artifactId: artifact.id, repository: input.repository })
      deleted.push(artifact.id)
    } catch (error) {
      if (error instanceof Error && error.message.includes('lease')) skipped.push({ id: artifact.id, reason: 'in-use' })
      else throw error
    }
  }
  return { deleted, skipped }
}
