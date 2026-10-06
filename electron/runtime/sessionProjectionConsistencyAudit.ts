import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { AppDatabase } from '../database/sqliteStore'
import { getDbConnection } from '../database/sqliteStore'
import { getMessages } from '../database/operations'
import { runInTransaction } from '../database/transaction'
import { canonicalBackedSessionProjectionMatches } from './sessionTranscriptProjection'
import { SqliteAgentHistory, type CanonicalSessionTranscriptRead } from './sqliteAgentHistory'
import { classifySessionProjectionMigrationScope } from './sessionProjectionMigrationInventory'

export type SessionProjectionConsistencyStatus = 'consistent' | 'legacy_exception' | 'deleted' | 'difference'
export type SessionProjectionLegacyComparison = 'exact' | 'skeleton' | 'legacy-exception' | 'not-compared'

export type SessionProjectionConsistencySession = Readonly<{
  sessionId: string
  status: SessionProjectionConsistencyStatus
  sourceDisposition?: string
  migrationStatus?: string
  generation?: string
  reason?: string
  legacyOwner?: string
  legacyDecision?: string
  dormantProjectionCache?: boolean
  legacyComparison: SessionProjectionLegacyComparison
  issues: readonly string[]
  canonicalWatermark?: Readonly<{
    generation: string
    sessionSeq: number
    commitOrder: number
    eventId: string | null
    invocationId: string | null
    eventCount: number
  }>
  cacheWatermark?: Readonly<{
    generation: string
    sessionSeq: number
    commitOrder: number
    eventId: string | null
    invocationId: string | null
    eventCount: number
  }>
}>

export type SessionProjectionConsistencyAuditReport = Readonly<{
  runId: string
  migrationRunStatus: string
  complete: boolean
  stableSnapshot: boolean
  globalHistoryOrderValid: boolean
  sessionCount: number
  databaseSessionCount: number
  migrationSessionCount: number
  excludedInternalHiddenSessionCount: number
  internalHistory: Readonly<{ sessionCount: number; withHistoryCount: number; healthyCount: number; unhealthyCount: number }>
  internalHistorySha256: string
  scopeAnomalies: readonly Readonly<{ sessionId: string; ownership: string | null; visibility: string | null; reason: string }>[]
  scopeAnomalyCount: number
  inventoryItemCount: number
  classifiedCount: number
  consistentCount: number
  legacyExceptionCount: number
  deletedCount: number
  differenceCount: number
  unclassifiedSessionIds: readonly string[]
  legacyCensusCount: number
  legacyQueuedCount: number
  legacyBaselineMigratedCount: number
  legacyDiscoveredCount: number
  legacyQueueReconciled: boolean
  exactLegacyComparisonCount: number
  boundarySessionIds: readonly string[]
  sampledSessionIds: readonly string[]
  sampleCount: number
  sampleMismatchCount: number
  issues: readonly string[]
  sessions: readonly SessionProjectionConsistencySession[]
}>

type AuditRunRow = {
  run_id: string; total_count: number; status: string; database_session_count: number; migration_session_count: number
  excluded_internal_hidden_session_count: number; internal_history_session_count: number; internal_history_with_events_count: number
  internal_history_healthy_count: number; internal_history_sha256: string
}
type AuditItemRow = {
  session_id: string; session_generation: string | null; source_disposition: string; status: string; reason: string | null
  legacy_owner: string | null; legacy_decision: string | null
}
type SessionRow = { id: string; generation: string; ownership: string | null; visibility: string | null }
type CacheRow = {
  session_generation: string; session_seq: number; commit_order: number; watermark_event_id: string | null
  watermark_invocation_id: string | null; event_count: number
}

function legacyProjectionMatches(
  canonicalMessages: readonly { id?: unknown; role: string; content?: unknown; timestamp?: unknown }[],
  legacyMessages: readonly { id: string; role: string; content: string; timestamp: number }[]
): boolean {
  if (canonicalMessages.length !== legacyMessages.length) return false
  const canonicalIds = canonicalMessages.map(({ id }) => id)
  const legacyIds = legacyMessages.map(({ id }) => id)
  if (!isDeepStrictEqual(canonicalIds, legacyIds)) return false
  const canonicalById = new Map(canonicalMessages.map((message) => [message.id, message]))
  const projected = legacyMessages.map((legacy) => {
    const canonical = canonicalById.get(legacy.id)
    if (!canonical || canonical.id !== legacy.id || canonical.role !== legacy.role || canonical.content !== legacy.content ||
      canonical.timestamp !== legacy.timestamp) return undefined
    return { ...legacy, id: canonical.id, role: canonical.role, content: canonical.content, timestamp: canonical.timestamp }
  })
  return projected.every((message) => message !== undefined) && isDeepStrictEqual(projected, legacyMessages)
}

