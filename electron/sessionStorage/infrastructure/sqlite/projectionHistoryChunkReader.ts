import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { getDbConnection, openSqliteDatabaseReadOnly, type AppDatabase } from '../../../database/sqliteStore'
import { runInTransaction } from '../../../database/transaction'
import { readProjectionSourceIdentity } from './projectionSourceIdentity'
import { collectSpillDescriptorsStrict, readSourceTruthSpillSync, type SpillDescriptor } from '../../../storage/spillProtocol'
import path from 'node:path'
import type { ProjectionHistoryChunkEvent, ProjectionHistoryChunkPermit, ProjectionHistoryChunkResult, ProjectionMessageFact } from '../../domain/projectionSource'

export type { ProjectionHistoryChunkEvent, ProjectionHistoryChunkPermit, ProjectionHistoryChunkResult, ProjectionMessageFact } from '../../domain/projectionSource'

type ProjectionHistoryChunkReadInput = Readonly<{ afterSessionSequence: number; maxRows: number; maxBytes: number; allowOversizedChunk?: boolean;
  staging?: Readonly<{ root: string; tempLocator: string; tempLocators?: readonly string[] }> }>

type ProjectionHistoryEventRow = {
  invocation_id: string; sequence: number; event_id: string; idempotency_key: string; turn_id: string
  schema_version: number; kind: string; payload_byte_length: number; session_seq: number; commit_order: number; created_at: number
}
type ProjectionMessageFactHeaderRow = {
  id: string; role: string; timestamp: number; sequence: number; queue_scope: string
  content_storage_state: ProjectionMessageFact['contentStorageState']; write_mode: string | null; stored_content_byte_length: number
}
type ProjectionMessageFactContentRow = { id: string; content: string }
type LargeContextEventCapture = Readonly<{
  messageCount: number
  requiredUserByteLength: number | null
  requiredUserMessageRef?: Readonly<{ id: string; messageIndex: number }>
  requiredUserJson?: string
  extraPayloadJson: string
}>
type LargeContextStageRequest = Readonly<{ kind: 'stage-large-context-event'; row: ProjectionHistoryEventRow; watermark: number }>
type RawHistoryRead = Readonly<{ kind: 'raw-history-read'; rows: readonly Readonly<{ row: ProjectionHistoryEventRow; payloadJson: string }>[];
  watermark: number; nextSessionSequence: number; hasMore: boolean }>

const MAX_CHUNK_ROWS = 200
const MAX_CHUNK_BYTES = 256 * 1024
const MAX_STAGED_SOURCE_CHUNK_BYTES = 32 * 1024 * 1024
const MAX_SEGMENTED_HISTORY_EVENT_BYTES = 128 * 1024 * 1024
const MAX_HISTORY_EVENT_SEGMENT_BYTES = 16 * 1024 * 1024
const MAX_HISTORY_EVENT_SEGMENTS = 15

