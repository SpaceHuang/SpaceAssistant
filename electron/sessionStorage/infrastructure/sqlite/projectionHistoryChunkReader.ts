import { Buffer } from 'node:buffer'
import { getDbConnection, openSqliteDatabaseReadOnly, type AppDatabase } from '../../../database/sqliteStore'
import { runInTransaction } from '../../../database/transaction'
import { readProjectionSourceIdentity } from './projectionSourceIdentity'
import { collectSpillDescriptorsStrict, readSourceTruthSpillSync, type SpillDescriptor } from '../../../storage/spillProtocol'
import path from 'node:path'
import type { ProjectionHistoryChunkEvent, ProjectionHistoryChunkPermit, ProjectionHistoryChunkResult, ProjectionMessageFact } from '../../domain/projectionSource'

export type { ProjectionHistoryChunkEvent, ProjectionHistoryChunkPermit, ProjectionHistoryChunkResult, ProjectionMessageFact } from '../../domain/projectionSource'

type ProjectionHistoryEventRow = {
  invocation_id: string; sequence: number; event_id: string; idempotency_key: string; turn_id: string
  schema_version: number; kind: string; payload_json: string; session_seq: number; commit_order: number; created_at: number
}
type ProjectionMessageFactRow = {
  id: string; role: string; timestamp: number; sequence: number; queue_scope: string
  content_storage_state: ProjectionMessageFact['contentStorageState']; write_mode: string | null; content: string
}

const MAX_CHUNK_ROWS = 200
const MAX_CHUNK_BYTES = 256 * 1024

