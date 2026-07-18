import { normalizeToolRelPath } from './normalizeToolRelPath'
import { ArtifactPathLeaseRegistry, type ArtifactPathLease } from './pathLeaseRegistry'
import { artifactLeaseKey, artifactPathIdentityForRelative } from './artifactPathKeys'
import { resolveWorkspaceRootReal } from './toolArtifactPath'

const sharedRegistry = new ArtifactPathLeaseRegistry()
const sessionWriteIdentities = new Map<string, Set<string>>()
const heldWriteLeases = new Map<string, ArtifactPathLease>()

function sessionPathKey(sessionId: string, identity: string): string {
  return `${sessionId}\0${identity}`
}

function resolveLeaseIdentity(relPath: string, workDir?: string): string {
  const normalized = normalizeToolRelPath(relPath)
  if (!normalized) return ''
  if (!workDir) return normalized
  const workspaceRootReal = resolveWorkspaceRootReal(workDir)
  return artifactLeaseKey(workspaceRootReal, artifactPathIdentityForRelative(workDir, normalized))
}

/** Process-wide lease registry shared by tool loop and artifact mutation services. */
export function getSharedArtifactPathLeaseRegistry(): ArtifactPathLeaseRegistry {
  return sharedRegistry
}

export function checkToolWriteLeaseConflict(sessionId: string, relPath: string, workDir?: string): string | null {
  const identity = resolveLeaseIdentity(relPath, workDir)
  if (!identity) return null
  const display = normalizeToolRelPath(relPath) || identity
  const ownerEntry = [...sessionWriteIdentities.entries()].find(([, paths]) => paths.has(identity))
  if (ownerEntry && ownerEntry[0] !== sessionId) {
    return `文件「${display}」正被其他会话占用写入，请稍后再试或切换到该会话后再操作。`
  }
  if (ownerEntry && ownerEntry[0] === sessionId) return null
  try {
    const probe = sharedRegistry.acquireWrite(identity)
    probe.release()
  } catch {
    return `文件「${display}」正被其他会话占用写入，请稍后再试或切换到该会话后再操作。`
  }
  return null
}

export function acquireToolWriteLease(sessionId: string, relPath: string, workDir?: string): ArtifactPathLease {
  const identity = resolveLeaseIdentity(relPath, workDir)
  if (!identity) return { release: () => undefined }
  const conflict = checkToolWriteLeaseConflict(sessionId, relPath, workDir)
  if (conflict) throw new Error(conflict)
  if (sessionWriteIdentities.get(sessionId)?.has(identity)) {
    return heldWriteLeases.get(sessionPathKey(sessionId, identity)) ?? { release: () => undefined }
  }
  const lease = sharedRegistry.acquireWrite(identity)
  let paths = sessionWriteIdentities.get(sessionId)
  if (!paths) {
    paths = new Set()
    sessionWriteIdentities.set(sessionId, paths)
  }
  paths.add(identity)
  const key = sessionPathKey(sessionId, identity)
  heldWriteLeases.set(key, lease)
  let released = false
  return {
    release: () => {
      if (released) return
      released = true
      lease.release()
      heldWriteLeases.delete(key)
      paths!.delete(identity)
      if (paths!.size === 0) sessionWriteIdentities.delete(sessionId)
    }
  }
}

export function releaseAllToolPathLeasesForSession(sessionId: string): void {
  const paths = sessionWriteIdentities.get(sessionId)
  if (!paths) return
  for (const identity of [...paths]) {
    const key = sessionPathKey(sessionId, identity)
    heldWriteLeases.get(key)?.release()
    heldWriteLeases.delete(key)
  }
  sessionWriteIdentities.delete(sessionId)
}

/** Test helper — clears process-wide lease state. */
export function clearToolPathLeases(): void {
  for (const lease of [...heldWriteLeases.values()]) lease.release()
  heldWriteLeases.clear()
  sessionWriteIdentities.clear()
}

export function toolWriteLeaseIdentity(workDir: string, relPath: string): string {
  return resolveLeaseIdentity(relPath, workDir)
}

export function artifactDeleteLeaseIdentity(workspaceRootReal: string, pathIdentityKey: string): string {
  return artifactLeaseKey(workspaceRootReal, pathIdentityKey)
}
