import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { runInTransaction } from './database/transaction'
import { sessionLedgerLocationIdentity, type SessionLedgerLocationInput } from './sessionLedgerIdentity'

export type SessionLedgerReadinessState = 'uninitialized' | 'initializing' | 'unknown' | 'checking' | 'ready' | 'dirty' | 'blocked'
export type SessionLedgerReadiness = {
  ledgerLocationKey: string
  workDirIdentity: string
  sessionId: string
  sessionGeneration: string
  origin: 'new_location' | 'legacy'
  state: SessionLedgerReadinessState
  bootstrapId: string | null
  ledgerGeneration: number
  canonicalWatermark: string | null
  proofFileIdentity: string | null
  proofFileBytes: number | null
  proofTailFrame: string | null
  proofIndexSeq: number | null
  proofIndexEventCount: number | null
  proofIndexBytes: number | null
  proofIndexLastAt: number | null
  checkToken: string | null
  checkedAt: number | null
  ownerReconciledProcessGeneration: number
  retryScope: 'baseline' | 'target' | null
  failureClass: string | null
}

function rowToReadiness(row: Record<string, unknown>): SessionLedgerReadiness {
  return {
    ledgerLocationKey: row.ledger_location_key as string,
    workDirIdentity: row.work_dir_identity as string,
    sessionId: row.session_id as string,
    sessionGeneration: row.session_generation as string,
    origin: row.origin as 'new_location' | 'legacy',
    state: row.state as SessionLedgerReadinessState,
    bootstrapId: row.bootstrap_id as string | null,
    ledgerGeneration: row.ledger_generation as number,
    canonicalWatermark: row.canonical_watermark as string | null,
    proofFileIdentity: row.proof_file_identity as string | null,
    proofFileBytes: row.proof_file_bytes as number | null,
    proofTailFrame: row.proof_tail_frame as string | null,
    proofIndexSeq: row.proof_index_seq as number | null,
    proofIndexEventCount: row.proof_index_event_count as number | null,
    proofIndexBytes: row.proof_index_bytes as number | null,
    proofIndexLastAt: row.proof_index_last_at as number | null,
    checkToken: row.check_token as string | null,
    checkedAt: row.checked_at as number | null,
    ownerReconciledProcessGeneration: row.owner_reconciled_process_generation as number,
    retryScope: row.retry_scope as 'baseline' | 'target' | null,
    failureClass: row.failure_class as string | null
  }
}

/** Creates only legacy unknown state. Existence or emptiness of a ledger can never mint bootstrap provenance. */
export function ensureLegacyLedgerReadiness(conn: DatabaseSync, location: SessionLedgerLocationInput, sessionGeneration: string, now = Date.now()): SessionLedgerReadiness {
  const identity = sessionLedgerLocationIdentity(location)
  runInTransaction(conn, () => conn.prepare(`INSERT OR IGNORE INTO session_ledger_projection_state(
    ledger_location_key,work_dir_identity,created_at,session_id,session_generation,origin,state,bootstrap_id,updated_at)
    VALUES(?,?,?,?,?,'legacy','unknown',NULL,?)`).run(identity.key, identity.workDirIdentity, location.createdAt,
      location.sessionId, sessionGeneration, now))
  const row = conn.prepare('SELECT * FROM session_ledger_projection_state WHERE ledger_location_key=?').get(identity.key) as Record<string, unknown> | undefined
  if (!row || row.session_id !== location.sessionId || row.session_generation !== sessionGeneration || row.work_dir_identity !== identity.workDirIdentity) {
    throw new Error('SESSION_LEDGER_LOCATION_IDENTITY_CONFLICT')
  }
  return rowToReadiness(row)
}

export type SessionLedgerGateDecision =
  | { kind: 'bootstrap'; bootstrapId: string }
  | { kind: 'check-baseline' }
  | { kind: 'resume-bootstrap'; bootstrapId: string }
  | { kind: 'recover-check' }
  | { kind: 'check-target' }
  | { kind: 'allow-ready' }
  | { kind: 'retry-blocked'; scope: 'baseline' | 'target' }

