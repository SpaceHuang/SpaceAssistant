import fs from 'node:fs/promises'
import { ArtifactPathLeaseRegistry } from './pathLeaseRegistry'
import { assertArtifactWorkspaceIdentity } from './workspaceRecheck'

/** Deletes a resolved artifact file under a delete tombstone lease. Database marking is done by the caller after success. */
export async function deleteArtifactFile(input: {
  registry: ArtifactPathLeaseRegistry
  identity: string
  targetPath: string
  workDir?: string
  expectedWorkspaceRootReal?: string
  artifactId?: string
  repository?: { markDeleted(id: string): void }
}): Promise<{ deleted: boolean }> {
  const lease = input.registry.claimDelete(input.identity)
  try {
    if (input.workDir && input.expectedWorkspaceRootReal) {
      await assertArtifactWorkspaceIdentity({
        workDir: input.workDir,
        expectedWorkspaceRootReal: input.expectedWorkspaceRootReal
      })
    }
    try {
      await fs.unlink(input.targetPath)
      if (input.repository && input.artifactId) input.repository.markDeleted(input.artifactId)
      return { deleted: true }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (input.repository && input.artifactId) input.repository.markDeleted(input.artifactId)
        return { deleted: false }
      }
      throw error
    }
  } finally {
    lease.release()
  }
}
