import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import { getMessages } from '../database/operations'
import { getDbConnection, type AppDatabase } from '../database/sqliteStore'
import { SqliteAgentHistory, type CanonicalSessionTranscriptRead } from './sqliteAgentHistory'
import { canonicalBackedSessionProjectionMatches } from './sessionTranscriptProjection'

export type SessionProjectionMigrationDisposition =
  | 'projection_migrated'
  | 'projection_eligible'
  | 'legacy_required'
  | 'deleted'

export type SessionProjectionMigrationInventoryEntry = Readonly<{
  sessionId: string
  sessionGeneration?: string
  disposition: SessionProjectionMigrationDisposition
  reason?: string
}>

export type SessionProjectionMigrationInventory = Readonly<{
  dataVersion: number
  totalChanges: number
  databaseSessionCount: number
  migrationSessionCount: number
  excludedInternalHiddenSessionCount: number
  internalHistory: Readonly<{ sessionCount: number; withHistoryCount: number; healthyCount: number; unhealthyCount: number }>
  internalHistorySha256: string
  classifiedSessionCount: number
  counts: Readonly<Record<SessionProjectionMigrationDisposition, number>>
  sessions: readonly SessionProjectionMigrationInventoryEntry[]
}>

export class SessionProjectionMigrationInventoryError extends Error {
  readonly sessionId?: string
  readonly reason: string

  constructor(reason: string, sessionId?: string) {
    super(sessionId ? `session projection inventory failed for ${sessionId}: ${reason}` : `session projection inventory failed: ${reason}`)
    this.name = 'SessionProjectionMigrationInventoryError'
    this.reason = reason
    this.sessionId = sessionId
  }
}

type InventorySessionRow = Readonly<{ id: string; generation: string; ownership: string | null; visibility: string | null }>
type InventoryMessageRow = Readonly<{ id: string; content_storage_state: string }>

export type SessionProjectionMigrationScope = 'product' | 'internal-hidden' | 'unknown'

export function classifySessionProjectionMigrationScope(ownership: string | null, visibility: string | null): SessionProjectionMigrationScope {
  if (ownership === 'internal' && visibility === 'hidden') return 'internal-hidden'
  if ((ownership === 'user' && visibility === 'primary') ||
    (ownership === 'remote' && visibility === 'primary') ||
    (ownership === 'automation' && visibility === 'section')) return 'product'
  return 'unknown'
}

function legacyOracleMessages(db: AppDatabase, sessionId: string) {
  return getMessages(db, sessionId, Number.MAX_SAFE_INTEGER).map(({ id, role, content, timestamp }) => ({
    id,
    role: role as 'user' | 'assistant',
    content,
    timestamp
  }))
}

function unavailableReason(result: CanonicalSessionTranscriptRead): string | undefined {
  return result.kind === 'unavailable' ? result.reason : undefined
}

function hasCurrentProjectionCache(
  db: AppDatabase,
  history: SqliteAgentHistory,
  transcript: Extract<CanonicalSessionTranscriptRead, { kind: 'matched' }>
): boolean {
  const eligibility = getDbConnection(db).prepare(`SELECT session_generation FROM canonical_session_projection_eligibility
    WHERE session_id=?`).get(transcript.sessionId) as { session_generation: string } | undefined
  if (eligibility?.session_generation !== transcript.sessionGeneration) return false
  const cache = history.readCanonicalSessionCache({ ...transcript, cacheKey: 'transcript' })
  if (cache.kind !== 'hit') return false
  try {
    return isDeepStrictEqual(JSON.parse(cache.value), transcript.messages)
  } catch {
    return false
  }
}

/**
 * Build a point-in-time census without writing eligibility, cache, or migration state.
 * A previous census can be supplied to account for sessions deleted since that snapshot.
 */
