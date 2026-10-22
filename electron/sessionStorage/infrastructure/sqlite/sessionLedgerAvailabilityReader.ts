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
