import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { runInTransaction } from '../database/transaction'
import { getCanonicalSpillChangeGeneration, parseSpillHistoryOwnerKey, spillHistoryOwnerKey, type SpillReferenceOwnerTable } from './spillReferenceIndex'
import { visitSpillReferencesOffThread } from './spillReferenceWorker'
import {
  claimSpillReferenceMaintenanceLease, validateSpillReferenceMaintenanceLease,
  renewSpillReferenceMaintenanceLease, type SpillReferenceMaintenanceLease
} from './spillReferenceBackfill'

const MAX_ROWS = 200
const MAX_BYTES = 8 * 1024 * 1024
const MAX_OWNER_BYTES = 64 * 1024 * 1024
const SQLITE_READ_CHUNK_BYTES = 512 * 1024
const TABLES: readonly { table: SpillReferenceOwnerTable; column: 'payload_json' | 'messages_json' }[] = [
  { table: 'agent_history_events', column: 'payload_json' },
  { table: 'session_transcript_entries', column: 'messages_json' }
]

type Cursor = { invocationId?: string; eventId?: string; key?: string; sessionId?: string; version?: number; direction?: 'canonical' | 'index'; done?: boolean }
function tableExists(conn: DatabaseSync, table: string): boolean {
  return conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined
}
function getCursor(conn: DatabaseSync, table: SpillReferenceOwnerTable): Cursor {
  const row = conn.prepare('SELECT reconcile_cursor_json FROM spill_reference_backfill_state WHERE owner_table=?').get(table) as { reconcile_cursor_json: string | null }
  return row.reconcile_cursor_json ? JSON.parse(row.reconcile_cursor_json) as Cursor : {}
}
function getPage(conn: DatabaseSync, table: SpillReferenceOwnerTable, cursor: Cursor): Array<{ key: string; sessionId?: string; version?: number; bytes: number }> {
  if (table === 'agent_history_events') return conn.prepare(`SELECT invocation_id AS invocationId,event_id AS eventId,length(CAST(payload_json AS BLOB)) AS bytes FROM agent_history_events
    WHERE (? IS NULL OR invocation_id>? OR (invocation_id=? AND event_id>?)) ORDER BY invocation_id,event_id LIMIT ?`)
    .all(cursor.invocationId ?? null, cursor.invocationId ?? null, cursor.invocationId ?? null, cursor.eventId ?? '', MAX_ROWS)
    .map((raw) => { const row = raw as { invocationId: string; eventId: string; bytes: number }; return { ...row, key: spillHistoryOwnerKey(row.invocationId, row.eventId) } })
  return conn.prepare(`SELECT session_id AS sessionId,version,length(CAST(messages_json AS BLOB)) AS bytes FROM session_transcript_entries
    WHERE (? IS NULL OR session_id>? OR (session_id=? AND version>?)) ORDER BY session_id,version LIMIT ?`)
    .all(cursor.sessionId ?? null, cursor.sessionId ?? null, cursor.sessionId ?? null, cursor.version ?? 0, MAX_ROWS)
    .map((raw) => {
      const row = raw as { sessionId: string; version: number; bytes: number }
      return { ...row, key: JSON.stringify([row.sessionId, row.version]) }
    })
}
function getIndexOwnerPage(conn: DatabaseSync, table: SpillReferenceOwnerTable, cursor: Cursor): Array<{ key: string; sessionId?: string; version?: number; bytes: number }> {
  const rows = conn.prepare(`SELECT DISTINCT owner_key AS key FROM spill_reference_index
    WHERE owner_table=? AND (? IS NULL OR owner_key>?) ORDER BY owner_key LIMIT ?`)
    .all(table, cursor.key ?? null, cursor.key ?? null, MAX_ROWS) as Array<{ key: string }>
  if (table === 'agent_history_events') return rows.map(({ key }) => {
    const [invocationId, eventId] = parseSpillHistoryOwnerKey(key)
    return { key, invocationId, eventId, bytes: 0 }
  })
  return rows.map(({ key }) => {
    let value: unknown
    try { value = JSON.parse(key) } catch { throw new Error(`spill-reference-index-owner-key-malformed:${table}:${key}`) }
    if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string' || !Number.isSafeInteger(value[1])) {
      throw new Error(`spill-reference-index-owner-key-malformed:${table}:${key}`)
    }
    return { key, sessionId: value[0], version: value[1] as number, bytes: 0 }
  })
}
function cursorAfter(table: SpillReferenceOwnerTable, owner: { key: string; sessionId?: string; version?: number }): Cursor {
  if (table === 'agent_history_events') {
    const [invocationId, eventId] = parseSpillHistoryOwnerKey(owner.key)
    return { invocationId, eventId }
  }
  return { sessionId: owner.sessionId, version: owner.version }
}
function persistProgress(conn: DatabaseSync, table: SpillReferenceOwnerTable, values: { generation: number; cursor: Cursor; now: number; status?: string; error?: string }): void {
  conn.prepare(`UPDATE spill_reference_backfill_state SET status=?,reconcile_generation=?,reconcile_cursor_json=?,
    error_summary=?,updated_at=? WHERE owner_table=?`)
    .run(values.status ?? 'running', values.generation, JSON.stringify(values.cursor), values.error ?? null, values.now, table)
}
function readRevision(conn: DatabaseSync, table: SpillReferenceOwnerTable, owner: { key: string; sessionId?: string; version?: number }): number | undefined {
  const row = table === 'agent_history_events'
    ? conn.prepare('SELECT spill_reference_revision AS revision FROM agent_history_events WHERE invocation_id=? AND event_id=?').get(...parseSpillHistoryOwnerKey(owner.key)) as { revision: number } | undefined
    : conn.prepare('SELECT spill_reference_revision AS revision FROM session_transcript_entries WHERE session_id=? AND version=?').get(owner.sessionId ?? '', owner.version ?? -1) as { revision: number } | undefined
  return row?.revision
}

