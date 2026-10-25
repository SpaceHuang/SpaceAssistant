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
type ProjectionMessageFactHeaderRow = {
  id: string; role: string; timestamp: number; sequence: number; queue_scope: string
  content_storage_state: ProjectionMessageFact['contentStorageState']; write_mode: string | null; stored_content_byte_length: number
}
type ProjectionMessageFactContentRow = { id: string; content: string }

const MAX_CHUNK_ROWS = 200
const MAX_CHUNK_BYTES = 256 * 1024
const MAX_STAGED_SOURCE_CHUNK_BYTES = 32 * 1024 * 1024

/** Read one bounded History page in a worker-owned, read-only SQLite snapshot. */
export function readProjectionHistoryChunk(
  permit: ProjectionHistoryChunkPermit,
  input: Readonly<{ afterSessionSequence: number; maxRows: number; maxBytes: number; allowOversizedChunk?: boolean }>
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
        if (events.length >= input.maxRows) { hasMore = true; break }
        const storedPayloadBytes = Buffer.byteLength(row.payload_json, 'utf8')
        if (events.length > 0 && byteLength + storedPayloadBytes > input.maxBytes) { hasMore = true; break }
        if (row.session_seq !== nextSessionSequence + 1 || row.commit_order < 1) {
          return { kind: 'unavailable', permit, afterSessionSequence: input.afterSessionSequence, reason: 'history-order-invalid' }
        }
        if (storedPayloadBytes > MAX_STAGED_SOURCE_CHUNK_BYTES) {
          return { kind: 'deferred-large', permit, afterSessionSequence: input.afterSessionSequence,
            eventSequence: row.session_seq, observedByteLength: storedPayloadBytes, observedEventRows: 1,
            reason: 'oversized-event-exceeds-staging-budget' }
        }
        if (storedPayloadBytes > input.maxBytes && !input.allowOversizedChunk) {
          return { kind: 'deferred-large', permit, afterSessionSequence: input.afterSessionSequence,
            eventSequence: row.session_seq, observedByteLength: storedPayloadBytes, observedEventRows: 1 }
        }
        let parsedPayload: unknown
        try { parsedPayload = JSON.parse(row.payload_json) }
        catch {
          return { kind: 'unavailable', permit, afterSessionSequence: input.afterSessionSequence, reason: 'projection-history-payload-invalid' }
        }
        const spillDescriptors = collectSpillDescriptorsStrict(parsedPayload)
        const expandedPayloadBytes = storedPayloadBytes + spillDescriptors.reduce((total, descriptor) => total + descriptor.byteLength * 6, 0)
        if (events.length > 0 && byteLength + expandedPayloadBytes > input.maxBytes) { hasMore = true; break }
        if (expandedPayloadBytes > MAX_STAGED_SOURCE_CHUNK_BYTES) {
          return { kind: 'deferred-large', permit, afterSessionSequence: input.afterSessionSequence,
            eventSequence: row.session_seq, observedByteLength: expandedPayloadBytes, observedEventRows: 1,
            reason: 'oversized-event-exceeds-staging-budget' }
        }
        if (expandedPayloadBytes > input.maxBytes && !input.allowOversizedChunk) {
          return { kind: 'deferred-large', permit, afterSessionSequence: input.afterSessionSequence,
            eventSequence: row.session_seq, observedByteLength: expandedPayloadBytes, observedEventRows: 1 }
        }
        let payloadJson: string
        try {
          payloadJson = JSON.stringify(hydrateSourceTruthSpills(parsedPayload, path.join(path.dirname(permit.dbPath), 'spill')))
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
        if (eventBytes > input.maxBytes && events.length === 0 && !input.allowOversizedChunk) {
          return { kind: 'deferred-large', permit, afterSessionSequence: input.afterSessionSequence,
            eventSequence: row.session_seq, observedByteLength: eventBytes, observedEventRows: 1 }
        }
        if (eventBytes > MAX_STAGED_SOURCE_CHUNK_BYTES && events.length === 0) {
          return { kind: 'deferred-large', permit, afterSessionSequence: input.afterSessionSequence,
            eventSequence: row.session_seq, observedByteLength: eventBytes, observedEventRows: 1,
            reason: 'oversized-event-exceeds-staging-budget' }
        }
        if (events.length >= input.maxRows || (events.length > 0 && byteLength + eventBytes > input.maxBytes)) { hasMore = true; break }
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
          messages.content_storage_state,length(CAST(messages.content AS BLOB)) AS stored_content_byte_length,cutover.write_mode
          FROM messages LEFT JOIN session_message_content_cutover cutover ON cutover.session_id=messages.session_id
          WHERE messages.session_id=? AND messages.id IN (${ids.map(() => '?').join(',')}) ORDER BY messages.sequence ASC`)
          .all(permit.sessionId, ...ids) as ProjectionMessageFactHeaderRow[]
        const headers = rows.map((row) => Object.freeze({ id: row.id, role: row.role, timestamp: row.timestamp,
          sequence: row.sequence, queueScope: row.queue_scope, contentStorageState: row.content_storage_state,
          writeMode: row.write_mode, storedContent: '' }))
        const metadataBytes = Buffer.byteLength(JSON.stringify(headers), 'utf8')
        const storedContentBytes = rows.reduce((total, row) => total + Number(row.stored_content_byte_length), 0)
        // Six bytes per source byte is a conservative upper bound for JSON string escaping.
        const expandedFactsBytes = metadataBytes + storedContentBytes * 6
        const estimatedChunkBytes = byteLength + expandedFactsBytes
        if (estimatedChunkBytes > MAX_STAGED_SOURCE_CHUNK_BYTES) return { kind: 'deferred-large', permit,
          afterSessionSequence: input.afterSessionSequence, eventSequence: events[0]!.sessionSequence,
          observedByteLength: estimatedChunkBytes, observedEventRows: events.length,
          reason: 'oversized-source-chunk-exceeds-staging-budget' }
        if (estimatedChunkBytes > input.maxBytes && !input.allowOversizedChunk) return { kind: 'deferred-large', permit,
          afterSessionSequence: input.afterSessionSequence, eventSequence: events[0]!.sessionSequence,
          observedByteLength: estimatedChunkBytes, observedEventRows: events.length }
        const contentRows = conn.prepare(`SELECT id,content FROM messages WHERE session_id=? AND id IN (${ids.map(() => '?').join(',')})`)
          .all(permit.sessionId, ...ids) as ProjectionMessageFactContentRow[]
        const storedContentById = new Map(contentRows.map(({ id, content }) => [id, content]))
        messageFacts.push(...rows.map((row, index) => Object.freeze({ ...headers[index]!,
          storedContent: storedContentById.get(row.id) ?? '' })))
      }
      const totalBytes = byteLength + Buffer.byteLength(JSON.stringify(messageFacts), 'utf8')
      if (totalBytes > input.maxBytes && !input.allowOversizedChunk) return { kind: 'deferred-large', permit, afterSessionSequence: input.afterSessionSequence,
        eventSequence: events[0]!.sessionSequence, observedByteLength: totalBytes, observedEventRows: events.length }
      if (totalBytes > MAX_STAGED_SOURCE_CHUNK_BYTES) return { kind: 'deferred-large', permit, afterSessionSequence: input.afterSessionSequence,
        eventSequence: events[0]!.sessionSequence, observedByteLength: totalBytes, observedEventRows: events.length,
        reason: 'oversized-source-chunk-exceeds-staging-budget' }
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
