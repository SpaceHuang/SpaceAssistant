import fs from 'node:fs'
import path from 'node:path'

/** Resolves the real workspace root for registration and lease keys. */
export function resolveWorkspaceRootReal(workDir: string): string {
  try {
    return fs.realpathSync(workDir)
  } catch {
    return path.resolve(workDir)
  }
}