/** Read one bounded History page in a worker-owned, read-only SQLite snapshot. */
export function readProjectionHistoryChunk(
  permit: ProjectionHistoryChunkPermit,
  input: ProjectionHistoryChunkReadInput
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
    const finalizeStaging: Array<() => void> = []
    let result!: ProjectionHistoryChunkResult | LargeContextStageRequest | RawHistoryRead
    try {
      result = runInTransaction(conn, () => {
      const sourceIdentityJson = readProjectionSourceIdentity(conn, permit.sessionId, permit.sessionGeneration)
      if (sourceIdentityJson !== permit.sourceIdentityJson) return { kind: 'source-drift', permit, afterSessionSequence: input.afterSessionSequence }
      let source: { historyWatermark?: unknown }
      try { source = JSON.parse(sourceIdentityJson) as typeof source } catch {
        return { kind: 'unavailable', permit, afterSessionSequence: input.afterSessionSequence, reason: 'invalid-source-identity' }
      }
      const watermark = Array.isArray(source.historyWatermark) && Number.isSafeInteger(source.historyWatermark[0])
        ? source.historyWatermark[0] as number : 0
      if (input.afterSessionSequence > watermark) return { kind: 'cursor-invalid', permit, afterSessionSequence: input.afterSessionSequence }

      const rawEvents: Array<{ row: ProjectionHistoryEventRow; payloadJson: string }> = []
      let byteLength = 0
      let nextSessionSequence = input.afterSessionSequence
      let hasMore = false
      const rows = conn.prepare(`SELECT events.invocation_id,events.sequence,events.event_id,events.idempotency_key,events.turn_id,
        events.schema_version,events.kind,length(CAST(events.payload_json AS BLOB)) AS payload_byte_length,
        events.session_seq,events.commit_order,events.created_at
        FROM agent_history_events events JOIN agent_history_streams streams ON streams.invocation_id=events.invocation_id
        WHERE events.session_id=? AND streams.session_id=? AND events.session_seq>?
        ORDER BY events.session_seq ASC,events.commit_order ASC LIMIT ?`).iterate(
          permit.sessionId, permit.sessionId, input.afterSessionSequence, input.maxRows + 1
        ) as Iterable<ProjectionHistoryEventRow>
      for (const row of rows) {
        if (rawEvents.length >= input.maxRows) { hasMore = true; break }
        const storedPayloadBytes = Number(row.payload_byte_length)
        if (rawEvents.length > 0 && byteLength + storedPayloadBytes > input.maxBytes) { hasMore = true; break }
        if (row.session_seq !== nextSessionSequence + 1 || row.commit_order < 1) {
          return { kind: 'unavailable', permit, afterSessionSequence: input.afterSessionSequence, reason: 'history-order-invalid' }
        }
        if (input.staging && rawEvents.length === 0 &&
          (row.kind === 'invocation-context-committed' || row.kind === 'transcript-compacted')) {
          const largeContext = conn.prepare(`SELECT json_type(payload_json,'$.messages') AS messages_type,
            json_array_length(payload_json,'$.messages') AS message_count,
            (SELECT COALESCE(SUM(CAST(json_extract(item.value,'$.__spaceassistant_spill_v1.byteLength') AS INTEGER)),0)
              FROM json_each(agent_history_events.payload_json,'$.messages') item) AS spill_bytes
            FROM agent_history_events WHERE event_id=? AND session_id=?`).get(row.event_id, permit.sessionId) as
            { messages_type: string | null; message_count: number | null; spill_bytes: number | null } | undefined
          const expandedBound = storedPayloadBytes + Number(largeContext?.spill_bytes ?? 0) * 6
          if (largeContext?.messages_type === 'array' && Number.isSafeInteger(largeContext.message_count) &&
            (largeContext.message_count ?? 0) > 0 && expandedBound > input.maxBytes &&
            expandedBound <= MAX_SEGMENTED_HISTORY_EVENT_BYTES) return { kind: 'stage-large-context-event', row, watermark }
        }
        if (storedPayloadBytes > MAX_STAGED_SOURCE_CHUNK_BYTES) {
          if (input.staging && (row.kind === 'invocation-context-committed' || row.kind === 'transcript-compacted') && rawEvents.length === 0 &&
            storedPayloadBytes <= MAX_SEGMENTED_HISTORY_EVENT_BYTES) {
            return { kind: 'stage-large-context-event', row, watermark }
          }
          return { kind: 'deferred-large', permit, afterSessionSequence: input.afterSessionSequence,
            eventSequence: row.session_seq, observedByteLength: storedPayloadBytes, observedEventRows: 1,
            reason: 'oversized-event-exceeds-staging-budget' }
        }
        if (storedPayloadBytes > input.maxBytes && !input.allowOversizedChunk) return { kind: 'deferred-large', permit,
          afterSessionSequence: input.afterSessionSequence, eventSequence: row.session_seq,
          observedByteLength: storedPayloadBytes, observedEventRows: 1 }
        const storedPayload = conn.prepare('SELECT payload_json FROM agent_history_events WHERE event_id=? AND session_id=?')
          .get(row.event_id, permit.sessionId) as { payload_json: string } | undefined
        if (!storedPayload || Buffer.byteLength(storedPayload.payload_json, 'utf8') !== storedPayloadBytes) return {
          kind: 'unavailable', permit, afterSessionSequence: input.afterSessionSequence, reason: 'projection-history-payload-changed' }
        rawEvents.push({ row, payloadJson: storedPayload.payload_json })
        byteLength += storedPayloadBytes
        nextSessionSequence = row.session_seq
      }
      if (!rawEvents.length) return input.afterSessionSequence < watermark
        ? { kind: 'unavailable', permit, afterSessionSequence: input.afterSessionSequence, reason: 'history-order-invalid' }
        : { kind: 'complete', permit, afterSessionSequence: input.afterSessionSequence }
      if (nextSessionSequence < watermark) hasMore = true
      return { kind: 'raw-history-read', rows: Object.freeze(rawEvents.map((item) => Object.freeze(item))), watermark,
        nextSessionSequence, hasMore }
      })
      if (result.kind === 'raw-history-read') {
        const captured = result
        const events: ProjectionHistoryChunkEvent[] = []
        let eventBytes = 0
        for (const item of captured.rows) {
          let parsed: unknown
          try { parsed = JSON.parse(item.payloadJson) } catch {
            result = { kind: 'unavailable', permit, afterSessionSequence: input.afterSessionSequence,
              reason: 'projection-history-payload-invalid' }; break
          }
          try {
            const spillDescriptors = collectSpillDescriptorsStrict(parsed)
            const expanded = Buffer.byteLength(item.payloadJson, 'utf8') + spillDescriptors.reduce((sum, d) => sum + d.byteLength * 6, 0)
            if (expanded > MAX_STAGED_SOURCE_CHUNK_BYTES) {
              if (input.staging && events.length === 0 &&
                (item.row.kind === 'invocation-context-committed' || item.row.kind === 'transcript-compacted') &&
                expanded <= MAX_SEGMENTED_HISTORY_EVENT_BYTES) {
                result = { kind: 'stage-large-context-event', row: item.row, watermark: captured.watermark }
                break
              }
              result = { kind: 'deferred-large', permit, afterSessionSequence: input.afterSessionSequence,
                eventSequence: item.row.session_seq, observedByteLength: expanded, observedEventRows: 1,
                reason: 'oversized-event-exceeds-staging-budget' }; break
            }
            const payloadJson = JSON.stringify(hydrateSourceTruthSpills(parsed, path.join(path.dirname(permit.dbPath), 'spill')))
            const event: ProjectionHistoryChunkEvent = { invocationId: item.row.invocation_id, sequence: item.row.sequence,
              eventId: item.row.event_id, idempotencyKey: item.row.idempotency_key, turnId: item.row.turn_id,
              schemaVersion: item.row.schema_version, kind: item.row.kind, payloadJson, sessionSequence: item.row.session_seq,
              commitOrder: item.row.commit_order, createdAt: item.row.created_at }
            const size = Buffer.byteLength(JSON.stringify(event), 'utf8')
            if (size > input.maxBytes && !input.allowOversizedChunk) {
              result = { kind: 'deferred-large', permit, afterSessionSequence: input.afterSessionSequence,
                eventSequence: item.row.session_seq, observedByteLength: size, observedEventRows: 1 }; break
            }
            if (size > MAX_STAGED_SOURCE_CHUNK_BYTES) {
              result = { kind: 'deferred-large', permit, afterSessionSequence: input.afterSessionSequence,
                eventSequence: item.row.session_seq, observedByteLength: size, observedEventRows: 1,
                reason: 'oversized-event-exceeds-staging-budget' }; break
            }
            events.push(event); eventBytes += size
          } catch (error) {
            result = { kind: 'unavailable', permit, afterSessionSequence: input.afterSessionSequence,
              reason: error instanceof Error ? error.message : 'projection-spill-unavailable' }; break
          }
        }
        if (result.kind === 'raw-history-read') {
          const ids = [...new Set(events.flatMap(referencedMessageIds))]
          const factsSnapshot = runInTransaction(conn, () => {
            if (readProjectionSourceIdentity(conn, permit.sessionId, permit.sessionGeneration) !== permit.sourceIdentityJson) return 'source-drift' as const
            const headers: ProjectionMessageFactHeaderRow[] = []
            for (let start = 0; start < ids.length; start += 400) {
              const batch = ids.slice(start, start + 400), marks = batch.map(() => '?').join(',')
              headers.push(...conn.prepare(`SELECT messages.id,messages.role,messages.timestamp,messages.sequence,messages.queue_scope,
                messages.content_storage_state,length(CAST(messages.content AS BLOB)) AS stored_content_byte_length,cutover.write_mode
                FROM messages LEFT JOIN session_message_content_cutover cutover ON cutover.session_id=messages.session_id
                WHERE messages.session_id=? AND messages.id IN (${marks}) ORDER BY messages.sequence ASC`)
                .all(permit.sessionId, ...batch) as ProjectionMessageFactHeaderRow[])
            }
            const metadata = headers.map((row) => ({ id: row.id, role: row.role, timestamp: row.timestamp,
              sequence: row.sequence, queueScope: row.queue_scope, contentStorageState: row.content_storage_state,
              writeMode: row.write_mode, storedContent: '' }))
            const estimatedBytes = eventBytes + Buffer.byteLength(JSON.stringify(metadata), 'utf8') +
              headers.reduce((sum, row) => sum + Number(row.stored_content_byte_length) * 6, 0)
            if (estimatedBytes > MAX_STAGED_SOURCE_CHUNK_BYTES || (estimatedBytes > input.maxBytes && !input.allowOversizedChunk)) {
              return { kind: 'too-large' as const, headers, estimatedBytes }
            }
            const contents: ProjectionMessageFactContentRow[] = []
            for (let start = 0; start < ids.length; start += 400) {
              const batch = ids.slice(start, start + 400), marks = batch.map(() => '?').join(',')
              contents.push(...conn.prepare(`SELECT id,content FROM messages WHERE session_id=? AND id IN (${marks})`)
                .all(permit.sessionId, ...batch) as ProjectionMessageFactContentRow[])
            }
            return { kind: 'facts' as const, headers, contents, estimatedBytes }
          })
          if (factsSnapshot === 'source-drift') result = { kind: 'source-drift', permit, afterSessionSequence: input.afterSessionSequence }
          else if (factsSnapshot.kind === 'too-large') result = { kind: 'deferred-large', permit,
            afterSessionSequence: input.afterSessionSequence, eventSequence: events[0]!.sessionSequence,
            observedByteLength: factsSnapshot.estimatedBytes, observedEventRows: events.length,
            ...(factsSnapshot.estimatedBytes > MAX_STAGED_SOURCE_CHUNK_BYTES ? { reason: 'oversized-source-chunk-exceeds-staging-budget' } : {}) }
          else {
            const contentById = new Map(factsSnapshot.contents.map(({ id, content }) => [id, content]))
            const messageFacts = factsSnapshot.headers.map((row) => Object.freeze({ id: row.id, role: row.role,
              timestamp: row.timestamp, sequence: row.sequence, queueScope: row.queue_scope,
              contentStorageState: row.content_storage_state, writeMode: row.write_mode, storedContent: contentById.get(row.id) ?? '' }))
            const totalBytes = eventBytes + Buffer.byteLength(JSON.stringify(messageFacts), 'utf8')
            if (totalBytes > MAX_STAGED_SOURCE_CHUNK_BYTES || (totalBytes > input.maxBytes && !input.allowOversizedChunk)) {
              result = { kind: 'deferred-large', permit, afterSessionSequence: input.afterSessionSequence,
                eventSequence: events[0]!.sessionSequence, observedByteLength: totalBytes, observedEventRows: events.length,
                ...(totalBytes > MAX_STAGED_SOURCE_CHUNK_BYTES ? { reason: 'oversized-source-chunk-exceeds-staging-budget' } : {}) }
            } else result = { kind: 'chunk', permit, afterSessionSequence: input.afterSessionSequence,
              nextSessionSequence: captured.nextSessionSequence, events: Object.freeze(events), messageFacts: Object.freeze(messageFacts),
              byteLength: totalBytes, hasMore: captured.hasMore }
          }
        }
      }
      if (result.kind === 'stage-large-context-event') {
        const stagedRequest = result
        const capture = runInTransaction(conn, () => readLargeContextEventCapture(conn, permit, stagedRequest.row))
        if (capture === 'source-drift') result = { kind: 'source-drift', permit, afterSessionSequence: input.afterSessionSequence }
        else if (capture) {
          result = stageOversizedContextEvent(conn, permit, input, (finalize) => finalizeStaging.push(finalize),
            stagedRequest.row, stagedRequest.watermark, capture) ?? {
              kind: 'deferred-large', permit, afterSessionSequence: input.afterSessionSequence,
              eventSequence: stagedRequest.row.session_seq, observedByteLength: stagedRequest.row.payload_byte_length,
              observedEventRows: 1, reason: 'oversized-event-exceeds-staging-budget'
            }
        } else result = { kind: 'deferred-large', permit, afterSessionSequence: input.afterSessionSequence,
          eventSequence: stagedRequest.row.session_seq, observedByteLength: stagedRequest.row.payload_byte_length,
          observedEventRows: 1, reason: 'oversized-event-exceeds-staging-budget' }
      }
    } finally {
      for (const finalize of finalizeStaging) finalize()
    }
    return { ...result, snapshotDurationMs: Math.max(0, performance.now() - snapshotStartedAt) }
  } catch (error) {
    return { kind: 'unavailable', permit, afterSessionSequence: input.afterSessionSequence,
      reason: error instanceof Error ? error.message : 'projection-source-read-failed' }
  } finally {
    db?.close()
  }
}

