import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { AppDatabase } from '../database/sqliteStore'
import { getDbConnection } from '../database/sqliteStore'
import { runInTransaction } from '../database/transaction'
import { buildSessionProjectionMigrationInventory, classifySessionProjectionMigrationScope, type SessionProjectionMigrationInventory, type SessionProjectionMigrationInventoryEntry } from './sessionProjectionMigrationInventory'
import { SqliteAgentHistory } from './sqliteAgentHistory'
import { readSessionTranscriptProjection } from './sessionTranscriptProjection'
import { backfillLegacySessionProjectionBaseline } from './sessionProjectionLegacyBaseline'

export type SessionProjectionMigrationRun = Readonly<{
  runId: string
  inventorySha256: string
  status: 'running' | 'paused' | 'needs_retry' | 'needs_attention' | 'completed' | 'cancelled'
  cursor: string | null
  totalCount: number
  migratedCount: number
  legacyRequiredCount: number
  deletedCount: number
  deferredCount: number
  retryCount: number
  databaseSessionCount: number
  migrationSessionCount: number
  excludedInternalHiddenSessionCount: number
  internalHistory: Readonly<{ sessionCount: number; withHistoryCount: number; healthyCount: number; unhealthyCount: number }>
  internalHistorySha256: string
}>

export type SessionProjectionMigrationItemOutcome = Readonly<{
  sessionId: string
  status: 'migrated' | 'legacy_required' | 'deleted' | 'deferred_active' | 'retry'
  outcome: 'success' | 'failure' | 'skipped'
  reason?: string
  error?: string
}>

export type SessionProjectionMigrationBatchResult = SessionProjectionMigrationRun & Readonly<{
  processedCount: number
  successCount: number
  failureCount: number
  skippedCount: number
  outcomes: readonly SessionProjectionMigrationItemOutcome[]
}>

export type SessionProjectionMigrationExecutionReport = Readonly<{
  run: SessionProjectionMigrationRun
  batchCount: number
  processedCount: number
  successCount: number
  failureCount: number
  skippedCount: number
  outcomes: readonly SessionProjectionMigrationItemOutcome[]
}>

type RunRow = {
  inventory_sha256: string
  run_id: string; status: SessionProjectionMigrationRun['status']; after_session_id: string | null; total_count: number
  migrated_count: number; legacy_required_count: number; deleted_count: number; deferred_count: number; retry_count: number
  database_session_count: number; migration_session_count: number; excluded_internal_hidden_session_count: number
  internal_history_session_count: number; internal_history_with_events_count: number; internal_history_healthy_count: number; internal_history_sha256: string
  cancelled_at: number | null
}
type ItemRow = { session_id: string; session_generation: string | null; source_disposition: string; status: string; reason: string | null }

const LEGACY_REQUIRED_POLICY = {
  owner: 'session-storage-refactor-maintainers',
  decision: 'retain-legacy',
  userBehavior: 'legacy-reader-retain-source',
  userMessageZh: '此会话继续使用兼容读取路径；原有消息数据会保留。',
  userMessageEn: 'This session continues using the compatible reader; its existing message data is retained.'
} as const

export type LegacyRequiredSessionProjection = Readonly<{
  sessionId: string
  sourceDisposition: string
  reason: string
  owner: string
  decision: 'retain-legacy'
  userBehavior: 'legacy-reader-retain-source'
  userMessage: Readonly<{ 'zh-CN': string; 'en-US': string }>
}>

export type LegacyRequiredSessionProjectionReport = Readonly<{
  runId: string
  censusCount: number
  queuedCensusCount: number
  baselineMigratedCensusCount: number
  discoveredDuringMigrationCount: number
  reconciled: boolean
  items: readonly LegacyRequiredSessionProjection[]
}>