/** Read one bounded History page in a worker-owned, read-only SQLite snapshot. */
export function readProjectionHistoryChunk(
  permit: ProjectionHistoryChunkPermit,
  input: Readonly<{ afterSessionSequence: number; maxRows: number; maxBytes: number }>
): ProjectionHistoryChunkResult {
  if (!Number.isSafeInteger(input.afterSessionSequence) || input.afterSessionSequence < 0 ||
    !Number.isSafeInteger(input.maxRows) || input.maxRows < 1 || input.maxRows > MAX_CHUNK_ROWS ||
    !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > MAX_CHUNK_BYTES ||
    !Number.isSafeInteger(permit.specVersion) || permit.specVersion < 1 ||
    !Number.isSafeInteger(permit.connectionEpoch) || permit.connectionEpoch < 0 ||
    !Number.isSafeInteger(permit.processGeneration) || permit.processGeneration < 0 ||
    !permit.sessionId || !permit.sessionGeneration || !permit.scopeKey || !permit.rebuildToken) {
    return { kind: 'unavailable', permit, afterSessionSequence: input.afterSessionSequence, reason: 'invalid-read-permit-or-budget' }
  }

  let db: AppDatabase | undefined
  try {
    db = openSqliteDatabaseReadOnly(permit.dbPath)
    const conn = getDbConnection(db)
    const snapshotStartedAt = performance.now()
    const result: ProjectionHistoryChunkResult = runInTransaction(conn, () => {
      const sourceIdentityJson = readProjectionSourceIdentity(conn, permit.sessionId, permit.sessionGeneration)
      if (sourceIdentityJson !== permit.sourceIdentityJson) return { kind: 'source-drift', permit, afterSessionSequence: input.afterSessionSequence }
      let source: { historyWatermark?: unknown }
      try { source = JSON.parse(sourceIdentityJson) as typeof source } catch {
        return { kind: 'unavailable', permit, afterSessionSequence: input.afterSessionSequence, reason: 'invalid-source-identity' }
      }
      const watermark = Array.isArray(source.historyWatermark) && Number.isSafeInteger(source.historyWatermark[0])
        ? source.historyWatermark[0] as number : 0
      if (input.afterSessionSequence > watermark) return { kind: 'cursor-invalid', permit, afterSessionSequence: input.afterSessionSequence }

      const events: ProjectionHistoryChunkEvent[] = []
      let byteLength = 0
      let nextSessionSequence = input.afterSessionSequence
      let hasMore = false
      const rows = conn.prepare(`SELECT events.invocation_id,events.sequence,events.event_id,events.idempotency_key,events.turn_id,
        events.schema_version,events.kind,events.payload_json,events.session_seq,events.commit_order,events.created_at
        FROM agent_history_events events JOIN agent_history_streams streams ON streams.invocation_id=events.invocation_id
        WHERE events.session_id=? AND streams.session_id=? AND events.session_seq>?
        ORDER BY events.session_seq ASC,events.commit_order ASC LIMIT ?`).iterate(
          permit.sessionId, permit.sessionId, input.afterSessionSequence, input.maxRows + 1
        ) as Iterable<ProjectionHistoryEventRow>
      for (const row of rows) {
        let payloadJson: string
        try {
          payloadJson = JSON.stringify(hydrateSourceTruthSpills(JSON.parse(row.payload_json), path.join(path.dirname(permit.dbPath), 'spill')))
        } catch (error) {
          return { kind: 'unavailable', permit, afterSessionSequence: input.afterSessionSequence,
            reason: error instanceof Error ? error.message : 'projection-spill-unavailable' }
        }
        const event: ProjectionHistoryChunkEvent = {
          invocationId: row.invocation_id, sequence: row.sequence, eventId: row.event_id,
          idempotencyKey: row.idempotency_key, turnId: row.turn_id, schemaVersion: row.schema_version,
          kind: row.kind, payloadJson, sessionSequence: row.session_seq,
          commitOrder: row.commit_order, createdAt: row.created_at,
        }
        const eventBytes = Buffer.byteLength(JSON.stringify(event), 'utf8')
        if (eventBytes > input.maxBytes && events.length === 0) {
          return { kind: 'deferred-large', permit, afterSessionSequence: input.afterSessionSequence,
            eventSequence: row.session_seq, observedByteLength: eventBytes, observedEventRows: 1 }
        }
        if (events.length >= input.maxRows || byteLength + eventBytes > input.maxBytes) { hasMore = true; break }
        if (row.session_seq !== nextSessionSequence + 1 || row.commit_order < 1) {
          return { kind: 'unavailable', permit, afterSessionSequence: input.afterSessionSequence, reason: 'history-order-invalid' }
        }
        events.push(event)
        byteLength += eventBytes
        nextSessionSequence = row.session_seq
      }
      if (!events.length) return input.afterSessionSequence < watermark
        ? { kind: 'unavailable', permit, afterSessionSequence: input.afterSessionSequence, reason: 'history-order-invalid' }
        : { kind: 'complete', permit, afterSessionSequence: input.afterSessionSequence }
      if (nextSessionSequence < watermark) hasMore = true
      const messageIds = [...new Set(events.flatMap(referencedMessageIds))]
      const messageFacts: ProjectionMessageFact[] = []
      for (let start = 0; start < messageIds.length; start += 400) {
        const ids = messageIds.slice(start, start + 400)
        const rows = conn.prepare(`SELECT messages.id,messages.role,messages.timestamp,messages.sequence,messages.queue_scope,
          messages.content_storage_state,messages.content,cutover.write_mode
          FROM messages LEFT JOIN session_message_content_cutover cutover ON cutover.session_id=messages.session_id
          WHERE messages.session_id=? AND messages.id IN (${ids.map(() => '?').join(',')}) ORDER BY messages.sequence ASC`)
          .all(permit.sessionId, ...ids) as ProjectionMessageFactRow[]
        messageFacts.push(...rows.map((row) => Object.freeze({ id: row.id, role: row.role, timestamp: row.timestamp,
          sequence: row.sequence, queueScope: row.queue_scope, contentStorageState: row.content_storage_state,
          writeMode: row.write_mode, storedContent: row.content })))
      }
      const totalBytes = byteLength + Buffer.byteLength(JSON.stringify(messageFacts), 'utf8')
      if (totalBytes > input.maxBytes) return { kind: 'deferred-large', permit, afterSessionSequence: input.afterSessionSequence,
        eventSequence: events[0]!.sessionSequence, observedByteLength: totalBytes, observedEventRows: events.length }
      return { kind: 'chunk', permit, afterSessionSequence: input.afterSessionSequence,
        nextSessionSequence, events: Object.freeze(events), messageFacts: Object.freeze(messageFacts), byteLength: totalBytes, hasMore }
    })
    return { ...result, snapshotDurationMs: Math.max(0, performance.now() - snapshotStartedAt) }
  } catch (error) {
    return { kind: 'unavailable', permit, afterSessionSequence: input.afterSessionSequence,
      reason: error instanceof Error ? error.message : 'projection-source-read-failed' }
  } finally {
    db?.close()
  }
}

function hydrateSourceTruthSpills(value: unknown, spillRoot: string): unknown {
  if (Array.isArray(value)) return value.map((item) => hydrateSourceTruthSpills(item, spillRoot))
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  if ('__spaceassistant_spill_v1' in record) {
    if (Object.keys(record).length !== 1) throw new Error('projection history spill marker is ambiguous')
    const descriptors = collectSpillDescriptorsStrict(record)
    if (descriptors.length !== 1) throw new Error('projection history spill descriptor is invalid')
    const descriptor = descriptors[0] as SpillDescriptor
    if (descriptor?.kind !== 'source-of-truth') throw new Error('projection history references a non-source spill')
    return readSourceTruthSpillSync(spillRoot, descriptor)
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, hydrateSourceTruthSpills(item, spillRoot)]))
}

function referencedMessageIds(event: ProjectionHistoryChunkEvent): string[] {
  let payload: unknown
  try { payload = JSON.parse(event.payloadJson) } catch { return [] }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return []
  const record = payload as Record<string, unknown>
  const ids: string[] = []
  const add = (value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const id = (value as { id?: unknown }).id
      if (typeof id === 'string' && id.trim()) ids.push(id)
    }
  }
  if (event.kind === 'invocation-context-committed' || event.kind === 'transcript-compacted') {
    if (Array.isArray(record.messages)) record.messages.forEach(add)
    add(record.requiredUserMessage)
  } else if (event.kind === 'replay-message-committed' || event.kind === 'model-response-committed') {
    add(record.message)
  }
  return ids
}
