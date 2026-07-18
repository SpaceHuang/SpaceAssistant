import { normalizeToolRelPath } from './artifacts/normalizeToolRelPath'
import type { ArtifactPathLease } from './artifacts/pathLeaseRegistry'
import {
  acquireToolWriteLease,
  checkToolWriteLeaseConflict,
  clearToolPathLeases,
  releaseAllToolPathLeasesForSession
} from './artifacts/toolPathLease'

export { normalizeToolRelPath }

const sessionLeases = new Map<string, Map<string, ArtifactPathLease>>()

export function checkWritePathConflict(sessionId: string, relPath: string, workDir?: string): string | null {
  return checkToolWriteLeaseConflict(sessionId, relPath, workDir)
}

export function claimWritePath(sessionId: string, relPath: string, workDir?: string): void {
  const identity = normalizeToolRelPath(relPath)
  if (!identity) return
  const lease = acquireToolWriteLease(sessionId, relPath, workDir)
  let byPath = sessionLeases.get(sessionId)
  if (!byPath) {
    byPath = new Map()
    sessionLeases.set(sessionId, byPath)
  }
  byPath.set(identity, lease)
}

export function releaseWritePath(sessionId: string, relPath: string): void {
  const identity = normalizeToolRelPath(relPath)
  if (!identity) return
  const byPath = sessionLeases.get(sessionId)
  const lease = byPath?.get(identity)
  if (!lease) return
  lease.release()
  byPath!.delete(identity)
  if (byPath!.size === 0) sessionLeases.delete(sessionId)
}

export function releaseAllWritePathsForSession(sessionId: string): void {
  const byPath = sessionLeases.get(sessionId)
  if (byPath) {
    for (const lease of byPath.values()) lease.release()
    sessionLeases.delete(sessionId)
  }
  releaseAllToolPathLeasesForSession(sessionId)
}

/** 测试用 */
export function clearWritePathOwners(): void {
  for (const byPath of sessionLeases.values()) {
    for (const lease of byPath.values()) lease.release()
  }
  sessionLeases.clear()
  clearToolPathLeases()
}