function watermark(value: Extract<CanonicalSessionTranscriptRead, { kind: 'matched' }>) {
  return {
    generation: value.sessionGeneration, sessionSeq: value.sessionSeq, commitOrder: value.commitOrder,
    eventId: value.watermarkEventId, invocationId: value.watermarkInvocationId, eventCount: value.eventCount
  }
}

function readLegacyRequiredException(
  db: AppDatabase,
  item: AuditItemRow,
  session: SessionRow
): SessionProjectionConsistencySession {
  const conn = getDbConnection(db)
  const messages = getMessages(db, session.id, Number.MAX_SAFE_INTEGER)
  const eligibility = conn.prepare(`SELECT session_generation FROM canonical_session_projection_eligibility WHERE session_id=?`)
    .get(session.id) as { session_generation: string } | undefined
  const projectionCache = conn.prepare(`SELECT 1 AS present FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'`)
    .get(session.id)
  const cutover = conn.prepare('SELECT write_mode FROM session_message_content_cutover WHERE session_id=?')
    .get(session.id) as { write_mode: string } | undefined
  const issues: string[] = []
  if (item.status !== 'legacy_required' || item.legacy_decision !== 'retain-legacy' || !item.legacy_owner || !item.reason) {
    issues.push('legacy-exception-policy-incomplete')
  }
  if (eligibility?.session_generation === session.generation || cutover?.write_mode === 'canonical') {
    issues.push('legacy-exception-conflicts-with-canonical-owner')
  }
  return {
    sessionId: session.id, status: issues.length === 0 ? 'legacy_exception' : 'difference',
    sourceDisposition: item.source_disposition, migrationStatus: item.status, generation: session.generation,
    reason: item.reason ?? undefined, legacyOwner: item.legacy_owner ?? undefined, legacyDecision: item.legacy_decision ?? undefined,
    dormantProjectionCache: projectionCache !== undefined,
    legacyComparison: 'legacy-exception', issues
  }
}

