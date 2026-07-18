import fs from 'node:fs'
import path from 'node:path'

/** Stable path identity: filesystem identity when present, lexical identity before creation. */
export function artifactPathIdentity(targetPath: string): string {
  const normalized = path.normalize(targetPath)
  try {
    return fs.realpathSync(normalized)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return normalized
    throw error
  }
}
