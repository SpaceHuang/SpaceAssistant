import { createHash } from 'node:crypto'

export type SessionLedgerLocationInput = { workDir: string; sessionId: string; createdAt: number }

/** Stable location identity; raw filesystem paths are kept out of the durable key and diagnostics. */
export function sessionLedgerLocationIdentity(input: SessionLedgerLocationInput): { key: string; workDirIdentity: string } {
  if (!input.workDir.trim() || !input.sessionId.trim() || !Number.isSafeInteger(input.createdAt)) {
    throw new Error('SESSION_LEDGER_LOCATION_INVALID')
  }
  const workDirIdentity = createHash('sha256').update(input.workDir).digest('hex')
  const key = createHash('sha256').update(`${workDirIdentity}\0${input.sessionId}\0${input.createdAt}`).digest('hex')
  return { key, workDirIdentity }
}
