import fs from 'node:fs/promises'
import type { ExecutionLane } from '../../src/shared/confirmation/types'
import { isPathWithinGrantedDirectory, normalizeDirectoryGrantPath, type SessionDirectoryGrantRecord } from '../../src/shared/sessionDirectoryGrant'

/** Return the selected-directory source only when this desktop session's root still has its original identity. */
export async function matchSessionDirectoryGrant(input: {
  grants: readonly SessionDirectoryGrantRecord[]
  sessionId: string
  lane: ExecutionLane
  targetPath: string
}): Promise<SessionDirectoryGrantRecord | undefined> {
  if (input.lane !== 'desktop' || !input.sessionId || !input.targetPath) return undefined
  for (const grant of input.grants) {
    if (grant.sessionId !== input.sessionId || grant.source !== 'user-selected-directory') continue
    try {
      const realRoot = await fs.realpath(grant.path)
      if (normalizeDirectoryGrantPath(realRoot) !== normalizeDirectoryGrantPath(grant.realPath)) continue
      const stat = await fs.stat(realRoot)
      if (!stat.isDirectory() || stat.dev !== grant.identity.dev || stat.ino !== grant.identity.ino || stat.mode !== grant.identity.mode) continue
      if (isPathWithinGrantedDirectory(input.targetPath, realRoot)) return grant
    } catch { /* unavailable, replaced, or permission-denied roots never authorize */ }
  }
  return undefined
}
