import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export type LegacyBackupArchiveResult = { status: 'missing' | 'declined' | 'archived'; archivePath?: string; bytes?: number }

/** Archive the one-time JSON migration backup only after an explicit user decision. */
export function archiveLegacyDatabaseJsonBackup(userDataDir: string, confirmed: boolean): LegacyBackupArchiveResult {
  const sourcePath = path.join(userDataDir, 'bak-spaceassistant-data.json')
  if (!fs.existsSync(sourcePath)) return { status: 'missing' }
  if (!confirmed) return { status: 'declined' }
  const bytes = fs.statSync(sourcePath).size
  const archiveDir = path.join(userDataDir, 'session-archives', 'legacy-json')
  fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 })
  const archivePath = path.join(archiveDir, `bak-spaceassistant-data-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`)
  fs.renameSync(sourcePath, archivePath)
  if (fs.statSync(archivePath).size !== bytes) {
    try { fs.renameSync(archivePath, sourcePath) } catch { /* retain verified archive if rollback is unavailable */ }
    throw new Error('legacy JSON backup archive size verification failed')
  }
  return { status: 'archived', archivePath, bytes }
}
