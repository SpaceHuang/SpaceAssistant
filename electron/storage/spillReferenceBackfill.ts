import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { runInTransaction } from '../database/transaction'
import { spillHistoryOwnerKey, spillTranscriptOwnerKey, type SpillReferenceOwnerTable } from './spillReferenceIndex'
import { visitSpillReferencesOffThread, type SpillReferenceWorkerEntry } from './spillReferenceWorker'

const MAX_BATCH_ROWS = 200
const MAX_BATCH_BYTES = 8 * 1024 * 1024
const MAX_OWNER_BYTES = 64 * 1024 * 1024
const MAX_CHUNK_ROWS = 200
const MAX_CHUNK_BYTES = 512 * 1024
const SQLITE_CHUNK_BUDGET_MS = 100

type Owner = Readonly<{ key: string; invocationId?: string; eventId?: string; sessionId?: string; version?: number; payload: string; bytes: number; revision: string }>
type Cursor = { invocationId?: string; eventId?: string; sessionId?: string; version?: number }
type Dataset = Readonly<{ table: SpillReferenceOwnerTable; payloadColumn: 'payload_json' | 'messages_json' }>
export type SpillReferenceMaintenanceLease = Readonly<{ ownerToken: string; fencingToken: number }>
type Lease = SpillReferenceMaintenanceLease

const DATASETS: readonly Dataset[] = [
  { table: 'agent_history_events', payloadColumn: 'payload_json' },
  { table: 'session_transcript_entries', payloadColumn: 'messages_json' }
]

function nowValue(input: { now?: () => number }): number { return (input.now ?? Date.now)() }

function acquireLease(conn: DatabaseSync, ownerToken: string, now: number): Lease {
  return runInTransaction(conn, () => {
    const old = conn.prepare("SELECT owner_token,fencing_token,expires_at FROM spill_reference_maintenance_lease WHERE lease_name='spill-reference-index'")
      .get() as { owner_token: string; fencing_token: number; expires_at: number } | undefined
    if (old && old.expires_at > now && old.owner_token !== ownerToken) throw new Error('spill-reference-maintenance-lease-busy')
    const fencingToken = (old?.fencing_token ?? 0) + 1
    conn.prepare(`INSERT INTO spill_reference_maintenance_lease(lease_name,owner_token,fencing_token,expires_at,updated_at)
      VALUES('spill-reference-index',?,?,?,?) ON CONFLICT(lease_name) DO UPDATE SET
      owner_token=excluded.owner_token,fencing_token=excluded.fencing_token,expires_at=excluded.expires_at,updated_at=excluded.updated_at`)
      .run(ownerToken, fencingToken, now + 30_000, now)
    conn.prepare('DELETE FROM spill_reference_staging WHERE fencing_token<>?').run(fencingToken)
    return { ownerToken, fencingToken }
  })
}

function assertLease(conn: DatabaseSync, lease: Lease, now: number): void {
  const valid = conn.prepare(`SELECT 1 FROM spill_reference_maintenance_lease WHERE lease_name='spill-reference-index'
    AND owner_token=? AND fencing_token=? AND expires_at>?`).get(lease.ownerToken, lease.fencingToken, now)
  if (!valid) throw new Error('spill-reference-maintenance-lease-lost')
}

function renewLease(conn: DatabaseSync, lease: Lease, now: number): void {
  const result = conn.prepare(`UPDATE spill_reference_maintenance_lease SET expires_at=?,updated_at=?
    WHERE lease_name='spill-reference-index' AND owner_token=? AND fencing_token=? AND expires_at>?`)
    .run(now + 30_000, now, lease.ownerToken, lease.fencingToken, now)
  if (Number(result.changes) !== 1) throw new Error('spill-reference-maintenance-lease-lost')
}

export function claimSpillReferenceMaintenanceLease(conn: DatabaseSync, ownerToken: string, now: number): SpillReferenceMaintenanceLease {
  return acquireLease(conn, ownerToken, now)
}

export function validateSpillReferenceMaintenanceLease(conn: DatabaseSync, lease: SpillReferenceMaintenanceLease, now: number): void {
  assertLease(conn, lease, now)
}

