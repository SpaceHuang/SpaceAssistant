import fs from 'fs/promises'
import path from 'path'

export type OutputArtifactCleanupResult = Readonly<{ success: true; scanned: number; removed: number; failed: 0 }>

/** Remove expired files. Only ENOENT is treated as an already-completed filesystem change. */
export async function cleanupExpiredOutputArtifacts(
  directory: string,
  maxAgeMs: number,
  now = Date.now()
): Promise<OutputArtifactCleanupResult> {
  let entries
  try { entries = await fs.readdir(directory, { withFileTypes: true }) }
  catch (error) {
    if (isErrno(error, 'ENOENT')) return { success: true, scanned: 0, removed: 0, failed: 0 }
    throw error
  }
  let removed = 0
  let scanned = 0
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const filePath = path.join(directory, entry.name)
    let stat
    try { stat = await fs.stat(filePath) }
    catch (error) { if (isErrno(error, 'ENOENT')) continue; throw error }
    scanned += 1
    if (now - stat.mtimeMs <= maxAgeMs) continue
    try { await fs.unlink(filePath); removed += 1 }
    catch (error) { if (!isErrno(error, 'ENOENT')) throw error }
  }
  return { success: true, scanned, removed, failed: 0 }
}

export function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code)
}
