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
        events.schema_version,events.kind,length(CAST(events.payload_json AS BLOB)) AS payload_byte_length,
        events.session_seq,events.commit_order,events.created_at
        FROM agent_history_events events JOIN agent_history_streams streams ON streams.invocation_id=events.invocation_id
        WHERE events.session_id=? AND streams.session_id=? AND events.session_seq>?
        ORDER BY events.session_seq ASC,events.commit_order ASC LIMIT ?`).iterate(
          permit.sessionId, permit.sessionId, input.afterSessionSequence, input.maxRows + 1
        ) as Iterable<ProjectionHistoryEventRow>
      for (const row of rows) {
        if (events.length >= input.maxRows) { hasMore = true; break }
        const storedPayloadBytes = Number(row.payload_byte_length)
        if (events.length > 0 && byteLength + storedPayloadBytes > input.maxBytes) { hasMore = true; break }
        if (row.session_seq !== nextSessionSequence + 1 || row.commit_order < 1) {
          return { kind: 'unavailable', permit, afterSessionSequence: input.afterSessionSequence, reason: 'history-order-invalid' }
        }
        if (storedPayloadBytes > MAX_STAGED_SOURCE_CHUNK_BYTES) {
          if (input.staging && (row.kind === 'invocation-context-committed' || row.kind === 'transcript-compacted') &&
            events.length === 0) {
            const staged = stageOversizedContextEvent(conn, permit, input, row, watermark)
            if (staged) return staged
          }
          return { kind: 'deferred-large', permit, afterSessionSequence: input.afterSessionSequence,
            eventSequence: row.session_seq, observedByteLength: storedPayloadBytes, observedEventRows: 1,
            reason: 'oversized-event-exceeds-staging-budget' }
        }
        if (storedPayloadBytes > input.maxBytes && input.staging && events.length === 0 &&
          (row.kind === 'invocation-context-committed' || row.kind === 'transcript-compacted')) {
          const staged = stageOversizedContextEvent(conn, permit, input, row, watermark)
          if (staged) return staged
        }
        if (storedPayloadBytes > input.maxBytes && !input.allowOversizedChunk) {
          return { kind: 'deferred-large', permit, afterSessionSequence: input.afterSessionSequence,
            eventSequence: row.session_seq, observedByteLength: storedPayloadBytes, observedEventRows: 1 }
        }
        const storedPayload = conn.prepare('SELECT payload_json FROM agent_history_events WHERE event_id=? AND session_id=?')
          .get(row.event_id, permit.sessionId) as { payload_json: string } | undefined
        if (!storedPayload || Buffer.byteLength(storedPayload.payload_json, 'utf8') !== storedPayloadBytes) {
          return { kind: 'unavailable', permit, afterSessionSequence: input.afterSessionSequence, reason: 'projection-history-payload-changed' }
        }
        let parsedPayload: unknown
        try { parsedPayload = JSON.parse(storedPayload.payload_json) }
        catch {
          return { kind: 'unavailable', permit, afterSessionSequence: input.afterSessionSequence, reason: 'projection-history-payload-invalid' }
        }
        const spillDescriptors = collectSpillDescriptorsStrict(parsedPayload)
        const expandedPayloadBytes = storedPayloadBytes + spillDescriptors.reduce((total, descriptor) => total + descriptor.byteLength * 6, 0)
        if (events.length > 0 && byteLength + expandedPayloadBytes > input.maxBytes) { hasMore = true; break }
        if (expandedPayloadBytes > MAX_STAGED_SOURCE_CHUNK_BYTES) {
          if (input.staging && events.length === 0 &&
            (row.kind === 'invocation-context-committed' || row.kind === 'transcript-compacted')) {
            const staged = stageOversizedContextEvent(conn, permit, input, row, watermark)
            if (staged) return staged
          }
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

type SegmentedEventPart = Readonly<{ kind: 'messages' | 'facts' | 'required-user'; tempLocator: string; locator: string; byteLength: number;
  payloadDigest: string; itemCount: number; encoding?: 'json-item-fragment'; firstItemIndex?: number;
  fragmentIndex?: number; fragmentCount?: number }>

/** Stage a large canonical context event as bounded message/fact arrays without materializing its JSON array. */
function stageOversizedContextEvent(
  conn: ReturnType<typeof getDbConnection>, permit: ProjectionHistoryChunkPermit,
  input: ProjectionHistoryChunkReadInput,
  row: ProjectionHistoryEventRow, watermark: number
): ProjectionHistoryChunkResult | undefined {
  const staging = input.staging
  if (!staging || row.payload_byte_length > MAX_SEGMENTED_HISTORY_EVENT_BYTES || !Number.isSafeInteger(row.payload_byte_length)) return undefined
  const eventShape = conn.prepare(`SELECT json_type(payload_json,'$.messages') AS messages_type,
    json_array_length(payload_json,'$.messages') AS message_count,
    length(CAST(json_extract(payload_json,'$.requiredUserMessage') AS BLOB)) AS required_user_byte_length,
    EXISTS(SELECT 1 FROM json_each(agent_history_events.payload_json) field
      WHERE field.key NOT IN ('messages','requiredUserMessage')) AS has_unsupported_fields
    FROM agent_history_events WHERE event_id=? AND session_id=?`).get(row.event_id, permit.sessionId) as
    { messages_type: string | null; message_count: number | null; required_user_byte_length: number | null; has_unsupported_fields: number } | undefined
  if (eventShape?.messages_type !== 'array' || !Number.isSafeInteger(eventShape.message_count) || (eventShape.message_count ?? 0) < 1) return undefined
  if (eventShape.has_unsupported_fields) return undefined
  if (eventShape.required_user_byte_length !== null && eventShape.required_user_byte_length > MAX_SEGMENTED_HISTORY_EVENT_BYTES) return undefined

  const tempLocators = [staging.tempLocator, ...(staging.tempLocators ?? [])]
  if (tempLocators.length < 2 || tempLocators.length > MAX_HISTORY_EVENT_SEGMENTS + 1 ||
    new Set(tempLocators).size !== tempLocators.length || tempLocators.some((locator) =>
      !/^\.projection-[0-9a-f-]{36}\.tmp$/.test(locator) || path.basename(locator) !== locator)) return undefined
  const availableLocators = tempLocators.slice(1)
  const writtenSegments: SegmentedEventPart[] = []
  let current: { kind: 'messages' | 'facts'; locator: string; tempLocator: string; fd: number; hash: ReturnType<typeof createHash>;
    byteLength: number; itemCount: number; firstItemIndex: number } | undefined
  const itemCounts: Record<'messages' | 'facts', number> = { messages: 0, facts: 0 }
  const closeCurrent = () => {
    if (!current) return
    const closing = Buffer.from(']')
    fs.writeSync(current.fd, closing)
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
    const fd = fs.openSync(path.join(staging.root, tempLocator), 'wx', 0o600)
    const hash = createHash('sha256')
    const opening = Buffer.from('[')
    fs.writeSync(fd, opening)
    hash.update(opening)
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
      const fd = fs.openSync(path.join(staging.root, tempLocator), 'wx', 0o600)
      try { fs.writeSync(fd, fragment); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
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
    if (separator.byteLength) { fs.writeSync(current!.fd, separator); current!.hash.update(separator); current!.byteLength += 1 }
    fs.writeSync(current!.fd, bytes)
    current!.hash.update(bytes)
    current!.byteLength += bytes.byteLength
    current!.itemCount += 1
    itemCounts[kind] += 1
    return true
  }

  try {
    let messageCount = 0
    let messageByteLength = 0
    const ids: string[] = []
    const messages = conn.prepare(`SELECT CAST(item.key AS INTEGER) AS message_index,item.value AS message_json
      FROM agent_history_events event,json_each(event.payload_json,'$.messages') item
      WHERE event.event_id=? AND event.session_id=? ORDER BY CAST(item.key AS INTEGER)`).iterate(row.event_id, permit.sessionId) as
      Iterable<{ message_index: number; message_json: string }>
    for (const item of messages) {
      if (item.message_index !== messageCount) return undefined
      let message: unknown
      try { message = JSON.parse(item.message_json) } catch { return undefined }
      const spillDescriptors = collectSpillDescriptorsStrict(message)
      const spillBytes = spillDescriptors.reduce((total, descriptor) => total + descriptor.byteLength, 0)
      if (spillBytes > MAX_SEGMENTED_HISTORY_EVENT_BYTES) return undefined
      let hydrated: unknown
      try { hydrated = hydrateSourceTruthSpills(message, path.join(path.dirname(permit.dbPath), 'spill')) }
      catch { return undefined }
      const serialized = JSON.stringify(hydrated)
      if (typeof serialized !== 'string' || !appendJsonItem(serialized, 'messages')) return undefined
      messageByteLength += Buffer.byteLength(serialized, 'utf8') + 1
      if (messageByteLength > MAX_SEGMENTED_HISTORY_EVENT_BYTES) return undefined
      if (hydrated && typeof hydrated === 'object' && !Array.isArray(hydrated)) {
        const id = (hydrated as { id?: unknown }).id
        if (typeof id === 'string' && id.trim()) ids.push(id)
      }
      messageCount += 1
    }
    closeCurrent()
    if (messageCount !== eventShape.message_count || messageCount < 1) return undefined

    const uniqueIds = [...new Set(ids)]
    let estimatedFactBytes = 0
    let factBytes = 0
    let factCount = 0
    for (let start = 0; start < uniqueIds.length; start += 64) {
      const batch = uniqueIds.slice(start, start + 64)
      const headers = conn.prepare(`SELECT messages.id,messages.role,messages.timestamp,messages.sequence,messages.queue_scope,
        messages.content_storage_state,length(CAST(messages.content AS BLOB)) AS stored_content_byte_length,cutover.write_mode
        FROM messages LEFT JOIN session_message_content_cutover cutover ON cutover.session_id=messages.session_id
        WHERE messages.session_id=? AND messages.id IN (${batch.map(() => '?').join(',')}) ORDER BY messages.sequence ASC`)
        .all(permit.sessionId, ...batch) as ProjectionMessageFactHeaderRow[]
      const metadata = headers.map((fact) => ({ id: fact.id, role: fact.role, timestamp: fact.timestamp,
        sequence: fact.sequence, queueScope: fact.queue_scope, contentStorageState: fact.content_storage_state,
        writeMode: fact.write_mode, storedContent: '' }))
      estimatedFactBytes += Buffer.byteLength(JSON.stringify(metadata), 'utf8') +
        headers.reduce((total, fact) => total + Number(fact.stored_content_byte_length), 0)
      if (estimatedFactBytes > MAX_SEGMENTED_HISTORY_EVENT_BYTES) return undefined
      const contentRows = conn.prepare(`SELECT id,content FROM messages WHERE session_id=? AND id IN (${batch.map(() => '?').join(',')})`)
        .all(permit.sessionId, ...batch) as ProjectionMessageFactContentRow[]
      const contentById = new Map(contentRows.map(({ id, content }) => [id, content]))
      const facts = headers.map((fact) => Object.freeze({ id: fact.id, role: fact.role, timestamp: fact.timestamp,
        sequence: fact.sequence, queueScope: fact.queue_scope, contentStorageState: fact.content_storage_state,
        writeMode: fact.write_mode, storedContent: contentById.get(fact.id) ?? '' }))
      for (const fact of facts) {
        const serialized = JSON.stringify(fact)
        if (!appendJsonItem(serialized, 'facts')) return undefined
        factBytes += Buffer.byteLength(serialized, 'utf8') + (factCount > 0 ? 1 : 0)
        if (factBytes > MAX_SEGMENTED_HISTORY_EVENT_BYTES) return undefined
        factCount += 1
      }
    }
    closeCurrent()
    let requiredUserMessage: unknown
    let requiredUserByteLength = 0
    if (eventShape.required_user_byte_length !== null) {
      try {
        const requiredRow = conn.prepare(`SELECT json_extract(payload_json,'$.requiredUserMessage') AS required_user_json
          FROM agent_history_events WHERE event_id=? AND session_id=?`).get(row.event_id, permit.sessionId) as
          { required_user_json: string | null } | undefined
        if (typeof requiredRow?.required_user_json !== 'string') return undefined
        const requiredValue = JSON.parse(requiredRow.required_user_json)
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
    const rootPayload = JSON.stringify({ formatVersion: 2, kind: 'segmented-history-event',
      event: { invocationId: row.invocation_id, sequence: row.sequence, eventId: row.event_id,
        idempotencyKey: row.idempotency_key, turnId: row.turn_id, schemaVersion: row.schema_version, kind: row.kind,
        sessionSequence: row.session_seq, commitOrder: row.commit_order, createdAt: row.created_at },
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
      ...(requiredUserMessage === undefined ? {} : { requiredUserMessage }) })
    const rootBytes = Buffer.from(rootPayload, 'utf8')
    const sourceByteLength = messageByteLength + factBytes + requiredUserByteLength
    if (rootBytes.byteLength > MAX_STAGED_SOURCE_CHUNK_BYTES || sourceByteLength > MAX_SEGMENTED_HISTORY_EVENT_BYTES) return undefined
    const rootFd = fs.openSync(path.join(staging.root, staging.tempLocator), 'wx', 0o600)
    try { fs.writeSync(rootFd, rootBytes); fs.fsyncSync(rootFd) } finally { fs.closeSync(rootFd) }
    const payloadDigest = createHash('sha256').update(rootBytes).digest('hex')
    return { kind: 'staged-chunk', permit, afterSessionSequence: input.afterSessionSequence,
      nextSessionSequence: row.session_seq, rowCount: 1, sourceByteLength,
      hasMore: row.session_seq < watermark,
      stagedBlob: { tempLocator: staging.tempLocator, byteLength: rootBytes.byteLength, payloadDigest },
      stagedSegments: Object.freeze(writtenSegments.map((segment) => Object.freeze(segment))) }
  } finally {
    if (current) {
      try { closeCurrent() } catch { try { fs.closeSync(current.fd) } catch { /* worker cleanup handles the partial stage */ } }
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