function toRun(row: RunRow): SessionProjectionMigrationRun {
  return {
    runId: row.run_id, inventorySha256: row.inventory_sha256,
    status: row.cancelled_at == null ? row.status : 'cancelled', cursor: row.after_session_id,
    totalCount: row.total_count, migratedCount: row.migrated_count, legacyRequiredCount: row.legacy_required_count,
    deletedCount: row.deleted_count, deferredCount: row.deferred_count, retryCount: row.retry_count,
    databaseSessionCount: row.database_session_count, migrationSessionCount: row.migration_session_count,
    excludedInternalHiddenSessionCount: row.excluded_internal_hidden_session_count,
    internalHistory: {
      sessionCount: row.internal_history_session_count,
      withHistoryCount: row.internal_history_with_events_count,
      healthyCount: row.internal_history_healthy_count,
      unhealthyCount: row.internal_history_with_events_count - row.internal_history_healthy_count
    },
    internalHistorySha256: row.internal_history_sha256
  }
}

function readRun(db: AppDatabase, runId: string): RunRow {
  const row = getDbConnection(db).prepare('SELECT * FROM session_projection_migration_runs WHERE run_id=?').get(runId) as RunRow | undefined
  if (!row) throw new Error(`unknown session projection migration run: ${runId}`)
  return row
}

export function getSessionProjectionMigrationRun(db: AppDatabase, runId: string): SessionProjectionMigrationRun {
  const row = readRun(db, runId)
  return toRun(row)
}

/** Read the durable legacy queue and reconcile its original census subset against M3-1. */
export function listLegacyRequiredSessionProjections(db: AppDatabase, runId: string): LegacyRequiredSessionProjectionReport {
  const conn = getDbConnection(db)
  return runInTransaction(conn, () => {
    readRun(db, runId)
    const legacyScopeRows = conn.prepare(`SELECT items.session_id,sessions.ownership,sessions.visibility
      FROM session_projection_migration_items items LEFT JOIN sessions ON sessions.id=items.session_id
      WHERE items.run_id=? AND items.status='legacy_required'`).all(runId) as Array<{
        session_id: string; ownership: string | null; visibility: string | null
      }>
    for (const row of legacyScopeRows) {
      if (classifySessionProjectionMigrationScope(row.ownership, row.visibility) !== 'product') {
        throw new Error('legacy-required queue contains a session outside migration scope')
      }
    }
    const counts = conn.prepare(`SELECT
    SUM(source_disposition='legacy_required') AS census_count,
    SUM(source_disposition='legacy_required' AND status='legacy_required') AS queued_census_count,
    SUM(source_disposition='legacy_required' AND status='migrated') AS baseline_migrated_census_count,
    SUM(source_disposition<>'legacy_required' AND status='legacy_required') AS discovered_count
    FROM session_projection_migration_items WHERE run_id=?`).get(runId) as {
      census_count: number | null; queued_census_count: number | null; baseline_migrated_census_count: number | null; discovered_count: number | null
    }
    const rows = conn.prepare(`SELECT session_id,source_disposition,reason,legacy_owner,legacy_decision,legacy_user_behavior,
    legacy_user_message_zh,legacy_user_message_en FROM session_projection_migration_items
    WHERE run_id=? AND status='legacy_required' ORDER BY session_id`).all(runId) as Array<{
      session_id: string; source_disposition: string; reason: string | null; legacy_owner: string | null; legacy_decision: string | null
      legacy_user_behavior: string | null; legacy_user_message_zh: string | null; legacy_user_message_en: string | null
    }>
    const items = rows.map((row): LegacyRequiredSessionProjection => {
      if (!row.reason || !row.legacy_owner || row.legacy_decision !== 'retain-legacy' ||
        row.legacy_user_behavior !== 'legacy-reader-retain-source' || !row.legacy_user_message_zh || !row.legacy_user_message_en) {
        throw new Error(`legacy-required queue item has incomplete policy metadata: ${row.session_id}`)
      }
      return {
        sessionId: row.session_id, sourceDisposition: row.source_disposition, reason: row.reason, owner: row.legacy_owner,
        decision: 'retain-legacy', userBehavior: 'legacy-reader-retain-source',
        userMessage: { 'zh-CN': row.legacy_user_message_zh, 'en-US': row.legacy_user_message_en }
      }
    })
    const censusCount = Number(counts.census_count ?? 0)
    const queuedCensusCount = Number(counts.queued_census_count ?? 0)
    const baselineMigratedCensusCount = Number(counts.baseline_migrated_census_count ?? 0)
    return {
      runId, censusCount, queuedCensusCount, baselineMigratedCensusCount,
      discoveredDuringMigrationCount: Number(counts.discovered_count ?? 0),
      reconciled: censusCount === queuedCensusCount + baselineMigratedCensusCount, items
    }
  })
}

