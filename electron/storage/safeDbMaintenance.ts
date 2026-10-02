import type { AppDatabase } from '../database'
import { compactSessionDatabase } from './sessionStorageMaintenance'

export const SAFE_DB_MAINTENANCE_FLAG = '--safe-db-maintenance'

export function isSafeDbMaintenanceRequested(args: readonly string[]): boolean {
  return args.includes(SAFE_DB_MAINTENANCE_FLAG)
}

/** Runs after the app window is visible; caller intentionally skips canonical History recovery for this launch. */
export async function runSafeDbMaintenance(db: AppDatabase, userDataDir: string): Promise<void> {
  await compactSessionDatabase(db, userDataDir, undefined, { clearProjectionCachesAfterArchive: true })
}
