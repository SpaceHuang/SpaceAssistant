import path from 'node:path'
import { resolveSafeWriteTarget, type SafeWriteTarget } from '../pathSecurity'

function isForeignAbsolutePath(target: string): boolean {
  return path.isAbsolute(target) || path.win32.isAbsolute(target) || /^\\\\/.test(target)
}

/** Artifact paths are always relative to the session's resolved workspace. */
export async function resolveArtifactSafeTarget(workDir: string, requestedPath: string): Promise<SafeWriteTarget> {
  if (!requestedPath || isForeignAbsolutePath(requestedPath) || requestedPath.split(/[\\/]+/).includes('..')) {
    throw new Error('Unsafe artifact path')
  }
  return resolveSafeWriteTarget(workDir, requestedPath)
}
