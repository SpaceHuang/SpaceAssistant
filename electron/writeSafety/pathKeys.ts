import path from 'node:path'
import { pathIdentity } from './pathIdentity'

/** Unified lease key across tool writes, deletes, and relocate. */
export function leaseKey(workspaceRootReal: string, pathIdentityKey: string): string {
  return `${workspaceRootReal}\0${pathIdentityKey}`
}

/** Absolute path for IO from a stored absolute or workDir-relative canonical path. */
export function toAbsolutePath(workDir: string, canonicalPath: string): string {
  return path.isAbsolute(canonicalPath) ? canonicalPath : path.resolve(workDir, canonicalPath)
}

/** Relative workspace path using POSIX separators. */
export function toRelativePath(workDir: string, absoluteOrRelative: string): string {
  const absolute = toAbsolutePath(workDir, absoluteOrRelative)
  return path.relative(workDir, absolute).replace(/\\/g, '/')
}

/** Identity for a workspace-relative final path. */
export function pathIdentityForRelative(workDir: string, relativePath: string): string {
  return pathIdentity(toAbsolutePath(workDir, relativePath))
}

/** Lease identity for a workspace path (absolute or relative). */
export function leaseKeyForPath(workspaceRootReal: string, workDir: string, pathValue: string): string {
  return leaseKey(workspaceRootReal, pathIdentity(toAbsolutePath(workDir, pathValue)))
}
