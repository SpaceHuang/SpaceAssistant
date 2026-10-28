import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { runInTransaction } from './database/transaction'
import { sessionLedgerLocationIdentity, type SessionLedgerLocationInput } from './sessionLedgerIdentity'

export type SessionLedgerReadinessState = 'uninitialized' | 'initializing' | 'unknown' | 'checking' | 'ready' | 'dirty' | 'blocked'
export type SessionLedgerLogicalState = 'absent' | 'usable' | 'stale'

/** Maps the durable legacy state machine to the read-only three-state contract. */
export function mapSessionLedgerPhysicalState(state: SessionLedgerReadinessState | undefined): SessionLedgerLogicalState {
  if (state === undefined) return 'absent'
  return state === 'ready' ? 'usable' : 'stale'
}

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

export function readSessionLedgerReadiness(conn: DatabaseSync, ledgerLocationKey: string): SessionLedgerReadiness | undefined {
  const row = conn.prepare('SELECT * FROM session_ledger_projection_state WHERE ledger_location_key=?').get(ledgerLocationKey) as Record<string, unknown> | undefined
  return row ? rowToReadiness(row) : undefined
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
    case 'dirty':
      return readiness.proofFileIdentity && readiness.canonicalWatermark !== null
        ? { kind: 'check-target' }
        : { kind: 'check-baseline' }
    case 'blocked': return { kind: 'retry-blocked', scope: readiness.retryScope ?? 'baseline' }
  }
}