function auditOneSession(
  db: AppDatabase,
  history: SqliteAgentHistory,
  session: SessionRow,
  item: AuditItemRow | undefined,
  globalHistoryOrderValid: boolean
): SessionProjectionConsistencySession {
  if (!item) return { sessionId: session.id, status: 'difference', generation: session.generation,
    legacyComparison: 'not-compared', issues: ['unclassified-session'] }
  const issues: string[] = []
  if (!item.session_generation || item.session_generation !== session.generation) {
    return { sessionId: session.id, status: 'difference', sourceDisposition: item.source_disposition,
      migrationStatus: item.status, generation: session.generation, legacyComparison: 'not-compared', issues: ['generation-mismatch'] }
  }
  if (item.status === 'legacy_required') return readLegacyRequiredException(db, item, session)
  if (item.status !== 'migrated') issues.push(`migration-status-${item.status}`)
  if (!globalHistoryOrderValid) issues.push('global-history-order-invalid')
  if (issues.length > 0) return { sessionId: session.id, status: 'difference', sourceDisposition: item.source_disposition,
    migrationStatus: item.status, generation: session.generation, legacyComparison: 'not-compared', issues }

  const conn = getDbConnection(db)
  const storedRows = conn.prepare(`SELECT content_storage_state FROM messages WHERE session_id=? ORDER BY sequence`)
    .all(session.id) as Array<{ content_storage_state: string }>
  const cutover = conn.prepare('SELECT write_mode FROM session_message_content_cutover WHERE session_id=?')
    .get(session.id) as { write_mode: string } | undefined
  const hasCanonicalBackedRows = storedRows.some(({ content_storage_state }) => content_storage_state !== 'legacy')
  const legacyMessages = getMessages(db, session.id, Number.MAX_SAFE_INTEGER)
  let canonical: CanonicalSessionTranscriptRead
  let legacyComparison: SessionProjectionLegacyComparison

  if (hasCanonicalBackedRows || cutover?.write_mode === 'canonical') {
    if (cutover?.write_mode !== 'canonical') {
      return { sessionId: session.id, status: 'difference', sourceDisposition: item.source_disposition,
        migrationStatus: item.status, generation: session.generation, legacyComparison: 'skeleton', issues: ['canonical-owner-missing'] }
    }
    canonical = history.readCanonicalSessionTranscriptForShadow(session.id, { globalCommitCursorAlreadyValidated: true })
    legacyComparison = storedRows.some(({ content_storage_state }) => content_storage_state === 'canonical-backed-only') ? 'skeleton' : 'exact'
    if (canonical.kind === 'matched' && !canonicalBackedSessionProjectionMatches(db, session.id, canonical.messages)) {
      issues.push('message-skeleton-mismatch')
    }
  } else {
    if (legacyMessages.some(({ role }) => role !== 'user' && role !== 'assistant')) {
      return { sessionId: session.id, status: 'difference', sourceDisposition: item.source_disposition,
        migrationStatus: item.status, generation: session.generation, legacyComparison: 'not-compared', issues: ['legacy-oracle-field-not-eligible'] }
    }
    canonical = history.readCanonicalSessionTranscript(session.id, legacyMessages.map(({ id, role, content, timestamp }) => ({
      id, role: role as 'user' | 'assistant', content, timestamp
    })), { globalCommitCursorAlreadyValidated: true })
    legacyComparison = 'exact'
  }

  if (canonical.kind !== 'matched') {
    issues.push(`canonical-${canonical.reason}`)
    return { sessionId: session.id, status: 'difference', sourceDisposition: item.source_disposition,
      migrationStatus: item.status, generation: session.generation, legacyComparison, issues }
  }
  if (legacyComparison === 'exact' && !legacyProjectionMatches(canonical.messages, legacyMessages)) {
    issues.push('legacy-projection-mismatch')
  }
  const canonicalWatermark = watermark(canonical)
  try {
    history.validateCanonicalSessionSourceTruthSpills(session.id)
  } catch {
    issues.push('source-spill-invalid')
  }

  const cache = history.readCanonicalSessionCache({ ...canonical, cacheKey: 'transcript' })
  if (cache.kind !== 'hit') issues.push(`cache-${cache.reason}`)
  const cacheRow = conn.prepare(`SELECT session_generation,session_seq,commit_order,watermark_event_id,watermark_invocation_id,event_count
    FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'`).get(session.id) as CacheRow | undefined
  const cacheWatermark = cacheRow ? {
    generation: cacheRow.session_generation, sessionSeq: cacheRow.session_seq, commitOrder: cacheRow.commit_order,
    eventId: cacheRow.watermark_event_id, invocationId: cacheRow.watermark_invocation_id, eventCount: cacheRow.event_count
  } : undefined
  if (cacheRow && !isDeepStrictEqual(cacheWatermark, canonicalWatermark)) issues.push('cache-watermark-mismatch')
  if (cache.kind === 'hit') {
    try {
      const cachedMessages = JSON.parse(cache.value) as unknown
      if (!isDeepStrictEqual(cachedMessages, canonical.messages)) issues.push('cache-content-mismatch')
    } catch {
      issues.push('cache-content-invalid')
    }
  }
  return {
    sessionId: session.id, status: issues.length === 0 ? 'consistent' : 'difference',
    sourceDisposition: item.source_disposition, migrationStatus: item.status, generation: session.generation,
    legacyComparison, issues, canonicalWatermark, ...(cacheWatermark ? { cacheWatermark } : {})
  }
}

function chooseSamples(sessions: readonly SessionProjectionConsistencySession[], sampleSize: number): {
  boundarySessionIds: string[]; sampledSessionIds: string[]; sampleMismatchCount: number
} {
  const exact = sessions.filter((item) => item.legacyComparison === 'exact').sort((left, right) => left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0)
  if (exact.length === 0) return { boundarySessionIds: [], sampledSessionIds: [], sampleMismatchCount: 0 }
  const boundarySessionIds = exact.length === 1 ? [exact[0]!.sessionId] : [exact[0]!.sessionId, exact.at(-1)!.sessionId]
  const count = Math.min(sampleSize, exact.length)
  const indexes = new Set<number>([0, exact.length - 1])
  if (count === 1) indexes.clear(), indexes.add(0)
  else for (let index = 0; index < count; index += 1) indexes.add(Math.round(index * (exact.length - 1) / (count - 1)))
  const sampled = [...indexes].sort((a, b) => a - b).map((index) => exact[index]!)
  return {
    boundarySessionIds,
    sampledSessionIds: sampled.map(({ sessionId }) => sessionId),
    sampleMismatchCount: sampled.filter(({ status }) => status === 'difference').length
  }
}

