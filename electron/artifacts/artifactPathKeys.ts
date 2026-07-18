import path from 'node:path'
import { artifactPathIdentity } from './pathIdentity'

/** Unified lease key across tool writes, deletes, and relocate. */
export function artifactLeaseKey(workspaceRootReal: string, pathIdentityKey: string): string {
  return `${workspaceRootReal}\0${pathIdentityKey}`
}

/** Relative workspace path using POSIX separators. */
export function toArtifactRelativePath(workDir: string, absoluteOrRelative: string): string {
  const absolute = path.isAbsolute(absoluteOrRelative)
    ? absoluteOrRelative
    : path.resolve(workDir, absoluteOrRelative)
  return path.relative(workDir, absolute).replace(/\\/g, '/')
}

/** Identity for a workspace-relative final path. */
export function artifactPathIdentityForRelative(workDir: string, relativePath: string): string {
  return artifactPathIdentity(path.resolve(workDir, relativePath))
}