type SegmentedEventPart = Readonly<{ kind: 'messages' | 'facts' | 'required-user'; tempLocator: string; locator: string; byteLength: number;
  payloadDigest: string; itemCount: number; encoding?: 'json-item-fragment'; firstItemIndex?: number;
  fragmentIndex?: number; fragmentCount?: number }>

/** Copy raw JSON item strings and event metadata inside a short, read-only source snapshot. */
function readLargeContextEventCapture(
  conn: ReturnType<typeof getDbConnection>, permit: ProjectionHistoryChunkPermit, row: ProjectionHistoryEventRow
): LargeContextEventCapture | 'source-drift' | undefined {
  if (readProjectionSourceIdentity(conn, permit.sessionId, permit.sessionGeneration) !== permit.sourceIdentityJson) return 'source-drift'
  if (!Number.isSafeInteger(row.payload_byte_length) || row.payload_byte_length > MAX_SEGMENTED_HISTORY_EVENT_BYTES) return undefined
  const shape = conn.prepare(`SELECT json_type(payload_json,'$.messages') AS messages_type,
    json_array_length(payload_json,'$.messages') AS message_count,
    (SELECT COALESCE(SUM(length(CAST(item.value AS BLOB))),0) FROM json_each(agent_history_events.payload_json,'$.messages') item) AS message_json_byte_length,
    length(CAST(json_extract(payload_json,'$.requiredUserMessage') AS BLOB)) AS required_user_byte_length,
    json_extract(payload_json,'$.requiredUserMessage.id') AS required_user_id,
    json_remove(payload_json,'$.messages','$.requiredUserMessage') AS extra_payload_json
    FROM agent_history_events WHERE event_id=? AND session_id=?`).get(row.event_id, permit.sessionId) as
    { messages_type: string | null; message_count: number | null; required_user_byte_length: number | null;
      required_user_id: string | null; message_json_byte_length: number; extra_payload_json: string } | undefined
  if (shape?.messages_type !== 'array' || !Number.isSafeInteger(shape.message_count) || (shape.message_count ?? 0) < 1 ||
    Buffer.byteLength(shape.extra_payload_json, 'utf8') > MAX_STAGED_SOURCE_CHUNK_BYTES || (shape.required_user_byte_length !== null &&
      shape.required_user_byte_length > MAX_SEGMENTED_HISTORY_EVENT_BYTES)) return undefined
  if (!Number.isSafeInteger(shape.message_json_byte_length) || shape.message_json_byte_length > MAX_SEGMENTED_HISTORY_EVENT_BYTES) return undefined
  let requiredUserJson: string | undefined
  let requiredUserMessageRef: Readonly<{ id: string; messageIndex: number }> | undefined
  if (shape.required_user_byte_length !== null) {
    if (typeof shape.required_user_id === 'string' && shape.required_user_id.trim()) {
      const matchingMessage = conn.prepare(`SELECT CAST(item.key AS INTEGER) AS message_index
        FROM agent_history_events event,json_each(event.payload_json,'$.messages') item
        WHERE event.event_id=? AND event.session_id=? AND json_extract(item.value,'$.id')=?
        ORDER BY CAST(item.key AS INTEGER) LIMIT 1`).get(row.event_id, permit.sessionId, shape.required_user_id) as
        { message_index: number } | undefined
      if (matchingMessage && Number.isSafeInteger(matchingMessage.message_index) &&
        matchingMessage.message_index >= 0 && matchingMessage.message_index < shape.message_count!) {
        // Canonical History validates requiredUserMessage against this context message at write time.
        // Reference the already staged item by ID so a large body is not hydrated and serialized twice.
        requiredUserMessageRef = Object.freeze({ id: shape.required_user_id, messageIndex: matchingMessage.message_index })
      }
    }
    if (!requiredUserMessageRef) {
      const required = conn.prepare(`SELECT json_extract(payload_json,'$.requiredUserMessage') AS required_user_json
        FROM agent_history_events WHERE event_id=? AND session_id=?`).get(row.event_id, permit.sessionId) as
        { required_user_json: string | null } | undefined
      if (typeof required?.required_user_json !== 'string') return undefined
      requiredUserJson = required.required_user_json
    }
  }
  return Object.freeze({ messageCount: shape.message_count!, requiredUserByteLength: shape.required_user_byte_length,
    extraPayloadJson: shape.extra_payload_json,
    ...(requiredUserMessageRef ? { requiredUserMessageRef } : {}),
    ...(requiredUserJson !== undefined ? { requiredUserJson } : {}) })
}

