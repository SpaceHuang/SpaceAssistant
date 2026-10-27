import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { collectSpillDescriptorsStrict, type SpillDescriptor } from '../../../storage/spillProtocol'

type SourceEventRow = Readonly<{
  message_id: string; invocation_id: string; event_id: string; event_sequence: number; session_sequence: number
  schema_version: number; kind: string; source_digest: string
}>
type HistoryEventRow = Readonly<{
  invocation_id: string; turn_id: string; sequence: number; event_id: string; idempotency_key: string
  schema_version: number; kind: string; session_seq: number; commit_order: number; created_at: number; payload_json: string
}>

const STREAMED_EVENT_DIGEST_THRESHOLD = 64 * 1024
const EVENT_DIGEST_CHUNK_CHARS = 16 * 1024

function updateJsonStringContents(hash: ReturnType<typeof createHash>, value: string): void {
  for (let start = 0; start < value.length;) {
    let end = Math.min(value.length, start + EVENT_DIGEST_CHUNK_CHARS)
    if (end < value.length) {
      const last = value.charCodeAt(end - 1)
      const next = value.charCodeAt(end)
      if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--
    }
    const encoded = JSON.stringify(value.slice(start, end))
    if (typeof encoded !== 'string') throw new Error('PROJECTION_SOURCE_DIGEST_ENCODING_FAILED')
    hash.update(encoded.slice(1, -1), 'utf8')
    start = end
  }
}