export function decideSessionLedgerGate(readiness: SessionLedgerReadiness): SessionLedgerGateDecision {
  switch (readiness.state) {
    case 'uninitialized':
      if (readiness.origin !== 'new_location' || !readiness.bootstrapId) throw new Error('SESSION_LEDGER_BOOTSTRAP_PROVENANCE_INVALID')
      return { kind: 'bootstrap', bootstrapId: readiness.bootstrapId }
    case 'initializing':
      if (readiness.origin !== 'new_location' || !readiness.bootstrapId) throw new Error('SESSION_LEDGER_BOOTSTRAP_PROVENANCE_INVALID')
      return { kind: 'resume-bootstrap', bootstrapId: readiness.bootstrapId }
    case 'unknown': return { kind: 'check-baseline' }
    case 'checking': return { kind: 'recover-check' }
    case 'ready': return { kind: 'allow-ready' }
    case 'dirty': return { kind: 'check-target' }
    case 'blocked': return { kind: 'retry-blocked', scope: readiness.retryScope ?? 'baseline' }
  }
}

export function markMissingLegacyLedgerBlocked(conn: DatabaseSync, ledgerLocationKey: string, now = Date.now()): boolean {
  const changed = conn.prepare(`UPDATE session_ledger_projection_state
    SET state='blocked',check_token=NULL,retry_scope='baseline',failure_class='ledger_missing',updated_at=?
    WHERE ledger_location_key=? AND origin='legacy' AND state IN ('unknown','checking')`).run(now, ledgerLocationKey) as { changes: number | bigint }
  return Number(changed.changes) === 1
}

export type SessionLedgerReadyProof = {
  canonicalWatermark: string
  ledgerGeneration: number
  fileIdentity: string
  fileBytes: number
  tailFrame: string
  indexSeq: number
  indexEventCount: number
  indexBytes: number
  indexLastAt: number | null
}

/** Claims a baseline check and mints a compare-and-swap token. */
export function beginSessionLedgerCheck(conn: DatabaseSync, ledgerLocationKey: string, now = Date.now()): string | null {
  const token = randomUUID()
  const result = conn.prepare(`UPDATE session_ledger_projection_state SET state='checking',check_token=?,updated_at=?
    WHERE ledger_location_key=? AND state='unknown'`).run(token, now, ledgerLocationKey) as { changes: number | bigint }
  return Number(result.changes) === 1 ? token : null
}

/** A stale async baseline completion cannot overwrite a newer state or a different check owner. */
export function completeSessionLedgerCheck(conn: DatabaseSync, ledgerLocationKey: string, checkToken: string, proof: SessionLedgerReadyProof, now = Date.now()): boolean {
  if (!Number.isSafeInteger(proof.ledgerGeneration) || proof.ledgerGeneration < 0 ||
    !Number.isSafeInteger(proof.fileBytes) || proof.fileBytes < 0 ||
    !Number.isSafeInteger(proof.indexSeq) || proof.indexSeq < 0 ||
    !Number.isSafeInteger(proof.indexEventCount) || proof.indexEventCount < 0 ||
    !Number.isSafeInteger(proof.indexBytes) || proof.indexBytes < 0) return false
  const result = conn.prepare(`UPDATE session_ledger_projection_state SET state='ready',check_token=NULL,retry_scope=NULL,failure_class=NULL,
    canonical_watermark=?,ledger_generation=?,proof_file_identity=?,proof_file_bytes=?,proof_tail_frame=?,
    proof_index_seq=?,proof_index_event_count=?,proof_index_bytes=?,proof_index_last_at=?,checked_at=?,updated_at=?
    WHERE ledger_location_key=? AND state='checking' AND check_token=?`).run(
    proof.canonicalWatermark, proof.ledgerGeneration, proof.fileIdentity, proof.fileBytes, proof.tailFrame,
    proof.indexSeq, proof.indexEventCount, proof.indexBytes, proof.indexLastAt, now, now, ledgerLocationKey, checkToken
  ) as { changes: number | bigint }
  return Number(result.changes) === 1
}

export function recoverInterruptedSessionLedgerCheck(conn: DatabaseSync, ledgerLocationKey: string, now = Date.now()): boolean {
  const result = conn.prepare(`UPDATE session_ledger_projection_state SET state='unknown',check_token=NULL,updated_at=?
    WHERE ledger_location_key=? AND state='checking'`).run(now, ledgerLocationKey) as { changes: number | bigint }
  return Number(result.changes) === 1
}