function auditInternalHistory(db: AppDatabase, sessions: readonly SessionRow[], history: SqliteAgentHistory) {
  const conn = getDbConnection(db)
  const internal = sessions.filter(({ ownership, visibility }) => classifySessionProjectionMigrationScope(ownership, visibility) === 'internal-hidden')
  let withHistoryCount = 0
  let healthyCount = 0
  const manifest: Array<Record<string, unknown>> = []
  for (const session of internal) {
    const streams = conn.prepare(`SELECT invocation_id,version,schema_version FROM agent_history_streams
      WHERE session_id=? ORDER BY invocation_id`).all(session.id) as Array<{ invocation_id: string; version: number; schema_version: number }>
    const events = conn.prepare(`SELECT events.invocation_id,events.sequence,events.event_id,events.idempotency_key,
      events.turn_id,events.schema_version,events.kind,events.payload_json,events.session_seq,events.commit_order,
      events.session_id,events.created_at
      FROM agent_history_events events LEFT JOIN agent_history_streams streams ON streams.invocation_id=events.invocation_id
      WHERE events.session_id=? OR streams.session_id=? ORDER BY events.commit_order,events.invocation_id,events.sequence`)
      .all(session.id, session.id) as Array<Record<string, unknown>>
    const ownedCountRow = conn.prepare(`SELECT COUNT(*) AS count FROM agent_history_events events
      JOIN agent_history_streams streams ON streams.invocation_id=events.invocation_id
      WHERE streams.session_id=? AND events.session_id=?`).get(session.id, session.id) as { count: number }
    const ownedCount = Number(ownedCountRow.count)
    const ownershipValid = ownedCount === events.length && streams.every((stream) => events.some((event) => event.invocation_id === stream.invocation_id))
    const eventCount = events.length
    if (eventCount > 0) withHistoryCount += 1
    const transcript = ownershipValid
      ? history.readCanonicalSessionTranscriptForShadow(session.id, { globalCommitCursorAlreadyValidated: true }) : undefined
    const healthy = eventCount === 0 ? ownershipValid && streams.length === 0 : ownershipValid && transcript?.kind === 'matched'
    if (eventCount > 0 && healthy) healthyCount += 1
    manifest.push({ sessionId: session.id, generation: session.generation, streamCount: streams.length, eventCount,
      health: eventCount === 0 ? 'empty' : healthy ? 'healthy' : 'unhealthy',
      ...(eventCount > 0 ? { historySha256: createHash('sha256').update(JSON.stringify({ streams, events })).digest('hex') } : {}) })
  }
  return {
    internalHistory: { sessionCount: internal.length, withHistoryCount, healthyCount, unhealthyCount: withHistoryCount - healthyCount },
    internalHistorySha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
  }
}

