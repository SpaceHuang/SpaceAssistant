import type { DatabaseSync } from 'node:sqlite'
import { sessionLedgerLocationIdentity, type SessionLedgerLocationInput } from '../../../sessionLedgerIdentity'

export type SessionLedgerAvailabilityFact = Readonly<{
  state: 'uninitialized' | 'initializing' | 'unknown' | 'checking' | 'ready' | 'dirty' | 'blocked'
  reason?: 'readiness-missing'
  locationKey: string
  ledgerGeneration?: number
  canonicalWatermark?: string | null
  failureClass?: string | null
}>

/** Reads the existing location-scoped ledger readiness without creating or persisting an aggregate ready flag. */
export function readSessionLedgerAvailability(conn: DatabaseSync, location: SessionLedgerLocationInput): SessionLedgerAvailabilityFact {
  const identity = sessionLedgerLocationIdentity(location)
  const readiness = conn.prepare(`SELECT state,ledger_generation,canonical_watermark,failure_class
    FROM session_ledger_projection_state WHERE ledger_location_key=?`).get(identity.key) as {
      state: SessionLedgerAvailabilityFact['state']; ledger_generation: number; canonical_watermark: string | null; failure_class: string | null
    } | undefined
  return readiness ? Object.freeze({ state: readiness.state, locationKey: identity.key,
    ledgerGeneration: readiness.ledger_generation, canonicalWatermark: readiness.canonical_watermark,
    failureClass: readiness.failure_class }) : Object.freeze({ state: 'unknown' as const, reason: 'readiness-missing' as const, locationKey: identity.key })
}

/** Returns the canonical-read cutover only when every durable location identity still matches. */
export function readCanonicalSessionLedgerReadVersion(conn: DatabaseSync, location: SessionLedgerLocationInput,
  sessionGeneration: string): 1 | null {
  const identity = sessionLedgerLocationIdentity(location)
  const row = conn.prepare(`SELECT canonical_read_version,work_dir_identity,session_id,session_generation,state
    FROM session_ledger_projection_state WHERE ledger_location_key=?`).get(identity.key) as {
      canonical_read_version: number | null; work_dir_identity: string; session_id: string; session_generation: string; state: string
    } | undefined
  return row?.canonical_read_version === 1 && row.work_dir_identity === identity.workDirIdentity &&
    row.session_id === location.sessionId && row.session_generation === sessionGeneration && row.state === 'ready' ? 1 : null
}
