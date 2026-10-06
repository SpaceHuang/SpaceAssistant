import { collectSessionStorageCleanupEstimate } from '../electron/database/sessionStorageCleanupEstimate'

const dbPath = process.argv[2]
if (!dbPath) {
  console.error('Usage: node --import tsx scripts/session-storage-cleanup-estimate.ts <database-path>')
  process.exitCode = 2
} else {
  try { process.stdout.write(`${JSON.stringify(collectSessionStorageCleanupEstimate(dbPath), null, 2)}\n`) }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
