import type { DatabaseSync } from 'node:sqlite'
import { sessionLedgerLocationIdentity, type SessionLedgerLocationInput } from '../sessionLedgerIdentity'
import { invalidateSessionLedgerProof } from '../sessionLedgerReadiness'
import type { createSessionLedgerRepairScheduler } from '../sessionLedgerRepairScheduler'

type RepairScheduler = ReturnType<typeof createSessionLedgerRepairScheduler>

/** Invalidates a reusable proof before scheduling recovery after any observed ledger I/O failure. */
export function handleSessionLedgerEventFailure(input: {
  conn: DatabaseSync
  scheduler: RepairScheduler
  location: SessionLedgerLocationInput
  generation: number
}): void {
  const identity = sessionLedgerLocationIdentity(input.location)
  try {
    invalidateSessionLedgerProof(input.conn, identity.key)
  } catch {
    // Repair still runs if the readiness database itself is temporarily unavailable.
  }
  input.scheduler.request(input.location, { retireSink: true, generation: input.generation })
}
