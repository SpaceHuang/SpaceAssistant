import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { lock as acquireFileLock } from 'proper-lockfile'

const lockRoot = path.join(os.tmpdir(), 'spaceassistant-session-ledger-locks')

/** Stable per-location lock target shared by all SpaceAssistant processes for this OS user. */
export function resolveSessionLedgerProcessLockTarget(locationKey: string): string {
  if (!/^[a-f0-9]{64}$/.test(locationKey)) throw new Error('SESSION_LEDGER_LOCATION_KEY_INVALID')
  return path.join(lockRoot, locationKey)
}

/** Creates/validates the persistent lock target; proper-lockfile owns only its transient sibling lock directory. */
export async function prepareSessionLedgerProcessLockTarget(locationKey: string): Promise<string> {
  const target = resolveSessionLedgerProcessLockTarget(locationKey)
  await fs.mkdir(lockRoot, { recursive: true, mode: 0o700 })
  try {
    const handle = await fs.open(target, 'wx', 0o600)
    await handle.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const stat = await fs.lstat(target)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('SESSION_LEDGER_PROCESS_LOCK_TARGET_INVALID')
  }
  return target
}

/** Cross-process fence for append, recovery, and retention operations on one ledger location. */
export async function withSessionLedgerProcessLock<T>(locationKey: string, operation: () => Promise<T>): Promise<T> {
  const target = await prepareSessionLedgerProcessLockTarget(locationKey)
  const release = await acquireFileLock(target, {
    realpath: false,
    stale: 30_000,
    update: 10_000,
    retries: { retries: 200, minTimeout: 10, maxTimeout: 100, factor: 1.2 }
  })
  try { return await operation() } finally { await release() }
}
