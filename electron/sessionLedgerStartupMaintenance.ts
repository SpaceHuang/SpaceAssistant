import type { DatabaseSync } from 'node:sqlite'
import type { SessionLedgerLocationInput } from './sessionLedgerIdentity'

export type SessionLedgerStartupMaintenanceResult = Readonly<{
  inspectedCount: number
  repairedCount: number
  repairFailureCount: number
  skippedCount: number
}>

type StaleLedgerRow = { session_id: string; created_at: number; work_dir_identity: string; session_generation: string }

/** Runs the existing ledger readiness command once for persisted stale locations only. */
export function createSessionLedgerStartupMaintenance(input: {
  conn: DatabaseSync
  resolve(row: StaleLedgerRow): { location: SessionLedgerLocationInput; sessionGeneration: string } | undefined
  repair(location: SessionLedgerLocationInput, sessionGeneration: string): Promise<boolean>
  onAttempt?(result: { location: SessionLedgerLocationInput; status: 'repaired' | 'failed' }): void
}): { run(): Promise<SessionLedgerStartupMaintenanceResult> } {
  let result: Promise<SessionLedgerStartupMaintenanceResult> | undefined
  return {
    run() {
      if (result) return result
      result = (async () => {
        const rows = input.conn.prepare(`SELECT state.session_id,state.created_at,state.work_dir_identity,state.session_generation
          FROM session_ledger_projection_state state
          WHERE state.state <> 'ready' OR EXISTS (
            SELECT 1 FROM session_ledger_projection_outbox outbox
            WHERE outbox.ledger_location_key=state.ledger_location_key AND outbox.status='pending'
          )
          ORDER BY state.updated_at,state.session_id`).all() as StaleLedgerRow[]
        let repairedCount = 0
        let repairFailureCount = 0
        let skippedCount = 0
        for (const row of rows) {
          let target: ReturnType<typeof input.resolve>
          try { target = input.resolve(row) } catch { target = undefined }
          if (!target) {
            skippedCount += 1
            continue
          }
          let repaired = false
          try { repaired = await input.repair(target.location, target.sessionGeneration) } catch { repaired = false }
          if (repaired) repairedCount += 1
          else repairFailureCount += 1
          try { input.onAttempt?.({ location: target.location, status: repaired ? 'repaired' : 'failed' }) } catch { /* diagnostics are best effort */ }
        }
        return Object.freeze({ inspectedCount: rows.length, repairedCount, repairFailureCount, skippedCount })
      })()
      return result
    }
  }
}
