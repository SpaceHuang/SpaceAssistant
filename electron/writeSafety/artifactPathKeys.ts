import path from 'node:path'
import { artifactPathIdentity } from './pathIdentity'

/** Unified lease key across tool writes, deletes, and relocate. */
export function artifactLeaseKey(workspaceRootReal: string, pathIdentityKey: string): string {
  return `${workspaceRootReal}\0${pathIdentityKey}`
}

/** Absolute path for IO from a stored absolute or workDir-relative canonical path. */
export function toAbsoluteArtifactPath(workDir: string, canonicalPath: string): string {
  return path.isAbsolute(canonicalPath) ? canonicalPath : path.resolve(workDir, canonicalPath)
}

/** Relative workspace path using POSIX separators. */
export function toArtifactRelativePath(workDir: string, absoluteOrRelative: string): string {
  const absolute = toAbsoluteArtifactPath(workDir, absoluteOrRelative)
  return path.relative(workDir, absolute).replace(/\\/g, '/')
}

/** Identity for a workspace-relative final path. */
export function artifactPathIdentityForRelative(workDir: string, relativePath: string): string {
  return artifactPathIdentity(toAbsoluteArtifactPath(workDir, relativePath))
}

/** Lease identity for a workspace path (absolute or relative). */
export function artifactLeaseKeyForPath(workspaceRootReal: string, workDir: string, pathValue: string): string {
  return artifactLeaseKey(workspaceRootReal, artifactPathIdentity(toAbsoluteArtifactPath(workDir, pathValue)))
}