export function renewSpillReferenceMaintenanceLease(conn: DatabaseSync, lease: SpillReferenceMaintenanceLease, now: number): void {
  renewLease(conn, lease, now)
}

function readCursor(conn: DatabaseSync, table: SpillReferenceOwnerTable): Cursor {
  const row = conn.prepare('SELECT cursor_json FROM spill_reference_backfill_state WHERE owner_table=?').get(table) as { cursor_json: string | null } | undefined
  if (!row) throw new Error(`spill-reference-backfill-state-missing:${table}`)
  return row.cursor_json ? JSON.parse(row.cursor_json) as Cursor : {}
}

function selectOwnerKeys(conn: DatabaseSync, dataset: Dataset, cursor: Cursor): Array<{ key: string; invocationId?: string; eventId?: string; sessionId?: string; version?: number; revision: number; bytes: number }> {
  if (dataset.table === 'agent_history_events') {
    return conn.prepare(`SELECT invocation_id AS invocationId,event_id AS eventId,spill_reference_revision AS revision,length(CAST(payload_json AS BLOB)) AS bytes FROM agent_history_events
      WHERE (? IS NULL OR invocation_id>? OR (invocation_id=? AND event_id>?)) ORDER BY invocation_id,event_id LIMIT ?`)
      .all(cursor.invocationId ?? null, cursor.invocationId ?? null, cursor.invocationId ?? null, cursor.eventId ?? '', MAX_BATCH_ROWS)
      .map((raw) => { const row = raw as { invocationId: string; eventId: string; revision: number; bytes: number }; return { ...row, key: spillHistoryOwnerKey(row.invocationId, row.eventId) } })
  }
  return conn.prepare(`SELECT session_id AS sessionId,version,spill_reference_revision AS revision,length(CAST(messages_json AS BLOB)) AS bytes FROM session_transcript_entries
    WHERE (? IS NULL OR session_id>? OR (session_id=? AND version>?)) ORDER BY session_id,version LIMIT ?`)
    .all(cursor.sessionId ?? null, cursor.sessionId ?? null, cursor.sessionId ?? null, cursor.version ?? 0, MAX_BATCH_ROWS)
    .map((row) => {
      const value = row as { sessionId: string; version: number; revision: number; bytes: number }
      return { ...value, key: spillTranscriptOwnerKey(value.sessionId, value.version) }
    })
}

function currentRevision(conn: DatabaseSync, dataset: Dataset, item: { key: string; invocationId?: string; eventId?: string; sessionId?: string; version?: number }): string | undefined {
  const row = dataset.table === 'agent_history_events'
    ? conn.prepare('SELECT spill_reference_revision AS revision FROM agent_history_events WHERE invocation_id=? AND event_id=?').get(item.invocationId ?? '', item.eventId ?? '') as { revision: number } | undefined
    : conn.prepare('SELECT spill_reference_revision AS revision FROM session_transcript_entries WHERE session_id=? AND version=?').get(item.sessionId ?? '', item.version ?? -1) as { revision: number } | undefined
  return row ? String(row.revision) : undefined
}

async function readPayload(conn: DatabaseSync, dataset: Dataset, item: { key: string; invocationId?: string; eventId?: string; sessionId?: string; version?: number }, bytes: number,
  revision: string, signal?: AbortSignal): Promise<string> {
  const chunks: Buffer[] = []
  for (let offset = 0; offset < bytes; offset += MAX_CHUNK_BYTES) {
    if (signal?.aborted) throw new Error('spill-reference-maintenance-paused')
    const started = performance.now()
    const row = dataset.table === 'agent_history_events'
      ? conn.prepare('SELECT substr(CAST(payload_json AS BLOB),?,?) AS chunk FROM agent_history_events WHERE invocation_id=? AND event_id=?').get(offset + 1, MAX_CHUNK_BYTES, item.invocationId ?? '', item.eventId ?? '') as { chunk: Uint8Array } | undefined
      : conn.prepare('SELECT substr(CAST(messages_json AS BLOB),?,?) AS chunk FROM session_transcript_entries WHERE session_id=? AND version=?')
        .get(offset + 1, MAX_CHUNK_BYTES, item.sessionId ?? '', item.version ?? -1) as { chunk: Uint8Array } | undefined
    if (!row) throw new Error('canonical-owner-disappeared')
    chunks.push(Buffer.from(row.chunk))
    if (performance.now() - started > SQLITE_CHUNK_BUDGET_MS) throw new Error('owner-sync-budget-exceeded')
    if (currentRevision(conn, dataset, item) !== revision) throw new Error('canonical-owner-revision-changed')
    await yieldLoop()
  }
  return Buffer.concat(chunks, bytes).toString('utf8')
}