export function markMissingLegacyLedgerBlocked(conn: DatabaseSync, ledgerLocationKey: string, now = Date.now()): boolean {
  const changed = conn.prepare(`UPDATE session_ledger_projection_state
    SET state='blocked',check_token=NULL,retry_scope='baseline',failure_class='ledger_missing',updated_at=?
    WHERE ledger_location_key=? AND origin='legacy' AND state<>'blocked'`).run(now, ledgerLocationKey) as { changes: number | bigint }
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

export function beginSessionLedgerBootstrap(conn: DatabaseSync, ledgerLocationKey: string, bootstrapId: string, now = Date.now()): boolean {
  const result = conn.prepare(`UPDATE session_ledger_projection_state SET state='initializing',updated_at=?
    WHERE ledger_location_key=? AND origin='new_location' AND state='uninitialized' AND bootstrap_id=?`)
    .run(now, ledgerLocationKey, bootstrapId) as { changes: number | bigint }
  return Number(result.changes) === 1
}

export function completeSessionLedgerBootstrap(conn: DatabaseSync, ledgerLocationKey: string, bootstrapId: string,
  proof: SessionLedgerReadyProof, now = Date.now()): boolean {
  if (!isValidReadyProof(proof)) return false
  const result = conn.prepare(`UPDATE session_ledger_projection_state SET state=CASE WHEN EXISTS(
      SELECT 1 FROM session_ledger_projection_outbox outbox WHERE outbox.ledger_location_key=session_ledger_projection_state.ledger_location_key AND outbox.status='pending'
    ) THEN 'dirty' ELSE 'ready' END,
    canonical_watermark=?,ledger_generation=?,proof_file_identity=?,proof_file_bytes=?,proof_tail_frame=?,
    proof_index_seq=?,proof_index_event_count=?,proof_index_bytes=?,proof_index_last_at=?,checked_at=?,updated_at=?
    WHERE ledger_location_key=? AND origin='new_location' AND state='initializing' AND bootstrap_id=?`).run(
    proof.canonicalWatermark, proof.ledgerGeneration, proof.fileIdentity, proof.fileBytes, proof.tailFrame,
    proof.indexSeq, proof.indexEventCount, proof.indexBytes, proof.indexLastAt, now, now, ledgerLocationKey, bootstrapId
  ) as { changes: number | bigint }
  return Number(result.changes) === 1
}

/** Claims a baseline check and mints a compare-and-swap token. */
export function beginSessionLedgerCheck(conn: DatabaseSync, ledgerLocationKey: string, now = Date.now()): string | null {
  const token = randomUUID()
  const result = conn.prepare(`UPDATE session_ledger_projection_state SET state='checking',check_token=?,updated_at=?
    WHERE ledger_location_key=? AND (state='unknown' OR (state='dirty' AND canonical_watermark IS NULL))`)
    .run(token, now, ledgerLocationKey) as { changes: number | bigint }
  return Number(result.changes) === 1 ? token : null
}

/** A stale async baseline completion cannot overwrite a newer state or a different check owner. */
export function completeSessionLedgerCheck(conn: DatabaseSync, ledgerLocationKey: string, checkToken: string, proof: SessionLedgerReadyProof, now = Date.now()): boolean {
  if (!isValidReadyProof(proof)) return false
  const result = conn.prepare(`UPDATE session_ledger_projection_state SET state=CASE WHEN EXISTS(
      SELECT 1 FROM session_ledger_projection_outbox outbox WHERE outbox.ledger_location_key=session_ledger_projection_state.ledger_location_key AND outbox.status='pending'
    ) THEN 'dirty' ELSE 'ready' END,
    check_token=NULL,retry_scope=NULL,failure_class=NULL,
    canonical_watermark=?,ledger_generation=?,proof_file_identity=?,proof_file_bytes=?,proof_tail_frame=?,
    proof_index_seq=?,proof_index_event_count=?,proof_index_bytes=?,proof_index_last_at=?,checked_at=?,updated_at=?
    WHERE ledger_location_key=? AND state='checking' AND check_token=?`).run(
    proof.canonicalWatermark, proof.ledgerGeneration, proof.fileIdentity, proof.fileBytes, proof.tailFrame,
    proof.indexSeq, proof.indexEventCount, proof.indexBytes, proof.indexLastAt, now, now, ledgerLocationKey, checkToken
  ) as { changes: number | bigint }
  return Number(result.changes) === 1
}

function isValidReadyProof(proof: SessionLedgerReadyProof): boolean {
  return Number.isSafeInteger(proof.ledgerGeneration) && proof.ledgerGeneration >= 0 &&
    Number.isSafeInteger(proof.fileBytes) && proof.fileBytes >= 0 &&
    Number.isSafeInteger(proof.indexSeq) && proof.indexSeq >= 0 &&
    Number.isSafeInteger(proof.indexEventCount) && proof.indexEventCount >= 0 &&
    Number.isSafeInteger(proof.indexBytes) && proof.indexBytes >= 0 &&
    Boolean(proof.fileIdentity) && Boolean(proof.tailFrame) && Boolean(proof.canonicalWatermark)
}

export function recoverInterruptedSessionLedgerCheck(conn: DatabaseSync, ledgerLocationKey: string, now = Date.now()): boolean {
  const result = conn.prepare(`UPDATE session_ledger_projection_state SET state='unknown',check_token=NULL,updated_at=?
    WHERE ledger_location_key=? AND state='checking'`).run(now, ledgerLocationKey) as { changes: number | bigint }
  return Number(result.changes) === 1
}

export function beginSessionLedgerTargetCheck(conn: DatabaseSync, ledgerLocationKey: string, now = Date.now()): string | null {
  const token = randomUUID()
  const result = conn.prepare(`UPDATE session_ledger_projection_state SET state='checking',check_token=?,updated_at=?
    WHERE ledger_location_key=? AND state='dirty' AND canonical_watermark IS NOT NULL AND proof_file_identity IS NOT NULL`)
    .run(token, now, ledgerLocationKey) as { changes: number | bigint }
  return Number(result.changes) === 1 ? token : null
}

export function completeSessionLedgerTargetCheck(conn: DatabaseSync, ledgerLocationKey: string, checkToken: string,
  proof: SessionLedgerReadyProof, now = Date.now()): boolean {
  if (!isValidReadyProof(proof)) return false
  const result = conn.prepare(`UPDATE session_ledger_projection_state SET state='ready',check_token=NULL,retry_scope=NULL,failure_class=NULL,
    canonical_watermark=?,ledger_generation=?,proof_file_identity=?,proof_file_bytes=?,proof_tail_frame=?,
    proof_index_seq=?,proof_index_event_count=?,proof_index_bytes=?,proof_index_last_at=?,checked_at=?,updated_at=?
    WHERE ledger_location_key=? AND state='checking' AND check_token=? AND NOT EXISTS(
      SELECT 1 FROM session_ledger_projection_outbox outbox WHERE outbox.ledger_location_key=? AND outbox.status='pending')`).run(
    proof.canonicalWatermark, proof.ledgerGeneration, proof.fileIdentity, proof.fileBytes, proof.tailFrame,
    proof.indexSeq, proof.indexEventCount, proof.indexBytes, proof.indexLastAt, now, now, ledgerLocationKey, checkToken, ledgerLocationKey
  ) as { changes: number | bigint }
  return Number(result.changes) === 1
}

export function advanceSessionLedgerOwnerReconciliation(conn: DatabaseSync, ledgerLocationKey: string, processGeneration: number, now = Date.now()): boolean {
  const result = conn.prepare(`UPDATE session_ledger_projection_state SET owner_reconciled_process_generation=?,updated_at=?
    WHERE ledger_location_key=? AND owner_reconciled_process_generation<?`)
    .run(processGeneration, now, ledgerLocationKey, processGeneration) as { changes: number | bigint }
  return Number(result.changes) === 1
}

export function markSessionLedgerBlocked(conn: DatabaseSync, ledgerLocationKey: string, scope: 'baseline' | 'target', failureClass: string, now = Date.now()): boolean {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(failureClass)) throw new Error('SESSION_LEDGER_FAILURE_CLASS_INVALID')
  const result = conn.prepare(`UPDATE session_ledger_projection_state SET state='blocked',check_token=NULL,retry_scope=?,failure_class=?,updated_at=?
    WHERE ledger_location_key=? AND state<>'blocked'`).run(scope, failureClass, now, ledgerLocationKey) as { changes: number | bigint }
  return Number(result.changes) === 1
}