function isCurrentLargeEvent(conn: ReturnType<typeof getDbConnection>, permit: ProjectionHistoryChunkPermit,
  row: ProjectionHistoryEventRow): boolean {
  const current = conn.prepare(`SELECT invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,
    length(CAST(payload_json AS BLOB)) AS payload_byte_length,session_seq,commit_order,created_at
    FROM agent_history_events WHERE event_id=? AND session_id=?`).get(row.event_id, permit.sessionId) as ProjectionHistoryEventRow | undefined
  return !!current && current.invocation_id === row.invocation_id && current.sequence === row.sequence &&
    current.event_id === row.event_id && current.idempotency_key === row.idempotency_key && current.turn_id === row.turn_id &&
    current.schema_version === row.schema_version && current.kind === row.kind && current.payload_byte_length === row.payload_byte_length &&
    current.session_seq === row.session_seq && current.commit_order === row.commit_order && current.created_at === row.created_at
}

/** Stage a large canonical context event as bounded message/fact arrays without materializing its JSON array. */
function stageOversizedContextEvent(
  conn: ReturnType<typeof getDbConnection>, permit: ProjectionHistoryChunkPermit,
  input: ProjectionHistoryChunkReadInput, registerFinalizer: (finalize: () => void) => void,
  row: ProjectionHistoryEventRow, watermark: number, capture: LargeContextEventCapture
): ProjectionHistoryChunkResult | undefined {
  const staging = input.staging
  if (!staging || row.payload_byte_length > MAX_SEGMENTED_HISTORY_EVENT_BYTES || !Number.isSafeInteger(row.payload_byte_length)) return undefined

  const tempLocators = [staging.tempLocator, ...(staging.tempLocators ?? [])]
  if (tempLocators.length < 2 || tempLocators.length > MAX_HISTORY_EVENT_SEGMENTS + 1 ||
    new Set(tempLocators).size !== tempLocators.length || tempLocators.some((locator) =>
      !/^\.projection-[0-9a-f-]{36}\.tmp$/.test(locator) || path.basename(locator) !== locator)) return undefined
  const availableLocators = tempLocators.slice(1)
  const writtenSegments: SegmentedEventPart[] = []
  const openedFiles = new Set<string>()
  let current: { kind: 'messages' | 'facts'; locator: string; tempLocator: string; fd: number; hash: ReturnType<typeof createHash>;
    byteLength: number; itemCount: number; firstItemIndex: number } | undefined
  const itemCounts: Record<'messages' | 'facts', number> = { messages: 0, facts: 0 }
  const openStagedFile = (tempLocator: string): number => {
    const fd = fs.openSync(path.join(staging!.root, tempLocator), 'wx', 0o600)
    openedFiles.add(tempLocator)
    return fd
  }
  const writeStagedFile = (fd: number, bytes: Buffer) => {
    let offset = 0
    while (offset < bytes.byteLength) offset += fs.writeSync(fd, bytes, offset, bytes.byteLength - offset)
  }
  const closeCurrent = () => {
    if (!current) return
    const closing = Buffer.from(']')
    writeStagedFile(current.fd, closing)
    current.hash.update(closing)
    current.byteLength += 1
    fs.fsyncSync(current.fd)
    fs.closeSync(current.fd)
    writtenSegments.push({ kind: current.kind, tempLocator: current.tempLocator, locator: current.locator, byteLength: current.byteLength,
      payloadDigest: current.hash.digest('hex'), itemCount: current.itemCount, firstItemIndex: current.firstItemIndex })
    current = undefined
  }
  const beginCurrent = (kind: 'messages' | 'facts') => {
    const tempLocator = availableLocators.shift()
    if (!tempLocator) throw new Error('PROJECTION_HISTORY_SEGMENT_LIMIT_EXCEEDED')
    const locator = tempLocator.slice(1, -4) + '.blob'
    const hash = createHash('sha256')
    const opening = Buffer.from('[')
    hash.update(opening)
    const fd = openStagedFile(tempLocator)
    writeStagedFile(fd, opening)
    current = { kind, locator, tempLocator, fd, hash, byteLength: opening.byteLength, itemCount: 0, firstItemIndex: itemCounts[kind] }
  }
  const appendFragmentedItem = (bytes: Buffer, kind: SegmentedEventPart['kind'], itemIndex: number): boolean => {
    if (bytes.byteLength > MAX_SEGMENTED_HISTORY_EVENT_BYTES) return false
    const fragmentCount = Math.ceil(bytes.byteLength / MAX_HISTORY_EVENT_SEGMENT_BYTES)
    if (fragmentCount > availableLocators.length) return false
    for (let fragmentIndex = 0; fragmentIndex < fragmentCount; fragmentIndex += 1) {
      const tempLocator = availableLocators.shift()
      if (!tempLocator) return false
      const locator = tempLocator.slice(1, -4) + '.blob'
      const start = fragmentIndex * MAX_HISTORY_EVENT_SEGMENT_BYTES
      const fragment = bytes.subarray(start, Math.min(bytes.byteLength, start + MAX_HISTORY_EVENT_SEGMENT_BYTES))
      const fd = openStagedFile(tempLocator)
      writeStagedFile(fd, fragment)
      fs.fsyncSync(fd)
      fs.closeSync(fd)
      writtenSegments.push({ kind, encoding: 'json-item-fragment', tempLocator, locator,
        byteLength: fragment.byteLength, payloadDigest: createHash('sha256').update(fragment).digest('hex'),
        itemCount: 1, firstItemIndex: itemIndex, fragmentIndex, fragmentCount })
    }
    return true
  }
  const appendJsonItem = (serialized: string, kind: 'messages' | 'facts'): boolean => {
    const bytes = Buffer.from(serialized, 'utf8')
    if (bytes.byteLength + 2 > MAX_HISTORY_EVENT_SEGMENT_BYTES) {
      closeCurrent()
      const itemIndex = itemCounts[kind]
      if (!appendFragmentedItem(bytes, kind, itemIndex)) return false
      itemCounts[kind] += 1
      return true
    }
    const separatorBytes = current && current.itemCount > 0 ? 1 : 0
    if (current && current.kind !== kind) closeCurrent()
    if (!current || current.byteLength + separatorBytes + bytes.byteLength + 1 > MAX_HISTORY_EVENT_SEGMENT_BYTES) {
      closeCurrent()
      try { beginCurrent(kind) } catch { return false }
    }
    const separator = current!.itemCount > 0 ? Buffer.from(',') : Buffer.alloc(0)
    if (separator.byteLength) { writeStagedFile(current!.fd, separator); current!.hash.update(separator); current!.byteLength += 1 }
    writeStagedFile(current!.fd, bytes)
    current!.hash.update(bytes)
    current!.byteLength += bytes.byteLength
    current!.itemCount += 1
    itemCounts[kind] += 1
    return true
  }

  let stageSucceeded = false
  let stageReturned = false
  try {
    let messageCount = 0
    let messageByteLength = 0
    const ids: string[] = []
    while (messageCount < capture.messageCount) {
      const batch = runInTransaction(conn, () => {
        if (readProjectionSourceIdentity(conn, permit.sessionId, permit.sessionGeneration) !== permit.sourceIdentityJson ||
          !isCurrentLargeEvent(conn, permit, row)) return 'source-drift' as const
        return conn.prepare(`SELECT CAST(item.key AS INTEGER) AS message_index,item.value AS message_json
          FROM agent_history_events event,json_each(event.payload_json,'$.messages') item
          WHERE event.event_id=? AND event.session_id=? AND CAST(item.key AS INTEGER)>=?
          ORDER BY CAST(item.key AS INTEGER) LIMIT 16`).all(row.event_id, permit.sessionId, messageCount) as
          Array<{ message_index: number; message_json: string }>
      })
      if (batch === 'source-drift') return { kind: 'source-drift', permit, afterSessionSequence: input.afterSessionSequence }
      if (batch.length === 0) return undefined
      for (const item of batch) {
        if (item.message_index !== messageCount) return undefined
        let message: unknown
        try { message = JSON.parse(item.message_json) } catch { return undefined }
      const spillDescriptors = collectSpillDescriptorsStrict(message)
      const spillBytes = spillDescriptors.reduce((total, descriptor) => total + descriptor.byteLength, 0)
      if (spillBytes > MAX_SEGMENTED_HISTORY_EVENT_BYTES) return undefined
      let hydrated: unknown = message
      let serialized: string | undefined = item.message_json
      if (spillDescriptors.length > 0) {
        try { hydrated = hydrateSourceTruthSpills(message, path.join(path.dirname(permit.dbPath), 'spill')) }
        catch { return undefined }
        serialized = JSON.stringify(hydrated)
      }
      if (typeof serialized !== 'string' || !appendJsonItem(serialized, 'messages')) return undefined
      messageByteLength += Buffer.byteLength(serialized, 'utf8') + 1
      if (messageByteLength > MAX_SEGMENTED_HISTORY_EVENT_BYTES) return undefined
      if (hydrated && typeof hydrated === 'object' && !Array.isArray(hydrated)) {
        const id = (hydrated as { id?: unknown }).id
        if (typeof id === 'string' && id.trim()) ids.push(id)
      }
        messageCount += 1
      }
    }
    closeCurrent()
    if (messageCount !== capture.messageCount || messageCount < 1) return undefined

    const uniqueIds = [...new Set(ids)]
    let estimatedFactBytes = 0
    let factBytes = 0
    let factCount = 0
    const seenFactIds = new Set<string>()
    for (let start = 0; start < uniqueIds.length; start += 16) {
      const batchIds = uniqueIds.slice(start, start + 16)
      const factBatch = runInTransaction(conn, () => {
        if (readProjectionSourceIdentity(conn, permit.sessionId, permit.sessionGeneration) !== permit.sourceIdentityJson ||
          !isCurrentLargeEvent(conn, permit, row)) return 'source-drift' as const
        const marks = batchIds.map(() => '?').join(',')
        return conn.prepare(`SELECT messages.id,messages.role,messages.timestamp,messages.sequence,messages.queue_scope,
          messages.content_storage_state,length(CAST(messages.content AS BLOB)) AS stored_content_byte_length,cutover.write_mode
          FROM messages LEFT JOIN session_message_content_cutover cutover ON cutover.session_id=messages.session_id
          WHERE messages.session_id=? AND messages.id IN (${marks}) ORDER BY messages.sequence ASC`)
          .all(permit.sessionId, ...batchIds) as ProjectionMessageFactHeaderRow[]
      })
      if (factBatch === 'source-drift') return { kind: 'source-drift', permit, afterSessionSequence: input.afterSessionSequence }
      for (const header of factBatch) {
        if (seenFactIds.has(header.id) || !uniqueIds.includes(header.id)) return undefined
        seenFactIds.add(header.id)
        const metadata = { id: header.id, role: header.role, timestamp: header.timestamp,
          sequence: header.sequence, queueScope: header.queue_scope, contentStorageState: header.content_storage_state,
          writeMode: header.write_mode, storedContent: '' }
        estimatedFactBytes += Buffer.byteLength(JSON.stringify(metadata), 'utf8') + Number(header.stored_content_byte_length)
        if (estimatedFactBytes > MAX_SEGMENTED_HISTORY_EVENT_BYTES) return undefined
        const content = runInTransaction(conn, () => {
          if (readProjectionSourceIdentity(conn, permit.sessionId, permit.sessionGeneration) !== permit.sourceIdentityJson ||
            !isCurrentLargeEvent(conn, permit, row)) return 'source-drift' as const
          const value = conn.prepare('SELECT content FROM messages WHERE session_id=? AND id=?').get(permit.sessionId, header.id) as
            { content: string } | undefined
          return typeof value?.content === 'string' ? value.content : undefined
        })
        if (content === 'source-drift') return { kind: 'source-drift', permit, afterSessionSequence: input.afterSessionSequence }
        if (typeof content !== 'string') return undefined
        const fact = Object.freeze({ id: header.id, role: header.role, timestamp: header.timestamp,
          sequence: header.sequence, queueScope: header.queue_scope, contentStorageState: header.content_storage_state,
          writeMode: header.write_mode,
          ...(header.content_storage_state === 'canonical-backed-dual-write' && header.role !== 'assistant'
            ? { storedContent: '', storedContentLength: content.length,
                storedContentDigest: createHash('sha256').update(content, 'utf8').digest('hex') }
            : { storedContent: content }) })
        const serialized = JSON.stringify(fact)
        if (!appendJsonItem(serialized, 'facts')) return undefined
        factBytes += Buffer.byteLength(serialized, 'utf8') + (factCount > 0 ? 1 : 0)
        if (factBytes > MAX_SEGMENTED_HISTORY_EVENT_BYTES) return undefined
        factCount += 1
      }
    }
    if (seenFactIds.size !== uniqueIds.length) return undefined
    closeCurrent()
    let requiredUserMessage: unknown
    let requiredUserByteLength = 0
    if (capture.requiredUserByteLength !== null && !capture.requiredUserMessageRef) {
      try {
        if (typeof capture.requiredUserJson !== 'string') return undefined
        const requiredValue = JSON.parse(capture.requiredUserJson)
        const descriptorBytes = collectSpillDescriptorsStrict(requiredValue)
          .reduce((total, descriptor) => total + descriptor.byteLength, 0)
        if (descriptorBytes > MAX_SEGMENTED_HISTORY_EVENT_BYTES) return undefined
        const hydratedRequiredUser = hydrateSourceTruthSpills(requiredValue, path.join(path.dirname(permit.dbPath), 'spill'))
        const serializedRequiredUser = JSON.stringify(hydratedRequiredUser)
        if (typeof serializedRequiredUser !== 'string') return undefined
        const requiredUserBytes = Buffer.from(serializedRequiredUser, 'utf8')
        if (requiredUserBytes.byteLength + 2 > MAX_HISTORY_EVENT_SEGMENT_BYTES) {
          if (!appendFragmentedItem(requiredUserBytes, 'required-user', 0)) return undefined
          requiredUserByteLength = requiredUserBytes.byteLength
        } else requiredUserMessage = hydratedRequiredUser
      } catch { return undefined }
    }
    let extraPayload: unknown
    try { extraPayload = JSON.parse(capture.extraPayloadJson) } catch { return undefined }
    if (!extraPayload || typeof extraPayload !== 'object' || Array.isArray(extraPayload)) return undefined
    const rootPayload = JSON.stringify({ formatVersion: 3, kind: 'segmented-history-event',
      event: { invocationId: row.invocation_id, sequence: row.sequence, eventId: row.event_id,
        idempotencyKey: row.idempotency_key, turnId: row.turn_id, schemaVersion: row.schema_version, kind: row.kind,
        sessionSequence: row.session_seq, commitOrder: row.commit_order, createdAt: row.created_at },
      extraPayload,
      messageCount,
      messageSegments: writtenSegments.filter(({ kind }) => kind === 'messages').map((segment) => ({ locator: segment.locator,
        byteLength: segment.byteLength, payloadDigest: segment.payloadDigest,
        itemCount: segment.encoding === 'json-item-fragment' && segment.fragmentIndex !== 0 ? 0 : segment.itemCount,
        ...(segment.encoding ? { encoding: segment.encoding, firstItemIndex: segment.firstItemIndex,
          fragmentIndex: segment.fragmentIndex, fragmentCount: segment.fragmentCount } : { firstItemIndex: segment.firstItemIndex }) })),
      factCount,
      factSegments: writtenSegments.filter(({ kind }) => kind === 'facts').map((segment) => ({ locator: segment.locator,
        byteLength: segment.byteLength, payloadDigest: segment.payloadDigest,
        itemCount: segment.encoding === 'json-item-fragment' && segment.fragmentIndex !== 0 ? 0 : segment.itemCount,
        ...(segment.encoding ? { encoding: segment.encoding, firstItemIndex: segment.firstItemIndex,
          fragmentIndex: segment.fragmentIndex, fragmentCount: segment.fragmentCount } : { firstItemIndex: segment.firstItemIndex }) })),
      ...(requiredUserByteLength > 0 ? { requiredUserSegments: writtenSegments.filter(({ kind }) => kind === 'required-user').map((segment) => ({
        locator: segment.locator, byteLength: segment.byteLength, payloadDigest: segment.payloadDigest,
        itemCount: segment.fragmentIndex === 0 ? 1 : 0, encoding: segment.encoding,
        firstItemIndex: segment.firstItemIndex, fragmentIndex: segment.fragmentIndex, fragmentCount: segment.fragmentCount })) } : {}),
      ...(capture.requiredUserMessageRef ? { requiredUserMessageRef: capture.requiredUserMessageRef } : {}),
      ...(requiredUserMessage === undefined ? {} : { requiredUserMessage }) })
    const rootBytes = Buffer.from(rootPayload, 'utf8')
    const sourceByteLength = messageByteLength + factBytes + (capture.requiredUserMessageRef
      ? Buffer.byteLength(JSON.stringify(capture.requiredUserMessageRef), 'utf8') : requiredUserByteLength) +
      Buffer.byteLength(capture.extraPayloadJson, 'utf8')
    if (rootBytes.byteLength > MAX_STAGED_SOURCE_CHUNK_BYTES || sourceByteLength > MAX_SEGMENTED_HISTORY_EVENT_BYTES) return undefined
    const payloadDigest = createHash('sha256').update(rootBytes).digest('hex')
    const rootFd = openStagedFile(staging.tempLocator)
    try { writeStagedFile(rootFd, rootBytes); fs.fsyncSync(rootFd) } finally { fs.closeSync(rootFd) }
    registerFinalizer(() => { stageSucceeded = true })
    stageReturned = true
    return { kind: 'staged-chunk', permit, afterSessionSequence: input.afterSessionSequence,
      nextSessionSequence: row.session_seq, rowCount: 1, sourceByteLength,
      hasMore: row.session_seq < watermark,
      stagedBlob: { tempLocator: staging.tempLocator, byteLength: rootBytes.byteLength, payloadDigest },
      stagedSegments: Object.freeze(writtenSegments.map((segment) => Object.freeze(segment))) }
  } finally {
    if (current) {
      try { fs.closeSync(current.fd) } catch { /* the staging owner removes partial files */ }
      current = undefined
    }
    if (!stageSucceeded && !stageReturned) for (const locator of openedFiles) {
      try { fs.rmSync(path.join(staging.root, locator), { force: true }) } catch { /* staging recovery removes leftovers */ }
    }
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