export function buildSessionProjectionMigrationInventory(
  db: AppDatabase,
  options: Readonly<{ knownSessionIds?: readonly string[] }> = {}
): SessionProjectionMigrationInventory {
  const conn = getDbConnection(db)
  const startingDataVersion = Number((conn.prepare('PRAGMA data_version').get() as { data_version: number }).data_version)
  const startingTotalChanges = Number((conn.prepare('SELECT total_changes() AS total_changes').get() as { total_changes: number }).total_changes)
  const inventory = (() => {
    const databaseSessionCount = Number((conn.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count)
    const allSessions = conn.prepare('SELECT id,generation,ownership,visibility FROM sessions ORDER BY id').all() as InventorySessionRow[]
    if (allSessions.length !== databaseSessionCount) throw new SessionProjectionMigrationInventoryError('session census changed during snapshot')
    const sessions: InventorySessionRow[] = []
    const internalHiddenSessions: InventorySessionRow[] = []
    for (const session of allSessions) {
      const scope = classifySessionProjectionMigrationScope(session.ownership, session.visibility)
      if (scope === 'internal-hidden') {
        internalHiddenSessions.push(session)
        continue
      }
      if (scope !== 'product') {
        throw new SessionProjectionMigrationInventoryError(
          `session migration scope is unknown (${session.ownership ?? 'null'}/${session.visibility ?? 'null'})`, session.id
        )
      }
      sessions.push(session)
    }

    const knownSessionIds = options.knownSessionIds ?? []
    if (knownSessionIds.some((sessionId) => typeof sessionId !== 'string' || sessionId.trim().length === 0)) {
      throw new SessionProjectionMigrationInventoryError('previous inventory contains an invalid session ID')
    }
    if (new Set(knownSessionIds).size !== knownSessionIds.length) {
      throw new SessionProjectionMigrationInventoryError('previous inventory contains duplicate session IDs')
    }
    const currentIds = new Set(allSessions.map(({ id }) => id))
    const deleted = knownSessionIds.filter((sessionId) => !currentIds.has(sessionId)).sort()

    const history = new SqliteAgentHistory(conn)
    if (!history.isGlobalCommitCursorContiguous()) {
      throw new SessionProjectionMigrationInventoryError('global History commit cursor is not contiguous')
    }

    const entries: SessionProjectionMigrationInventoryEntry[] = []
    let internalHistoryWithEventsCount = 0
    let internalHistoryHealthyCount = 0
    const internalHistoryManifest: Array<Readonly<{
      sessionId: string; generation: string; streamCount: number; eventCount: number; health: 'empty' | 'healthy'; historySha256?: string
    }>> = []
    for (const session of internalHiddenSessions) {
      if (!session.id || !session.generation) throw new SessionProjectionMigrationInventoryError('session identity is incomplete', session.id)
      const streamRows = conn.prepare(`SELECT invocation_id,version,schema_version FROM agent_history_streams
        WHERE session_id=? ORDER BY invocation_id`).all(session.id) as Array<{ invocation_id: string; version: number; schema_version: number }>
      const eventRows = conn.prepare(`SELECT events.invocation_id,events.sequence,events.event_id,events.idempotency_key,
        events.turn_id,events.schema_version,events.kind,events.payload_json,events.session_seq,events.commit_order,
        events.session_id,events.created_at
        FROM agent_history_events events LEFT JOIN agent_history_streams streams ON streams.invocation_id=events.invocation_id
        WHERE events.session_id=? OR streams.session_id=? ORDER BY events.commit_order,events.invocation_id,events.sequence`)
        .all(session.id, session.id) as Array<Record<string, unknown>>
      const eventCount = eventRows.length
      const ownedBySessionCount = Number((conn.prepare(`SELECT COUNT(*) AS count FROM agent_history_events events
        JOIN agent_history_streams streams ON streams.invocation_id=events.invocation_id
        WHERE streams.session_id=? AND events.session_id=?`).get(session.id, session.id) as { count: number }).count)
      if (ownedBySessionCount !== eventCount || streamRows.some((stream) => !eventRows.some((event) => event.invocation_id === stream.invocation_id))) {
        throw new SessionProjectionMigrationInventoryError('internal History ownership does not match its session event ledger', session.id)
      }
      if (eventCount === 0) {
        internalHistoryManifest.push({ sessionId: session.id, generation: session.generation, streamCount: streamRows.length, eventCount, health: 'empty' })
        continue
      }
      internalHistoryWithEventsCount += 1
      const transcript = history.readCanonicalSessionTranscriptForShadow(session.id, { globalCommitCursorAlreadyValidated: true })
      if (transcript.kind !== 'matched') {
        throw new SessionProjectionMigrationInventoryError('internal History integrity check failed', session.id)
      }
      internalHistoryHealthyCount += 1
      internalHistoryManifest.push({ sessionId: session.id, generation: session.generation, streamCount: streamRows.length, eventCount, health: 'healthy',
        historySha256: createHash('sha256').update(JSON.stringify({ streams: streamRows, events: eventRows })).digest('hex') })
    }
    for (const session of sessions) {
      if (!session.id || !session.generation) throw new SessionProjectionMigrationInventoryError('session identity is incomplete', session.id)
      const connRows = conn.prepare(`SELECT content_storage_state FROM messages WHERE session_id=? ORDER BY sequence`)
        .all(session.id) as InventoryMessageRow[]
      const cutover = conn.prepare(`SELECT write_mode FROM session_message_content_cutover WHERE session_id=?`)
        .get(session.id) as { write_mode: string } | undefined
      const hasCanonicalBackedRows = connRows.some(({ content_storage_state }) => content_storage_state !== 'legacy')

      let transcript: CanonicalSessionTranscriptRead
      if (hasCanonicalBackedRows || cutover?.write_mode === 'canonical') {
        if (cutover?.write_mode !== 'canonical') {
          throw new SessionProjectionMigrationInventoryError('canonical-backed message has no canonical write owner', session.id)
        }
        transcript = history.readCanonicalSessionTranscriptForShadow(session.id, { globalCommitCursorAlreadyValidated: true })
        const reason = unavailableReason(transcript)
        if (reason) throw new SessionProjectionMigrationInventoryError(`canonical History unavailable (${reason})`, session.id)
        if (transcript.kind !== 'matched') throw new SessionProjectionMigrationInventoryError('canonical transcript was not matched', session.id)
        if (!canonicalBackedSessionProjectionMatches(db, session.id, transcript.messages)) {
          throw new SessionProjectionMigrationInventoryError('canonical History does not match message skeletons', session.id)
        }
      } else {
        const legacyMessages = legacyOracleMessages(db, session.id)
        if (legacyMessages.some(({ role }) => role !== 'user' && role !== 'assistant')) {
          entries.push({ sessionId: session.id, sessionGeneration: session.generation, disposition: 'legacy_required', reason: 'field-not-eligible' })
          continue
        }
        transcript = history.readCanonicalSessionTranscript(session.id, legacyMessages, { globalCommitCursorAlreadyValidated: true })
        const reason = unavailableReason(transcript)
        if (reason) {
          entries.push({ sessionId: session.id, sessionGeneration: session.generation, disposition: 'legacy_required', reason })
          continue
        }
      }

      if (transcript.kind !== 'matched') throw new SessionProjectionMigrationInventoryError('canonical transcript was not matched', session.id)
      const disposition = hasCurrentProjectionCache(db, history, transcript) ? 'projection_migrated' : 'projection_eligible'
      entries.push({ sessionId: session.id, sessionGeneration: session.generation, disposition })
    }

    entries.push(...deleted.map((sessionId) => ({ sessionId, disposition: 'deleted' as const })))
    const counts: Record<SessionProjectionMigrationDisposition, number> = {
      projection_migrated: 0,
      projection_eligible: 0,
      legacy_required: 0,
      deleted: 0
    }
    for (const entry of entries) counts[entry.disposition] += 1
    const classifiedSessionCount = Object.values(counts).reduce((total, count) => total + count, 0)
    if (classifiedSessionCount !== sessions.length + deleted.length) {
      throw new SessionProjectionMigrationInventoryError('classified count does not match the independent database census')
    }
    return {
      databaseSessionCount,
      migrationSessionCount: sessions.length,
      excludedInternalHiddenSessionCount: internalHiddenSessions.length,
      internalHistory: {
        sessionCount: internalHiddenSessions.length,
        withHistoryCount: internalHistoryWithEventsCount,
        healthyCount: internalHistoryHealthyCount,
        unhealthyCount: internalHistoryWithEventsCount - internalHistoryHealthyCount
      },
      internalHistorySha256: createHash('sha256').update(JSON.stringify(internalHistoryManifest)).digest('hex'),
      classifiedSessionCount, counts, sessions: entries
    }
  })()
  const endingDataVersion = Number((conn.prepare('PRAGMA data_version').get() as { data_version: number }).data_version)
  const endingTotalChanges = Number((conn.prepare('SELECT total_changes() AS total_changes').get() as { total_changes: number }).total_changes)
  if (endingDataVersion !== startingDataVersion) {
    throw new SessionProjectionMigrationInventoryError('database changed during census; retry against a stable profile')
  }
  if (endingTotalChanges !== startingTotalChanges) {
    throw new SessionProjectionMigrationInventoryError('database changed through this connection during census; retry against a stable profile')
  }
  return { ...inventory, dataVersion: startingDataVersion, totalChanges: startingTotalChanges }
}