/** Resolve and verify only the invocation dependencies named by a complete page locator. */
export function readProjectionPageSourceSpills(conn: DatabaseSync, sessionId: string, sourceRevision: number,
  messageIds: readonly string[]): readonly SpillDescriptor[] {
  if (!messageIds.length) return []
  if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 0 || new Set(messageIds).size !== messageIds.length ||
    messageIds.some((id) => typeof id !== 'string' || !id)) throw new Error('PROJECTION_SOURCE_LOCATOR_INVALID')

  const ids: string[] = []
  for (let start = 0; start < messageIds.length; start += 400) ids.push(...messageIds.slice(start, start + 400))
  const dependencies: SourceEventRow[] = []
  for (let start = 0; start < ids.length; start += 400) {
    const batch = ids.slice(start, start + 400)
    const marks = batch.map(() => '?').join(',')
    dependencies.push(...conn.prepare(`SELECT refs.message_id,refs.invocation_id,refs.event_id,refs.event_sequence,
      refs.session_sequence,refs.schema_version,refs.kind,refs.source_digest
      FROM session_message_body_source_event refs JOIN session_body_source_manifest manifests
        ON manifests.session_id=refs.session_id AND manifests.invocation_id=refs.invocation_id
      WHERE refs.session_id=? AND refs.message_id IN (${marks}) AND manifests.source_revision=?
      ORDER BY refs.message_id,refs.session_sequence,refs.event_sequence`).all(sessionId, ...batch, sourceRevision) as SourceEventRow[])
  }
  const idsWithDependencies = new Set(dependencies.map(({ message_id }) => message_id))
  if (messageIds.some((id) => !idsWithDependencies.has(id))) throw new Error('PROJECTION_SOURCE_LOCATOR_UNAVAILABLE')

  const countsByMessageInvocation = new Map<string, { messageId: string; invocationId: string; count: number }>()
  for (const { message_id: messageId, invocation_id: invocationId } of dependencies) {
    const key = `${messageId}\u0000${invocationId}`
    const group = countsByMessageInvocation.get(key) ?? { messageId, invocationId, count: 0 }
    group.count += 1
    countsByMessageInvocation.set(key, group)
  }
  for (const { messageId, invocationId, count } of countsByMessageInvocation.values()) {
    const actual = conn.prepare(`SELECT COUNT(*) AS count FROM agent_history_events events
      JOIN agent_history_streams streams ON streams.invocation_id=events.invocation_id
      WHERE events.session_id=? AND streams.session_id=? AND events.invocation_id=?`)
      .get(sessionId, sessionId, invocationId) as { count: number } | undefined
    if (!actual || actual.count !== count) throw new Error(`PROJECTION_SOURCE_DEPENDENCY_INCOMPLETE:${messageId}`)
  }

  const eventIds = [...new Set(dependencies.map(({ event_id }) => event_id))]
  const events: HistoryEventRow[] = []
  for (let start = 0; start < eventIds.length; start += 400) {
    const batch = eventIds.slice(start, start + 400)
    const marks = batch.map(() => '?').join(',')
    events.push(...conn.prepare(`SELECT invocation_id,turn_id,sequence,event_id,idempotency_key,schema_version,kind,
      session_seq,commit_order,created_at,payload_json FROM agent_history_events
      WHERE session_id=? AND event_id IN (${marks})`).all(sessionId, ...batch) as HistoryEventRow[])
  }
  const eventById = new Map(events.map((event) => [event.event_id, event]))
  if (eventById.size !== eventIds.length) throw new Error('PROJECTION_SOURCE_DEPENDENCY_MISSING')
  const refsByEvent = new Map<string, SourceEventRow[]>()
  for (const ref of dependencies) refsByEvent.set(ref.event_id, [...(refsByEvent.get(ref.event_id) ?? []), ref])
  for (const [eventId, rows] of refsByEvent) {
    const event = eventById.get(eventId)!
    for (const ref of rows) {
      if (event.invocation_id !== ref.invocation_id || event.sequence !== ref.event_sequence || event.session_seq !== ref.session_sequence ||
        event.schema_version !== ref.schema_version || event.kind !== ref.kind || projectionSourceEventDigest(event) !== ref.source_digest) {
        throw new Error('PROJECTION_SOURCE_DEPENDENCY_MISMATCH')
      }
    }
  }

  const state = conn.prepare(`SELECT status,verified_generation FROM spill_reference_backfill_state
    WHERE owner_table='agent_history_events'`).get() as { status: string; verified_generation: number | null } | undefined
  const generation = conn.prepare("SELECT meta_value FROM spill_reference_meta WHERE meta_key='canonical_change_generation'")
    .get() as { meta_value: number } | undefined
  if (!state || state.status !== 'complete' || !generation || !Number.isSafeInteger(state.verified_generation) ||
    !Number.isSafeInteger(generation.meta_value) || state.verified_generation! > generation.meta_value) {
    throw new Error('PROJECTION_SOURCE_SPILL_INDEX_UNAVAILABLE')
  }

  const referenced: SpillDescriptor[] = []
  for (const event of events) {
    let payload: unknown
    try { payload = JSON.parse(event.payload_json) } catch { throw new Error('PROJECTION_SOURCE_DEPENDENCY_INVALID') }
    const descriptors = collectSpillDescriptorsStrict(payload)
    const indexed = conn.prepare(`SELECT refs.owner_revision,events.spill_reference_revision,refs.descriptor_json
      FROM spill_reference_index refs JOIN agent_history_events events
        ON refs.owner_table='agent_history_events' AND refs.owner_key=json_array(events.invocation_id,events.event_id)
      WHERE events.session_id=? AND events.event_id=? AND refs.kind='source-of-truth' ORDER BY refs.descriptor_path`)
      .all(sessionId, event.event_id) as Array<{ owner_revision: string; spill_reference_revision: number; descriptor_json: string }>
    if (indexed.some(({ owner_revision, spill_reference_revision }) => owner_revision !== String(spill_reference_revision))) {
      throw new Error('PROJECTION_SOURCE_SPILL_INDEX_UNAVAILABLE')
    }
    const parsedIndexed: SpillDescriptor[] = []
    for (const { descriptor_json } of indexed) {
      let descriptor: unknown
      try { descriptor = JSON.parse(descriptor_json) } catch { throw new Error('PROJECTION_SOURCE_SPILL_INDEX_INVALID') }
      const found = collectSpillDescriptorsStrict({ __spaceassistant_spill_v1: descriptor })
      if (found.length !== 1 || found[0]?.kind !== 'source-of-truth') throw new Error('PROJECTION_SOURCE_SPILL_INDEX_INVALID')
      parsedIndexed.push(found[0])
    }
    const stable = (items: readonly SpillDescriptor[]) => items.map((item) => JSON.stringify(item)).sort()
    if (JSON.stringify(stable(descriptors)) !== JSON.stringify(stable(parsedIndexed))) throw new Error('PROJECTION_SOURCE_SPILL_INDEX_MISMATCH')
    referenced.push(...descriptors)
  }
  return Object.freeze(referenced)
}

export function projectionSourceEventDigest(event: HistoryEventRow): string {
  const fields = { invocationId: event.invocation_id, turnId: event.turn_id,
    sequence: event.sequence, eventId: event.event_id, idempotencyKey: event.idempotency_key, schemaVersion: event.schema_version,
    kind: event.kind, sessionSequence: event.session_seq, commitOrder: event.commit_order, createdAt: event.created_at,
    payloadJson: event.payload_json }
  if (event.payload_json.length <= STREAMED_EVENT_DIGEST_THRESHOLD) {
    return createHash('sha256').update(JSON.stringify(fields), 'utf8').digest('hex')
  }

  // Preserve the existing JSON digest format while avoiding a second full-size escaped payload string.
  const envelope = JSON.stringify({ ...fields, payloadJson: '' })
  const hash = createHash('sha256')
  hash.update(envelope.slice(0, -2), 'utf8')
  updateJsonStringContents(hash, event.payload_json)
  hash.update('"}', 'utf8')
  return hash.digest('hex')
}