function setState(conn: DatabaseSync, table: SpillReferenceOwnerTable, values: { status: string; cursor?: Cursor; error?: string; scanned?: number; indexed?: number; now: number }): void {
  conn.prepare(`UPDATE spill_reference_backfill_state SET status=?,cursor_json=COALESCE(?,cursor_json),
    error_summary=?,scanned_rows=scanned_rows+?,indexed_rows=indexed_rows+?,updated_at=? WHERE owner_table=?`)
    .run(values.status, values.cursor ? JSON.stringify(values.cursor) : null, values.error ?? null,
      values.scanned ?? 0, values.indexed ?? 0, values.now, table)
}

function writeStageChunk(conn: DatabaseSync, dataset: Dataset, owner: Owner, revision: string, taskToken: string, lease: Lease,
  descriptors: readonly SpillReferenceWorkerEntry[], clock: () => number, signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('spill-reference-maintenance-paused')
  const started = performance.now()
  runInTransaction(conn, () => {
    const now = clock()
    assertLease(conn, lease, now)
    renewLease(conn, lease, now)
    if (currentRevision(conn, dataset, owner) !== revision) throw new Error('canonical-owner-revision-changed')
    const insert = conn.prepare(`INSERT INTO spill_reference_staging(task_token,fencing_token,owner_table,owner_key,owner_revision,
      descriptor_path,locator,kind,descriptor_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    for (const entry of descriptors) insert.run(taskToken, lease.fencingToken, dataset.table, owner.key, revision,
      entry.path, entry.descriptor.locator, entry.descriptor.kind, JSON.stringify(entry.descriptor), now)
  })
  if (performance.now() - started > SQLITE_CHUNK_BUDGET_MS) throw new Error('owner-sync-budget-exceeded')
}

async function stageOwner(conn: DatabaseSync, dataset: Dataset, owner: Owner, taskToken: string, lease: Lease, clock: () => number, signal?: AbortSignal): Promise<number> {
  const revision = owner.revision
  runInTransaction(conn, () => {
    const now = clock()
    assertLease(conn, lease, now)
    if (currentRevision(conn, dataset, owner) !== revision) throw new Error('canonical-owner-revision-changed')
    conn.prepare('DELETE FROM spill_reference_staging WHERE task_token=? AND owner_table=? AND owner_key=?')
      .run(taskToken, dataset.table, owner.key)
  })

  const stagedCount = await visitSpillReferencesOffThread(owner.payload, (rows) => writeStageChunk(conn, dataset, owner, revision, taskToken, lease, rows, clock, signal), { signal })

  const publishStarted = performance.now()
  if (signal?.aborted) throw new Error('spill-reference-maintenance-paused')
  runInTransaction(conn, () => {
    const now = clock()
    assertLease(conn, lease, now)
    renewLease(conn, lease, now)
    if (currentRevision(conn, dataset, owner) !== revision) throw new Error('canonical-owner-revision-changed')
    conn.prepare('DELETE FROM spill_reference_index WHERE owner_table=? AND owner_key=?').run(dataset.table, owner.key)
    conn.prepare(`INSERT INTO spill_reference_index(owner_table,owner_key,descriptor_path,owner_revision,locator,kind,descriptor_json,updated_at)
      SELECT owner_table,owner_key,descriptor_path,owner_revision,locator,kind,descriptor_json,?
      FROM spill_reference_staging WHERE task_token=? AND fencing_token=? AND owner_table=? AND owner_key=? AND owner_revision=?`)
      .run(now, taskToken, lease.fencingToken, dataset.table, owner.key, revision)
    conn.prepare('DELETE FROM spill_reference_staging WHERE task_token=? AND owner_table=? AND owner_key=?').run(taskToken, dataset.table, owner.key)
    if (performance.now() - publishStarted > SQLITE_CHUNK_BUDGET_MS) throw new Error('owner-sync-budget-exceeded')
  })
  return stagedCount
}

function cursorFor(dataset: Dataset, owner: Owner): Cursor {
  return dataset.table === 'agent_history_events' ? { invocationId: owner.invocationId, eventId: owner.eventId } : { sessionId: owner.sessionId, version: owner.version }
}
async function yieldLoop(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)) }

export type SpillReferenceBackfillBatchResult = Readonly<{
  status: 'running' | 'paused' | 'failed' | 'idle'
  processedOwners: number
  indexedDescriptors: number
  error?: string
  retryRequired?: boolean
}>

/** Process one bounded activation. It never changes canonical rows or authorizes file deletion. */
export async function runSpillReferenceBackfillBatch(conn: DatabaseSync, input: {
  ownerToken?: string
  now?: () => number
  signal?: AbortSignal
} = {}): Promise<SpillReferenceBackfillBatchResult> {
  const token = input.ownerToken ?? randomUUID()
  let now = nowValue(input)
  let lease: Lease
  try { lease = acquireLease(conn, token, now) } catch (error) {
    if (error instanceof Error && error.message === 'spill-reference-maintenance-lease-busy') return { status: 'idle', processedOwners: 0, indexedDescriptors: 0 }
    throw error
  }
  let processedOwners = 0
  let indexedDescriptors = 0
  try {
    for (const dataset of DATASETS) {
      let cursor = readCursor(conn, dataset.table)
      const candidates = selectOwnerKeys(conn, dataset, cursor)
      let batchBytes = 0
      for (const key of candidates) {
        if (input.signal?.aborted) {
          setState(conn, dataset.table, { status: 'paused', now: nowValue(input) })
          return { status: 'paused', processedOwners, indexedDescriptors }
        }
        if (key.bytes > MAX_OWNER_BYTES) {
          const error = `owner-payload-over-limit:${dataset.table}:${key.key}:${key.bytes}`
          setState(conn, dataset.table, { status: 'failed', error, now: nowValue(input) })
          return { status: 'failed', processedOwners, indexedDescriptors, error }
        }
        if (batchBytes > 0 && batchBytes + key.bytes > MAX_BATCH_BYTES) break
        const revision = String(key.revision)
        const payload = await readPayload(conn, dataset, key, key.bytes, revision, input.signal)
          const owner: Owner = { ...key, payload, revision }
        const taskToken = randomUUID()
        try {
          const count = await stageOwner(conn, dataset, owner, taskToken, lease, () => nowValue(input), input.signal)
          now = nowValue(input)
          renewLease(conn, lease, now)
          cursor = cursorFor(dataset, owner)
          setState(conn, dataset.table, { status: 'running', cursor, scanned: 1, indexed: count, now })
          processedOwners += 1
          indexedDescriptors += count
          batchBytes += key.bytes
        } catch (error) {
          const message = error instanceof Error ? error.message : 'unknown-backfill-error'
          const canonicalChanged = message === 'canonical-owner-revision-changed' || message === 'canonical-owner-disappeared'
          const paused = input.signal?.aborted === true
          runInTransaction(conn, () => {
            assertLease(conn, lease, nowValue(input))
            conn.prepare('DELETE FROM spill_reference_staging WHERE task_token=?').run(taskToken)
            setState(conn, dataset.table, { status: paused ? 'paused' : canonicalChanged ? 'running' : 'failed',
              error: paused || canonicalChanged ? undefined : `${message}:${dataset.table}:${key.key}`, now: nowValue(input) })
          })
          return { status: paused ? 'paused' : canonicalChanged ? 'running' : 'failed', processedOwners, indexedDescriptors,
            ...(canonicalChanged ? { retryRequired: true } : paused ? {} : { error: message }) }
        }
        await yieldLoop()
      }
    }
    return { status: 'running', processedOwners, indexedDescriptors }
  } finally {
    conn.prepare(`UPDATE spill_reference_maintenance_lease SET expires_at=0,updated_at=?
      WHERE lease_name='spill-reference-index' AND owner_token=? AND fencing_token=?`)
      .run(nowValue(input), lease.ownerToken, lease.fencingToken)
  }
}
