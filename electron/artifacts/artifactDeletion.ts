import fs from 'node:fs/promises'
import { ArtifactPathLeaseRegistry } from './pathLeaseRegistry'

/** Deletes a resolved artifact file under a delete tombstone lease. Database marking is done by the caller after success. */
export async function deleteArtifactFile(input: {
  registry: ArtifactPathLeaseRegistry
  identity: string
  targetPath: string
}): Promise<{ deleted: boolean }> {
  const lease = input.registry.claimDelete(input.identity)
  try {
    try {
      await fs.unlink(input.targetPath)
      return { deleted: true }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { deleted: false }
      throw error
    }
  } finally {
    lease.release()
  }
}