function inventoryHash(inventory: SessionProjectionMigrationInventory): string {
  return createHash('sha256').update(JSON.stringify({
    databaseSessionCount: inventory.databaseSessionCount,
    migrationSessionCount: inventory.migrationSessionCount,
    excludedInternalHiddenSessionCount: inventory.excludedInternalHiddenSessionCount,
    internalHistory: inventory.internalHistory,
    internalHistorySha256: inventory.internalHistorySha256,
    sessions: inventory.sessions
  })).digest('hex')
}

export function startSessionProjectionMigration(
  db: AppDatabase,
  inventory: SessionProjectionMigrationInventory,
  options: Readonly<{ runId?: string; now?: number }> = {}
): SessionProjectionMigrationRun {
  const conn = getDbConnection(db)
  const runId = options.runId ?? randomUUID()
  const now = options.now ?? Date.now()
  const hash = inventoryHash(inventory)
  return runInTransaction(conn, () => {
    const existing = conn.prepare('SELECT * FROM session_projection_migration_runs WHERE run_id=?').get(runId) as RunRow | undefined
    if (existing) {
      const saved = conn.prepare('SELECT inventory_sha256 FROM session_projection_migration_runs WHERE run_id=?').get(runId) as { inventory_sha256: string }
      if (saved.inventory_sha256 !== hash) throw new Error('run ID already belongs to a different migration inventory')
      return toRun(existing)
    }
    const currentVersion = Number((conn.prepare('PRAGMA data_version').get() as { data_version: number }).data_version)
    const currentTotalChanges = Number((conn.prepare('SELECT total_changes() AS total_changes').get() as { total_changes: number }).total_changes)
    if (currentVersion !== inventory.dataVersion || currentTotalChanges !== inventory.totalChanges) {
      throw new Error('session inventory is stale; rebuild it before starting migration')
    }
    const actualCount = Number((conn.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count)
    const active = conn.prepare("SELECT run_id FROM session_projection_migration_runs WHERE status IN ('running','paused','needs_retry') LIMIT 1").get()
    if (active) throw new Error('another session projection migration run is still active')
    if (actualCount !== inventory.databaseSessionCount ||
      inventory.migrationSessionCount + inventory.excludedInternalHiddenSessionCount !== inventory.databaseSessionCount ||
      inventory.sessions.length !== inventory.migrationSessionCount + inventory.counts.deleted) {
      throw new Error('session inventory does not match the current database census')
    }
    conn.prepare(`INSERT INTO session_projection_migration_runs(run_id,inventory_sha256,inventory_data_version,status,total_count,created_at,updated_at,
      database_session_count,migration_session_count,excluded_internal_hidden_session_count,internal_history_session_count,
      internal_history_with_events_count,internal_history_healthy_count,internal_history_sha256)
      VALUES(?,?,?,'running',?,?,?,?,?,?,?,?,?,?)`).run(runId, hash, inventory.dataVersion, inventory.sessions.length, now, now,
      inventory.databaseSessionCount, inventory.migrationSessionCount, inventory.excludedInternalHiddenSessionCount,
      inventory.internalHistory.sessionCount, inventory.internalHistory.withHistoryCount, inventory.internalHistory.healthyCount,
      inventory.internalHistorySha256)
    const insert = conn.prepare(`INSERT INTO session_projection_migration_items(run_id,session_id,session_generation,source_disposition,status,reason,updated_at,
      legacy_owner,legacy_decision,legacy_user_behavior,legacy_user_message_zh,legacy_user_message_en,legacy_decided_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    for (const entry of inventory.sessions) {
      const initialStatus = entry.disposition === 'projection_eligible' ||
        (entry.disposition === 'legacy_required' && entry.reason === 'history-absent') ? 'pending'
        : entry.disposition === 'projection_migrated' ? 'migrated' : entry.disposition
      const policy = initialStatus === 'legacy_required' ? LEGACY_REQUIRED_POLICY : null
      insert.run(runId, entry.sessionId, entry.sessionGeneration ?? null, entry.disposition, initialStatus, entry.reason ?? null, now,
        policy?.owner ?? null, policy?.decision ?? null, policy?.userBehavior ?? null, policy?.userMessageZh ?? null, policy?.userMessageEn ?? null,
        policy ? now : null)
    }
    return toRun(readRun(db, runId))
  })
}

export function pauseSessionProjectionMigration(db: AppDatabase, runId: string, now = Date.now()): SessionProjectionMigrationRun {
  const conn = getDbConnection(db)
  conn.prepare("UPDATE session_projection_migration_runs SET status='paused',updated_at=? WHERE run_id=? AND status IN ('running','needs_retry')").run(now, runId)
  return getSessionProjectionMigrationRun(db, runId)
}

export function resumeSessionProjectionMigration(db: AppDatabase, runId: string, now = Date.now()): SessionProjectionMigrationRun {
  const conn = getDbConnection(db)
  conn.prepare("UPDATE session_projection_migration_runs SET status='running',updated_at=? WHERE run_id=? AND status IN ('paused','needs_retry')").run(now, runId)
  return getSessionProjectionMigrationRun(db, runId)
}

/** Persist a cooperative cancellation; completed item evidence remains intact and the run is terminal. */
export function cancelSessionProjectionMigration(db: AppDatabase, runId: string, now = Date.now()): SessionProjectionMigrationRun {
  const conn = getDbConnection(db)
  runInTransaction(conn, () => {
    const run = readRun(db, runId)
    if (run.cancelled_at != null) return
    if (!['running', 'paused', 'needs_retry'].includes(run.status)) {
      throw new Error(`session projection migration run cannot be cancelled from ${run.status}`)
    }
    conn.prepare(`UPDATE session_projection_migration_runs SET status='completed',cancelled_at=?,updated_at=?
      WHERE run_id=? AND cancelled_at IS NULL`).run(now, now, runId)
  })
  return getSessionProjectionMigrationRun(db, runId)
}

function hasActiveWork(db: AppDatabase, sessionId: string): boolean {
  return getDbConnection(db).prepare(`SELECT 1 FROM session_execution_claims WHERE session_id=?
    UNION ALL SELECT 1 FROM session_execution_queue WHERE session_id=? AND status IN ('queued','claimed','executing','transcript_committed','commit_uncertain')
    UNION ALL SELECT 1 FROM turns WHERE session_id=? AND state NOT IN ('completed','failed','cancelled','interrupted')
    UNION ALL SELECT 1 FROM messages WHERE session_id=? AND status IN ('queued','streaming') LIMIT 1`)
    .get(sessionId, sessionId, sessionId, sessionId) !== undefined
}

function finishRun(db: AppDatabase, runId: string, now: number): RunRow {
  const conn = getDbConnection(db)
  const totals = conn.prepare(`SELECT
    SUM(status='migrated') AS migrated_count, SUM(status='legacy_required') AS legacy_required_count,
    SUM(status='deleted') AS deleted_count, SUM(status='deferred_active') AS deferred_count,
    SUM(status='retry') AS retry_count, SUM(status IN ('pending','processing')) AS pending_count
    FROM session_projection_migration_items WHERE run_id=?`).get(runId) as Record<string, number | null>
  const current = readRun(db, runId)
  const currentStatus = current.status
  const status = current.cancelled_at != null ? 'completed'
    : currentStatus === 'paused' || currentStatus === 'needs_attention' ? currentStatus
    : Number(totals.pending_count ?? 0) > 0 ? 'running'
      : Number(totals.retry_count ?? 0) > 0 || Number(totals.deferred_count ?? 0) > 0 ? 'needs_retry' : 'completed'
  conn.prepare(`UPDATE session_projection_migration_runs SET status=?,migrated_count=?,legacy_required_count=?,deleted_count=?,deferred_count=?,retry_count=?,updated_at=? WHERE run_id=?`)
    .run(status, totals.migrated_count ?? 0, totals.legacy_required_count ?? 0, totals.deleted_count ?? 0, totals.deferred_count ?? 0, totals.retry_count ?? 0, now, runId)
  return readRun(db, runId)
}

class SessionProjectionScopeChangedError extends Error {}

async function processItem(db: AppDatabase, runId: string, item: ItemRow, now: number): Promise<SessionProjectionMigrationItemOutcome> {
  const conn = getDbConnection(db)
  const session = conn.prepare('SELECT generation,ownership,visibility FROM sessions WHERE id=?').get(item.session_id) as
    { generation: string; ownership: string | null; visibility: string | null } | undefined
  let status: string | undefined
  let reason: string | null = null
  let error: string | null = null
  if (!session) status = 'deleted'
  else if (session.generation !== item.session_generation) { status = 'retry'; reason = 'generation-changed' }
  else if (classifySessionProjectionMigrationScope(session.ownership, session.visibility) !== 'product') {
    status = 'retry'; reason = 'session-scope-changed-before-processing'
    conn.prepare("UPDATE session_projection_migration_runs SET status='needs_attention',updated_at=? WHERE run_id=?").run(now, runId)
  }
  else if (hasActiveWork(db, item.session_id)) { status = 'deferred_active'; reason = 'active-turn-or-queue' }
  else {
    try {
      if (item.source_disposition === 'legacy_required' && item.reason === 'history-absent') {
        const baseline = await backfillLegacySessionProjectionBaseline(db, item.session_id, { now })
        if (baseline.kind === 'rejected') {
          if (baseline.reason === 'scope-changed') {
            status = 'retry'
            reason = 'session-scope-changed-during-baseline'
            conn.prepare("UPDATE session_projection_migration_runs SET status='needs_attention',updated_at=? WHERE run_id=?").run(now, runId)
          } else {
            status = 'legacy_required'
            reason = `baseline-${baseline.reason}`
          }
        }
      }
      if (status === undefined) {
        const certification = runInTransaction(conn, () => {
          // Take the SQLite writer fence before scope validation. This keeps a different
          // connection from changing cohort while canonical reads/cache writes/eligibility commit.
          const claimed = conn.prepare(`UPDATE session_projection_migration_items SET updated_at=updated_at
            WHERE run_id=? AND session_id=? AND status='processing'`).run(runId, item.session_id)
          if (Number(claimed.changes) !== 1) throw new Error('session projection migration claim was lost')
          const readScope = () => conn.prepare('SELECT generation,ownership,visibility FROM sessions WHERE id=?').get(item.session_id) as
            { generation: string; ownership: string | null; visibility: string | null } | undefined
          const current = readScope()
          if (!current || current.generation !== item.session_generation ||
            classifySessionProjectionMigrationScope(current.ownership, current.visibility) !== 'product') {
            throw new SessionProjectionScopeChangedError('session scope changed before canonical certification')
          }
          const projection = readSessionTranscriptProjection(db, item.session_id)
          const verifiedScope = readScope()
          if (!verifiedScope || verifiedScope.generation !== item.session_generation ||
            classifySessionProjectionMigrationScope(verifiedScope.ownership, verifiedScope.visibility) !== 'product') {
            throw new SessionProjectionScopeChangedError('session scope changed during canonical certification')
          }
          if (projection.source === 'legacy') return { kind: 'legacy' as const, reason: projection.reason }
          const history = new SqliteAgentHistory(conn)
          const cache = history.readCanonicalSessionTranscriptWithCache(item.session_id, 'transcript')
          const persistedCache = cache.kind === 'matched'
            ? history.readCanonicalSessionCache({ ...cache.watermark, cacheKey: 'transcript' })
            : undefined
          const persistedValue = persistedCache?.kind === 'hit' ? JSON.parse(persistedCache.value) as unknown : undefined
          if (cache.kind !== 'matched' || persistedCache?.kind !== 'hit' || !isDeepStrictEqual(persistedValue, cache.messages)) {
            return { kind: 'retry' as const, reason: 'projection-cache-not-durable-or-current' }
          }
          conn.prepare(`INSERT INTO canonical_session_projection_eligibility(session_id,session_generation,validated_at)
            VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET session_generation=excluded.session_generation,validated_at=excluded.validated_at`)
            .run(item.session_id, item.session_generation, now)
          const eligibility = conn.prepare('SELECT session_generation FROM canonical_session_projection_eligibility WHERE session_id=?')
            .get(item.session_id) as { session_generation: string } | undefined
          return eligibility?.session_generation === item.session_generation
            ? { kind: 'migrated' as const }
            : { kind: 'retry' as const, reason: 'projection-eligibility-not-durable-or-current' }
        })
        if (certification.kind === 'legacy') { status = 'legacy_required'; reason = certification.reason }
        else if (certification.kind === 'retry') { status = 'retry'; reason = certification.reason }
        else status = 'migrated'
      }
    } catch (caught) {
      status = 'retry'
      if (caught instanceof SessionProjectionScopeChangedError) {
        reason = 'session-scope-changed-during-certification'
        conn.prepare("UPDATE session_projection_migration_runs SET status='needs_attention',updated_at=? WHERE run_id=?").run(now, runId)
      } else error = caught instanceof Error ? caught.message : String(caught)
    }
  }
  runInTransaction(conn, () => {
    if (!status) throw new Error('session projection migration item was not classified')
    const policy = status === 'legacy_required' ? LEGACY_REQUIRED_POLICY : null
    conn.prepare(`UPDATE session_projection_migration_items SET status=?,reason=?,error=?,attempts=attempts+1,lease_owner=NULL,lease_until=NULL,updated_at=?,
      legacy_owner=?,legacy_decision=?,legacy_user_behavior=?,legacy_user_message_zh=?,legacy_user_message_en=?,legacy_decided_at=? WHERE run_id=? AND session_id=?`)
      .run(status, reason, error, now, policy?.owner ?? null, policy?.decision ?? null, policy?.userBehavior ?? null,
        policy?.userMessageZh ?? null, policy?.userMessageEn ?? null, policy ? now : null, runId, item.session_id)
  })
  const outcome = status === 'migrated' ? 'success' : status === 'retry' ? 'failure' : 'skipped'
  return { sessionId: item.session_id, status: status as SessionProjectionMigrationItemOutcome['status'], outcome,
    ...(reason ? { reason } : {}), ...(error ? { error } : {}) }
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function runSessionProjectionMigrationBatch(
  db: AppDatabase,
  runId: string,
  options: Readonly<{ batchSize?: number; rateLimitMs?: number; now?: number }> = {}
): Promise<SessionProjectionMigrationBatchResult> {
  const batchSize = options.batchSize ?? 20
  const rateLimitMs = options.rateLimitMs ?? 25
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new Error('batchSize must be an integer from 1 to 100')
  if (!Number.isFinite(rateLimitMs) || rateLimitMs < 0 || rateLimitMs > 60_000) throw new Error('rateLimitMs must be from 0 to 60000')
  let processedCount = 0
  const processedSessionIds = new Set<string>()
  const outcomes: SessionProjectionMigrationItemOutcome[] = []
  for (; processedCount < batchSize; processedCount += 1) {
    const now = (options.now ?? Date.now()) + processedCount
    const conn = getDbConnection(db)
    const claim = runInTransaction(conn, () => {
      const run = readRun(db, runId)
      if (!['running', 'needs_retry'].includes(run.status)) return null
      const excludedSessionIds = [...processedSessionIds]
      const exclusionSql = excludedSessionIds.length > 0
        ? `AND session_id NOT IN (${excludedSessionIds.map(() => '?').join(',')})`
        : ''
      const item = conn.prepare(`SELECT session_id,session_generation,source_disposition,status,reason FROM session_projection_migration_items
        WHERE run_id=? AND (status IN ('pending','retry','deferred_active') OR (status='processing' AND lease_until<=?))
        ${exclusionSql} ORDER BY session_id LIMIT 1`)
        .get(runId, now, ...excludedSessionIds) as ItemRow | undefined
      if (!item) return null
      const sessionScope = conn.prepare('SELECT ownership,visibility FROM sessions WHERE id=?').get(item.session_id) as
        { ownership: string | null; visibility: string | null } | undefined
      if (sessionScope && classifySessionProjectionMigrationScope(sessionScope.ownership, sessionScope.visibility) !== 'product') {
        const scope = `${sessionScope.ownership ?? 'null'}/${sessionScope.visibility ?? 'null'}`
        conn.prepare(`UPDATE session_projection_migration_items SET error=?,lease_owner=NULL,lease_until=NULL,updated_at=?
          WHERE run_id=? AND session_id=?`).run(`session-scope-changed:${scope}`, now, runId, item.session_id)
        conn.prepare("UPDATE session_projection_migration_runs SET status='needs_attention',updated_at=? WHERE run_id=?")
          .run(now, runId)
        return null
      }
      conn.prepare("UPDATE session_projection_migration_items SET status='processing',lease_owner=?,lease_until=?,updated_at=? WHERE run_id=? AND session_id=?")
        .run(`worker-${process.pid}`, now + 60_000, now, runId, item.session_id)
      conn.prepare('UPDATE session_projection_migration_runs SET after_session_id=CASE WHEN after_session_id IS NULL OR after_session_id<? THEN ? ELSE after_session_id END,updated_at=? WHERE run_id=?')
        .run(item.session_id, item.session_id, now, runId)
      return item
    })
    if (!claim) break
    processedSessionIds.add(claim.session_id)
    outcomes.push(await processItem(db, runId, claim, now))
    if (rateLimitMs > 0 && processedCount + 1 < batchSize) await wait(rateLimitMs)
  }
  const now = (options.now ?? Date.now()) + processedCount
  const run = runInTransaction(getDbConnection(db), () => finishRun(db, runId, now))
  return {
    ...toRun(run), processedCount,
    successCount: outcomes.filter(({ outcome }) => outcome === 'success').length,
    failureCount: outcomes.filter(({ outcome }) => outcome === 'failure').length,
    skippedCount: outcomes.filter(({ outcome }) => outcome === 'skipped').length,
    outcomes
  }
}

/** Create or resume a durable census run, execute bounded batches, and return per-session evidence. */
export async function runEligibleSessionProjectionMigration(
  db: AppDatabase,
  options: Readonly<{
    runId?: string
    knownSessionIds?: readonly string[]
    batchSize?: number
    rateLimitMs?: number
    now?: number
  }> = {}
): Promise<SessionProjectionMigrationExecutionReport> {
  const runId = options.runId ?? randomUUID()
  const initial = getDbConnection(db).prepare('SELECT 1 AS exists_flag FROM session_projection_migration_runs WHERE run_id=?').get(runId)
  const run = initial
    ? getSessionProjectionMigrationRun(db, runId)
    : startSessionProjectionMigration(db, buildSessionProjectionMigrationInventory(db,
      options.knownSessionIds ? { knownSessionIds: options.knownSessionIds } : {}), { runId, now: options.now })
  const outcomes: SessionProjectionMigrationItemOutcome[] = []
  let batchCount = 0
  let current = run
  while (current.status === 'running') {
    const batch = await runSessionProjectionMigrationBatch(db, runId, {
      ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
      ...(options.rateLimitMs !== undefined ? { rateLimitMs: options.rateLimitMs } : {}),
      ...(options.now !== undefined ? { now: options.now + batchCount } : {})
    })
    batchCount += 1
    outcomes.push(...batch.outcomes)
    current = batch
    if (batch.processedCount === 0 && batch.status === 'running') break
  }
  return {
    run: current, batchCount, processedCount: outcomes.length,
    successCount: outcomes.filter(({ outcome }) => outcome === 'success').length,
    failureCount: outcomes.filter(({ outcome }) => outcome === 'failure').length,
    skippedCount: outcomes.filter(({ outcome }) => outcome === 'skipped').length,
    outcomes
  }
}

export type SessionProjectionMigrationInventoryItem = SessionProjectionMigrationInventoryEntry