async function readPayloadInChunks(conn: DatabaseSync, table: SpillReferenceOwnerTable, owner: { key: string; sessionId?: string; version?: number }, totalBytes: number, revision: number,
  lease: SpillReferenceMaintenanceLease, now: () => number, signal?: AbortSignal): Promise<string> {
  const chunks: Buffer[] = []
  for (let offset = 0; offset < totalBytes; offset += SQLITE_READ_CHUNK_BYTES) {
    if (signal?.aborted) throw new Error('spill-reference-maintenance-paused')
    runInTransaction(conn, () => {
      validateSpillReferenceMaintenanceLease(conn, lease, now())
      renewSpillReferenceMaintenanceLease(conn, lease, now())
    })
    const started = performance.now()
    const row = table === 'agent_history_events'
      ? conn.prepare('SELECT substr(CAST(payload_json AS BLOB),?,?) AS chunk FROM agent_history_events WHERE invocation_id=? AND event_id=?').get(offset + 1, SQLITE_READ_CHUNK_BYTES, ...parseSpillHistoryOwnerKey(owner.key)) as { chunk: Uint8Array } | undefined
      : conn.prepare('SELECT substr(CAST(messages_json AS BLOB),?,?) AS chunk FROM session_transcript_entries WHERE session_id=? AND version=?').get(offset + 1, SQLITE_READ_CHUNK_BYTES, owner.sessionId ?? '', owner.version ?? -1) as { chunk: Uint8Array } | undefined
    if (!row) throw new Error(`canonical-owner-disappeared:${table}:${owner.key}`)
    chunks.push(Buffer.from(row.chunk))
    if (performance.now() - started > 100) throw new Error(`sqlite-read-budget-exceeded:${table}:${owner.key}`)
    if (readRevision(conn, table, owner) !== revision) throw new Error(`canonical-owner-revision-changed:${table}:${owner.key}`)
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8')
}

function compareDescriptorPage(conn: DatabaseSync, table: SpillReferenceOwnerTable, ownerKey: string, revision: number,
  rows: readonly { path: string; descriptor: { locator: string; kind: string } }[]): void {
  const started = performance.now()
  const select = conn.prepare(`SELECT owner_revision,locator,kind,descriptor_json FROM spill_reference_index
    WHERE owner_table=? AND owner_key=? AND descriptor_path=?`)
  for (const reference of rows) {
    const indexed = select.get(table, ownerKey, reference.path) as { owner_revision: string; locator: string; kind: string; descriptor_json: string } | undefined
    if (!indexed || indexed.owner_revision !== String(revision) || indexed.locator !== reference.descriptor.locator ||
      indexed.kind !== reference.descriptor.kind || JSON.stringify(JSON.parse(indexed.descriptor_json)) !== JSON.stringify(reference.descriptor)) {
      throw new Error(`spill-reference-index-mismatch:${table}:${ownerKey}:${reference.path}:indexedRevision=${indexed?.owner_revision ?? 'missing'}:canonicalRevision=${revision}`)
    }
  }
  if (performance.now() - started > 100) throw new Error(`sqlite-compare-budget-exceeded:${table}:${ownerKey}`)
}

export type SpillReferenceReconciliationResult = Readonly<{ status: 'running' | 'complete' | 'paused' | 'failed' | 'idle'; checkedOwners: number; generation?: number; error?: string; restartRequired?: boolean }>

/** One resource-bounded bidirectional reconciliation page. Only a stable full pass can publish complete. */
export async function runSpillReferenceReconciliationBatch(conn: DatabaseSync, input: {
  ownerToken?: string
  now?: () => number
  signal?: AbortSignal
} = {}): Promise<SpillReferenceReconciliationResult> {
  const now = input.now ?? Date.now
  const token = input.ownerToken ?? randomUUID()
  let lease: SpillReferenceMaintenanceLease
  try { lease = claimSpillReferenceMaintenanceLease(conn, token, now()) } catch (error) {
    if (error instanceof Error && error.message === 'spill-reference-maintenance-lease-busy') return { status: 'idle', checkedOwners: 0 }
    throw error
  }
  let checkedOwners = 0
  try {
    if (TABLES.some(({ table }) => !tableExists(conn, table))) throw new Error('canonical-spill-reference-table-missing')
    let generation = getCanonicalSpillChangeGeneration(conn)
    const states = conn.prepare('SELECT owner_table,reconcile_generation,reconcile_cursor_json,status,verified_generation FROM spill_reference_backfill_state')
      .all() as Array<{ owner_table: SpillReferenceOwnerTable; reconcile_generation: number | null; reconcile_cursor_json: string | null; status: string; verified_generation: number | null }>
    if (states.length !== TABLES.length) throw new Error('spill-reference-reconciliation-state-missing')
    if (states.every((state) => state.status === 'complete' && state.verified_generation === generation)) return { status: 'complete', checkedOwners: 0, generation }
    if (states.some((state) => state.reconcile_generation !== generation)) {
      runInTransaction(conn, () => {
        validateSpillReferenceMaintenanceLease(conn, lease, now())
        for (const { table } of TABLES) persistProgress(conn, table, { generation, cursor: {}, now: now() })
      })
    }

    for (const { table } of TABLES) {
      let cursor = getCursor(conn, table)
      if (cursor.done) continue
      const direction = cursor.direction ?? 'canonical'
      const page = direction === 'index' ? getIndexOwnerPage(conn, table, cursor) : getPage(conn, table, cursor)
      let pageBytes = 0
      let processedPageRows = 0
      for (const key of page) {
        if (input.signal?.aborted) {
          runInTransaction(conn, () => {
            validateSpillReferenceMaintenanceLease(conn, lease, now())
            persistProgress(conn, table, { generation, cursor, now: now(), status: 'paused' })
          })
          return { status: 'paused', checkedOwners, generation }
        }
        if (direction === 'index') {
          const exists = table === 'agent_history_events'
            ? conn.prepare('SELECT 1 FROM agent_history_events WHERE invocation_id=? AND event_id=?').get(...parseSpillHistoryOwnerKey(key.key))
            : conn.prepare('SELECT 1 FROM session_transcript_entries WHERE session_id=? AND version=?').get(key.sessionId ?? '', key.version ?? -1)
          if (!exists) throw new Error(`spill-reference-index-extra-owner:${table}:${key.key}`)
          cursor = { direction: 'index', key: key.key }
          processedPageRows += 1
          checkedOwners += 1
          await new Promise<void>((resolve) => setImmediate(resolve))
          continue
        }
        if (key.bytes > MAX_OWNER_BYTES) throw new Error(`owner-payload-over-limit:${table}:${key.key}:${key.bytes}`)
        if (pageBytes > 0 && pageBytes + key.bytes > MAX_BYTES) break
        const revision = readRevision(conn, table, key)
        if (revision === undefined) throw new Error(`canonical-owner-disappeared:${table}:${key.key}`)
        const payload = await readPayloadInChunks(conn, table, key, key.bytes, revision, lease, now, input.signal)
        let actualCount = 0
        const expectedCount = await visitSpillReferencesOffThread(payload, (rows) => {
          if (input.signal?.aborted) throw new Error('spill-reference-maintenance-paused')
          runInTransaction(conn, () => {
            validateSpillReferenceMaintenanceLease(conn, lease, now())
            renewSpillReferenceMaintenanceLease(conn, lease, now())
          })
          compareDescriptorPage(conn, table, key.key, revision, rows)
          actualCount += rows.length
        }, { signal: input.signal })
        if (expectedCount !== actualCount || readRevision(conn, table, key) !== revision) throw new Error(`canonical-owner-revision-changed:${table}:${key.key}`)
        const count = conn.prepare('SELECT count(*) AS count FROM spill_reference_index WHERE owner_table=? AND owner_key=?').get(table, key.key) as { count: number }
        if (count.count !== expectedCount) throw new Error(`spill-reference-index-extra-row:${table}:${key.key}`)
        cursor = cursorAfter(table, key)
        pageBytes += key.bytes
        processedPageRows += 1
        checkedOwners += 1
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      if (page.length === 0 || (page.length < MAX_ROWS && processedPageRows === page.length)) {
        cursor = direction === 'canonical' ? { direction: 'index' } : { direction: 'index', done: true }
      }
      const currentGeneration = getCanonicalSpillChangeGeneration(conn)
      if (currentGeneration !== generation) {
        generation = currentGeneration
        runInTransaction(conn, () => {
          validateSpillReferenceMaintenanceLease(conn, lease, now())
          for (const item of TABLES) persistProgress(conn, item.table, { generation, cursor: {}, now: now() })
        })
        return { status: 'running', checkedOwners, generation, restartRequired: true }
      }
      runInTransaction(conn, () => {
        validateSpillReferenceMaintenanceLease(conn, lease, now())
        persistProgress(conn, table, { generation, cursor, now: now() })
        renewSpillReferenceMaintenanceLease(conn, lease, now())
      })
    }

    generation = getCanonicalSpillChangeGeneration(conn)
    return runInTransaction(conn, () => {
      validateSpillReferenceMaintenanceLease(conn, lease, now())
      if (getCanonicalSpillChangeGeneration(conn) !== generation) {
        for (const { table } of TABLES) persistProgress(conn, table, { generation: getCanonicalSpillChangeGeneration(conn), cursor: {}, now: now() })
        return { status: 'running' as const, checkedOwners, generation: getCanonicalSpillChangeGeneration(conn), restartRequired: true }
      }
      const allDone = TABLES.every(({ table }) => getCursor(conn, table).done === true)
      if (!allDone) return { status: 'running' as const, checkedOwners, generation }
      for (const { table } of TABLES) conn.prepare(`UPDATE spill_reference_backfill_state SET status='complete',verified_generation=?,verified_at=?,updated_at=?,error_summary=NULL
        WHERE owner_table=? AND reconcile_generation=?`).run(generation, now(), now(), table, generation)
      const confirmed = getCanonicalSpillChangeGeneration(conn)
      if (confirmed !== generation) throw new Error('canonical-generation-changed-before-complete')
      return { status: 'complete' as const, checkedOwners, generation }
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown-reconciliation-error'
    if (message.startsWith('canonical-owner-revision-changed:') || message.startsWith('canonical-owner-disappeared:')) {
      const generation = getCanonicalSpillChangeGeneration(conn)
      try {
        runInTransaction(conn, () => {
          validateSpillReferenceMaintenanceLease(conn, lease, now())
          for (const { table } of TABLES) persistProgress(conn, table, { generation, cursor: {}, now: now() })
        })
        return { status: 'running', checkedOwners, generation, restartRequired: true }
      } catch { /* A stale lease cannot publish a restart cursor. */ }
    }
    try {
      const generation = getCanonicalSpillChangeGeneration(conn)
      runInTransaction(conn, () => {
        validateSpillReferenceMaintenanceLease(conn, lease, now())
        for (const { table } of TABLES) persistProgress(conn, table, {
          generation, cursor: getCursor(conn, table), now: now(), status: input.signal?.aborted ? 'paused' : 'failed',
          error: input.signal?.aborted ? undefined : message
        })
      })
    } catch { /* a stale lease cannot publish failure state */ }
    if (input.signal?.aborted) return { status: 'paused', checkedOwners, error: message }
    return { status: 'failed', checkedOwners, error: message }
  } finally {
    conn.prepare(`UPDATE spill_reference_maintenance_lease SET expires_at=0,updated_at=? WHERE lease_name='spill-reference-index' AND owner_token=? AND fencing_token=?`)
      .run(now(), lease.ownerToken, lease.fencingToken)
  }
}
