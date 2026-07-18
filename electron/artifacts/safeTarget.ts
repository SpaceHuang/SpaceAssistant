import path from 'node:path'
import { resolveSafeWriteTarget, type SafeWriteTarget } from '../pathSecurity'
import { assertArtifactWorkspaceIdentity } from './workspaceRecheck'

function isForeignAbsolutePath(target: string): boolean {
  return path.isAbsolute(target) || path.win32.isAbsolute(target) || /^\\\\/.test(target)
}

/** Artifact paths are always relative to the session's resolved workspace. */
export async function resolveArtifactSafeTarget(
  workDir: string,
  requestedPath: string,
  expectedWorkspaceRootReal?: string
): Promise<SafeWriteTarget> {
  if (!requestedPath || isForeignAbsolutePath(requestedPath) || requestedPath.split(/[\\/]+/).includes('..')) {
    throw new Error('Unsafe artifact path')
  }
  if (expectedWorkspaceRootReal) await assertArtifactWorkspaceIdentity({ workDir, expectedWorkspaceRootReal })
  return resolveSafeWriteTarget(workDir, requestedPath)
}