export function reopenBlockedSessionLedger(conn: DatabaseSync, ledgerLocationKey: string, now = Date.now()): boolean {
  const result = conn.prepare(`UPDATE session_ledger_projection_state SET state=CASE
      WHEN retry_scope='target' AND canonical_watermark IS NOT NULL AND proof_file_identity IS NOT NULL THEN 'dirty' ELSE 'unknown' END,
    retry_scope=NULL,failure_class=NULL,updated_at=? WHERE ledger_location_key=? AND state='blocked'`)
    .run(now, ledgerLocationKey) as { changes: number | bigint }
  return Number(result.changes) === 1
}

export function invalidateSessionLedgerProof(conn: DatabaseSync, ledgerLocationKey: string, now = Date.now()): boolean {
  const result = conn.prepare(`UPDATE session_ledger_projection_state SET state='unknown',ledger_generation=ledger_generation+1,check_token=NULL,updated_at=?
    WHERE ledger_location_key=? AND state='ready'`).run(now, ledgerLocationKey) as { changes: number | bigint }
  return Number(result.changes) === 1
}

/** Refreshes proof only for a healthy ledger with no unacknowledged canonical obligation. */
export function refreshSessionLedgerReadyProof(conn: DatabaseSync, ledgerLocationKey: string, proof: SessionLedgerReadyProof, now = Date.now()): boolean {
  const result = conn.prepare(`UPDATE session_ledger_projection_state SET canonical_watermark=?,ledger_generation=?,
      proof_file_identity=?,proof_file_bytes=?,proof_tail_frame=?,proof_index_seq=?,proof_index_event_count=?,
      proof_index_bytes=?,proof_index_last_at=?,checked_at=?,updated_at=?
    WHERE ledger_location_key=? AND state='ready' AND NOT EXISTS(
      SELECT 1 FROM session_ledger_projection_outbox outbox
      WHERE outbox.ledger_location_key=session_ledger_projection_state.ledger_location_key AND outbox.status='pending')`)
    .run(proof.canonicalWatermark, proof.ledgerGeneration, proof.fileIdentity, proof.fileBytes, proof.tailFrame,
      proof.indexSeq, proof.indexEventCount, proof.indexBytes, proof.indexLastAt, now, now, ledgerLocationKey) as { changes: number | bigint }
  return Number(result.changes) === 1
}