/** Read-only full audit of the durable migration census, canonical watermark, cache bytes, and legacy-readable samples. */
export function auditSessionProjectionMigration(
  db: AppDatabase,
  runId: string,
  options: Readonly<{ sampleSize?: number }> = {}
): SessionProjectionConsistencyAuditReport {
  const sampleSize = options.sampleSize ?? 5
  if (!Number.isSafeInteger(sampleSize) || sampleSize < 1 || sampleSize > 100) throw new RangeError('sampleSize must be between 1 and 100')
  const conn = getDbConnection(db)
  const startingDataVersion = Number((conn.prepare('PRAGMA data_version').get() as { data_version: number }).data_version)
  const startingTotalChanges = Number((conn.prepare('SELECT total_changes() AS n').get() as { n: number }).n)
  const snapshot = runInTransaction(conn, () => {
    const run = conn.prepare(`SELECT run_id,total_count,status,database_session_count,migration_session_count,
      excluded_internal_hidden_session_count,internal_history_session_count,internal_history_with_events_count,
      internal_history_healthy_count,internal_history_sha256 FROM session_projection_migration_runs WHERE run_id=?`)
      .get(runId) as AuditRunRow | undefined
    if (!run) throw new Error(`unknown session projection migration run: ${runId}`)
    const items = conn.prepare(`SELECT session_id,session_generation,source_disposition,status,reason,legacy_owner,legacy_decision
      FROM session_projection_migration_items WHERE run_id=? ORDER BY session_id`).all(runId) as AuditItemRow[]
    const itemById = new Map(items.map((item) => [item.session_id, item]))
    const liveSessions = conn.prepare('SELECT id,generation,ownership,visibility FROM sessions ORDER BY id').all() as SessionRow[]
    const globalHistoryOrderValid = new SqliteAgentHistory(conn).isGlobalCommitCursorContiguous()
    const history = new SqliteAgentHistory(conn)
    const scopeAnomalies: Array<{ sessionId: string; ownership: string | null; visibility: string | null; reason: string }> = []
    const itemIds = new Set(items.map(({ session_id }) => session_id))
    for (const session of liveSessions) {
      const scope = classifySessionProjectionMigrationScope(session.ownership, session.visibility)
      if (scope === 'unknown') scopeAnomalies.push({ sessionId: session.id, ownership: session.ownership, visibility: session.visibility, reason: 'unknown-scope' })
      else if (scope === 'internal-hidden' && itemIds.has(session.id)) {
        scopeAnomalies.push({ sessionId: session.id, ownership: session.ownership, visibility: session.visibility, reason: 'internal-session-in-migration-items' })
      }
    }
    const migrationSessions = liveSessions.filter(({ ownership, visibility }) =>
      classifySessionProjectionMigrationScope(ownership, visibility) === 'product')
    const internalHistoryAudit = auditInternalHistory(db, liveSessions, history)
    const results: SessionProjectionConsistencySession[] = migrationSessions.map((session) =>
      auditOneSession(db, history, session, itemById.get(session.id), globalHistoryOrderValid))
    for (const item of items) {
      if (itemById.has(item.session_id) && !liveSessions.some(({ id }) => id === item.session_id)) {
        results.push(item.status === 'deleted'
          ? { sessionId: item.session_id, status: 'deleted', sourceDisposition: item.source_disposition,
            migrationStatus: item.status, legacyComparison: 'not-compared', issues: [] }
          : { sessionId: item.session_id, status: 'difference', sourceDisposition: item.source_disposition,
            migrationStatus: item.status, legacyComparison: 'not-compared', issues: ['session-missing-without-deleted-disposition'] })
      }
    }
    const liveSessionIds = new Set(liveSessions.map(({ id }) => id))
    const cacheRows = conn.prepare(`SELECT session_id,cache_key FROM canonical_session_projection_cache ORDER BY session_id,cache_key`)
      .all() as Array<{ session_id: string; cache_key: string }>
    for (const cache of cacheRows) {
      const cacheIssue = !liveSessionIds.has(cache.session_id) ? 'orphan-projection-cache'
        : cache.cache_key !== 'transcript' ? `unsupported-cache-key-${cache.cache_key}` : undefined
      if (!cacheIssue) continue
      const index = results.findIndex(({ sessionId }) => sessionId === cache.session_id)
      if (index >= 0) {
        const existing = results[index]!
        results[index] = { ...existing, status: 'difference', issues: [...existing.issues, cacheIssue] }
      } else {
        results.push({ sessionId: cache.session_id, status: 'difference', legacyComparison: 'not-compared', issues: [cacheIssue] })
      }
    }
    const counts = conn.prepare(`SELECT
      SUM(source_disposition='legacy_required') AS census_count,
      SUM(source_disposition='legacy_required' AND status='legacy_required') AS queued_count,
      SUM(source_disposition='legacy_required' AND status='migrated') AS baseline_migrated_count,
      SUM(source_disposition<>'legacy_required' AND status='legacy_required') AS discovered_count
      FROM session_projection_migration_items WHERE run_id=?`).get(runId) as {
        census_count: number | null; queued_count: number | null; baseline_migrated_count: number | null; discovered_count: number | null
      }
    const censusCount = Number(counts.census_count ?? 0)
    const queuedCount = Number(counts.queued_count ?? 0)
    const baselineMigratedCount = Number(counts.baseline_migrated_count ?? 0)
    const topIssues: string[] = []
    if (run.status !== 'completed') topIssues.push('migration-run-not-completed')
    if (items.length !== run.total_count) topIssues.push('migration-inventory-count-mismatch')
    if (censusCount !== queuedCount + baselineMigratedCount) topIssues.push('legacy-queue-count-mismatch')
    if (liveSessions.length !== run.database_session_count || migrationSessions.length !== run.migration_session_count ||
      liveSessions.filter(({ ownership, visibility }) => classifySessionProjectionMigrationScope(ownership, visibility) === 'internal-hidden').length !== run.excluded_internal_hidden_session_count) {
      topIssues.push('migration-scope-count-mismatch')
    }
    if (internalHistoryAudit.internalHistorySha256 !== run.internal_history_sha256 ||
      internalHistoryAudit.internalHistory.sessionCount !== run.internal_history_session_count ||
      internalHistoryAudit.internalHistory.withHistoryCount !== run.internal_history_with_events_count ||
      internalHistoryAudit.internalHistory.healthyCount !== run.internal_history_healthy_count) {
      topIssues.push('internal-history-census-mismatch')
    }
    if (internalHistoryAudit.internalHistory.unhealthyCount > 0) topIssues.push('internal-history-unhealthy')
    if (scopeAnomalies.length > 0) topIssues.push('session-scope-anomaly')
    const classifiedCount = results.filter(({ status }) => status !== 'difference').length
    return {
      run, items, liveSessions, globalHistoryOrderValid, results, topIssues, censusCount, queuedCount, baselineMigratedCount,
      discoveredCount: Number(counts.discovered_count ?? 0), classifiedCount, migrationSessions, internalHistoryAudit, scopeAnomalies
    }
  })
  const endingDataVersion = Number((conn.prepare('PRAGMA data_version').get() as { data_version: number }).data_version)
  const endingTotalChanges = Number((conn.prepare('SELECT total_changes() AS n').get() as { n: number }).n)
  const stableSnapshot = startingDataVersion === endingDataVersion && startingTotalChanges === endingTotalChanges
  const issues = [...snapshot.topIssues]
  if (startingDataVersion !== endingDataVersion) issues.push('database-data-version-changed-during-audit')
  if (startingTotalChanges !== endingTotalChanges) issues.push('connection-changed-during-audit')
  if (!snapshot.globalHistoryOrderValid && !snapshot.results.some(({ issues: rowIssues }) => rowIssues.includes('global-history-order-invalid'))) {
    issues.push('global-history-order-invalid')
  }
  const samples = chooseSamples(snapshot.results, sampleSize)
  const differenceCount = snapshot.results.filter(({ status }) => status === 'difference').length
  const consistentCount = snapshot.results.filter(({ status }) => status === 'consistent').length
  const legacyExceptionCount = snapshot.results.filter(({ status }) => status === 'legacy_exception').length
  const deletedCount = snapshot.results.filter(({ status }) => status === 'deleted').length
  const exactLegacyComparisonCount = snapshot.results.filter(({ legacyComparison }) => legacyComparison === 'exact').length
  if (consistentCount > 0 && exactLegacyComparisonCount === 0) issues.push('legacy-comparison-sample-unavailable')
  const legacyQueueReconciled = snapshot.censusCount === snapshot.queuedCount + snapshot.baselineMigratedCount
  const complete = stableSnapshot && snapshot.globalHistoryOrderValid && issues.length === 0 && differenceCount === 0 &&
    legacyQueueReconciled && samples.sampleMismatchCount === 0
  return {
    runId, migrationRunStatus: snapshot.run.status, complete, stableSnapshot, globalHistoryOrderValid: snapshot.globalHistoryOrderValid,
    sessionCount: snapshot.liveSessions.length, databaseSessionCount: snapshot.liveSessions.length,
    migrationSessionCount: snapshot.migrationSessions.length,
    excludedInternalHiddenSessionCount: snapshot.internalHistoryAudit.internalHistory.sessionCount,
    internalHistory: snapshot.internalHistoryAudit.internalHistory,
    internalHistorySha256: snapshot.internalHistoryAudit.internalHistorySha256,
    scopeAnomalies: snapshot.scopeAnomalies, scopeAnomalyCount: snapshot.scopeAnomalies.length,
    inventoryItemCount: snapshot.items.length, classifiedCount: snapshot.classifiedCount,
    consistentCount, legacyExceptionCount, deletedCount, differenceCount,
    unclassifiedSessionIds: snapshot.results.filter(({ issues: rowIssues }) => rowIssues.includes('unclassified-session')).map(({ sessionId }) => sessionId),
    legacyCensusCount: snapshot.censusCount, legacyQueuedCount: snapshot.queuedCount,
    legacyBaselineMigratedCount: snapshot.baselineMigratedCount, legacyDiscoveredCount: snapshot.discoveredCount,
    legacyQueueReconciled, exactLegacyComparisonCount,
    boundarySessionIds: samples.boundarySessionIds, sampledSessionIds: samples.sampledSessionIds,
    sampleCount: samples.sampledSessionIds.length, sampleMismatchCount: samples.sampleMismatchCount,
    issues, sessions: snapshot.results
  }
}
