import fs from 'fs/promises'
import path from 'path'

export async function cleanupExpiredOutputArtifacts(
  directory: string,
  maxAgeMs: number,
  now = Date.now()
): Promise<{ removed: number; failed: number }> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
  let removed = 0
  let failed = 0
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const filePath = path.join(directory, entry.name)
    try {
      const stat = await fs.stat(filePath)
      if (now - stat.mtimeMs <= maxAgeMs) continue
      await fs.unlink(filePath)
      removed += 1
    } catch {
      failed += 1
    }
  }
  return { removed, failed }
}
