import type { AppDatabase } from '../../../database/sqliteStore'
import { changesToNumber, runInTransaction } from '../../../database/transaction'
import { getDbConnection } from '../../../database/sqliteStore'
import { transitionProjectionState, type ProjectionStateCommand, type ProjectionStateRecord } from '../../domain/projectionState'
import type { ProjectionCacheCandidate, ProjectionStateStore } from '../../application/ports'
import { readProjectionSourceIdentity } from './projectionSourceIdentity'
import { projectionScopeSpecVersion } from '../../domain/scopeKey'
import type { ProjectionChatBodyCacheReadStore, ProjectionChatBodyCacheSnapshot } from '../../application/projectionChatBodyCacheReader'

export type DueProjectionWorkItem = Readonly<{ sessionId: string; sessionGeneration: string; scopeKey: string; specVersion: number }>

type ProjectionStateRow = {
  session_id: string
  scope_key: string
  session_generation: string
  status: ProjectionStateRecord['status']
  history_watermark_json: string | null
  message_revision: number | null
  payload_generation: string | null
  payload_digest: string | null
  validated_range_json: string | null
  source_identity_json: string | null
  process_generation: number | null
  rebuild_token: string | null
  failure_case_json: string | null
  attempts: number
  retry_after: number | null
  updated_at: number
}

function fromRow(row: ProjectionStateRow | undefined): ProjectionStateRecord | null {
  if (!row) return null
  return {
    sessionId: row.session_id, scopeKey: row.scope_key, sessionGeneration: row.session_generation,
    status: row.status, historyWatermarkJson: row.history_watermark_json, messageRevision: row.message_revision,
    payloadGeneration: row.payload_generation, payloadDigest: row.payload_digest,
    validatedRangeJson: row.validated_range_json, sourceIdentityJson: row.source_identity_json,
    processGeneration: row.process_generation, rebuildToken: row.rebuild_token,
    failureCaseJson: row.failure_case_json, attempts: row.attempts, retryAfter: row.retry_after, updatedAt: row.updated_at,
  }
}

function insertInvalid(db: AppDatabase, sessionId: string, scopeKey: string, sessionGeneration: string, now: number): ProjectionStateRecord | null {
  const conn = getDbConnection(db)
  const session = conn.prepare('SELECT generation FROM sessions WHERE id=?').get(sessionId) as { generation: string } | undefined
  if (!session || session.generation !== sessionGeneration) return null
  const current = fromRow(conn.prepare('SELECT * FROM session_projection_state WHERE session_id=? AND scope_key=?').get(sessionId, scopeKey) as ProjectionStateRow | undefined)
  if (current?.sessionGeneration === sessionGeneration) return current
  conn.prepare('DELETE FROM session_projection_cache WHERE session_id=? AND scope_key=?').run(sessionId, scopeKey)
  conn.prepare(`INSERT INTO session_projection_state(
    session_id,scope_key,session_generation,status,history_watermark_json,message_revision,payload_generation,
    payload_digest,validated_range_json,source_identity_json,process_generation,rebuild_token,failure_case_json,
    attempts,retry_after,updated_at
  ) VALUES(?,?,?,'invalid',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,?)
  ON CONFLICT(session_id,scope_key) DO UPDATE SET
    session_generation=excluded.session_generation,status='invalid',history_watermark_json=NULL,message_revision=NULL,
    payload_generation=NULL,payload_digest=NULL,validated_range_json=NULL,source_identity_json=NULL,
    process_generation=NULL,rebuild_token=NULL,failure_case_json=NULL,attempts=0,retry_after=NULL,updated_at=excluded.updated_at`)
    .run(sessionId, scopeKey, sessionGeneration, now)
  return fromRow(conn.prepare('SELECT * FROM session_projection_state WHERE session_id=? AND scope_key=?').get(sessionId, scopeKey) as ProjectionStateRow | undefined)
}

export function createSqliteProjectionStateStore(db: AppDatabase) {
  // Keep the AppDatabase handle, not a connection that may be retired by a
  // same-object close/reopen (for example during database compaction).
  const conn = () => getDbConnection(db)

  const readSourceIdentity = (sessionId: string, sessionGeneration: string): string | null =>
    readProjectionSourceIdentity(conn(), sessionId, sessionGeneration)

  const get = (sessionId: string, scopeKey: string): ProjectionStateRecord | null =>
    fromRow(conn().prepare('SELECT * FROM session_projection_state WHERE session_id=? AND scope_key=?').get(sessionId, scopeKey) as ProjectionStateRow | undefined)

  /** Enumerate only current-generation invalid or retry-due scopes with canonical scope identities. */
  const listDueWork = (now: number, limit = 64, processGeneration?: number): readonly DueProjectionWorkItem[] => {
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(limit) || limit < 1 || limit > 256 ||
      (processGeneration !== undefined && (!Number.isSafeInteger(processGeneration) || processGeneration < 0))) return Object.freeze([])
    const dueRows = conn().prepare(`SELECT state.session_id,state.session_generation,state.scope_key,COALESCE(state.retry_after,0) AS sort_retry,state.updated_at
      FROM session_projection_state state JOIN sessions ON sessions.id=state.session_id AND sessions.generation=state.session_generation
      WHERE state.status IN ('invalid','rejected') AND (state.retry_after IS NULL OR state.retry_after<=?)
        AND state.scope_key LIKE 'session-projection:%'
      ORDER BY COALESCE(state.retry_after,0),state.updated_at,state.session_id,state.scope_key LIMIT ?`).all(now, limit) as Array<{
        session_id: string; session_generation: string; scope_key: string; sort_retry: number; updated_at: number
      }>
    const takeoverRows = processGeneration === undefined ? [] : conn().prepare(`SELECT state.session_id,state.session_generation,state.scope_key,
        COALESCE(state.retry_after,0) AS sort_retry,state.updated_at
      FROM session_projection_state state JOIN sessions ON sessions.id=state.session_id AND sessions.generation=state.session_generation
      WHERE state.status='rebuilding' AND state.process_generation<? AND state.scope_key LIKE 'session-projection:%'
      ORDER BY state.process_generation,state.session_id,state.scope_key LIMIT ?`).all(processGeneration, limit) as Array<{
        session_id: string; session_generation: string; scope_key: string; sort_retry: number; updated_at: number
      }>
    const rows = [...dueRows, ...takeoverRows].sort((left, right) => left.sort_retry - right.sort_retry || left.updated_at - right.updated_at ||
      left.session_id.localeCompare(right.session_id) || left.scope_key.localeCompare(right.scope_key)).slice(0, limit)
    return Object.freeze(rows.flatMap((row) => {
      const specVersion = projectionScopeSpecVersion(row.scope_key)
      return specVersion === null ? [] : [Object.freeze({ sessionId: row.session_id,
        sessionGeneration: row.session_generation, scopeKey: row.scope_key, specVersion })]
    }).slice(0, limit))
  }

  const nextRetryAt = (now: number): number | null => {
    if (!Number.isSafeInteger(now)) return null
    const row = conn().prepare(`SELECT MIN(state.retry_after) AS retry_after
      FROM session_projection_state state JOIN sessions ON sessions.id=state.session_id AND sessions.generation=state.session_generation
      WHERE state.status='rejected' AND state.retry_after>? AND state.retry_after<? AND state.scope_key LIKE 'session-projection:%'`)
      .get(now, Number.MAX_SAFE_INTEGER) as
      { retry_after: number | null }
    return row?.retry_after ?? null
  }

  const readCheckpoint = (sessionId: string, scopeKey: string): string | null => {
    const row = conn().prepare('SELECT build_checkpoint_json FROM session_projection_state WHERE session_id=? AND scope_key=?')
      .get(sessionId, scopeKey) as { build_checkpoint_json: string | null } | undefined
    return row?.build_checkpoint_json ?? null
  }

  const saveCheckpoint = (input: Parameters<ProjectionStateStore['saveCheckpoint']>[0]): boolean => {
    const result = conn().prepare(`UPDATE session_projection_state SET build_checkpoint_json=?,updated_at=?
      WHERE session_id=? AND scope_key=? AND session_generation=? AND status='rebuilding'
        AND source_identity_json=? AND process_generation=? AND rebuild_token=?`)
      .run(input.checkpointJson, input.now, input.sessionId, input.scopeKey, input.sessionGeneration,
        input.sourceIdentityJson, input.processGeneration, input.rebuildToken)
    return changesToNumber(result.changes) === 1
  }

  const releaseLease = (input: Parameters<ProjectionStateStore['releaseLease']>[0]): boolean => {
    const result = conn().prepare(`UPDATE session_projection_state SET process_generation=process_generation-1,
        build_checkpoint_json=CASE WHEN json_valid(build_checkpoint_json)
          AND json_extract(build_checkpoint_json,'$.processGeneration')=process_generation
          AND json_extract(build_checkpoint_json,'$.rebuildToken')=rebuild_token
          THEN json_set(build_checkpoint_json,'$.processGeneration',process_generation-1)
          ELSE build_checkpoint_json END,
        updated_at=?
      WHERE session_id=? AND scope_key=? AND session_generation=? AND status='rebuilding'
        AND process_generation=? AND rebuild_token=? AND process_generation>0`)
      .run(input.now, input.sessionId, input.scopeKey, input.sessionGeneration, input.processGeneration, input.rebuildToken)
    return changesToNumber(result.changes) === 1
  }

  const ensureInvalid = (input: Readonly<{ sessionId: string; scopeKey: string; sessionGeneration: string; now: number }>): ProjectionStateRecord | null =>
    runInTransaction(conn(), () => insertInvalid(db, input.sessionId, input.scopeKey, input.sessionGeneration, input.now))

  const transition = (input: Readonly<{
    sessionId: string
    scopeKey: string
    sessionGeneration: string
    command: ProjectionStateCommand
    cache?: ProjectionCacheCandidate
  }>): ProjectionStateRecord | null => runInTransaction(conn(), () => {
    const current = insertInvalid(db, input.sessionId, input.scopeKey, input.sessionGeneration, input.command.now)
    if (!current) return null
    const sourceIdentityJson = readSourceIdentity(input.sessionId, input.sessionGeneration)
    if (sourceIdentityJson === null) return null
    if (input.command.type === 'publish') {
      let source: { formatVersion?: unknown; messageRevision?: unknown; historyWatermark?: unknown }
      try { source = JSON.parse(input.command.expectedSourceIdentityJson) as typeof source } catch { return null }
      if (source.formatVersion !== 1 || !Number.isSafeInteger(source.messageRevision) ||
        input.command.messageRevision !== source.messageRevision || input.command.historyWatermarkJson !== JSON.stringify(source.historyWatermark ?? null)) return null
    }
    const next = transitionProjectionState(current, input.command, sourceIdentityJson)
    if (!next) return null

    const update = conn().prepare(`UPDATE session_projection_state SET
      status=?,history_watermark_json=?,message_revision=?,payload_generation=?,payload_digest=?,validated_range_json=?,
      source_identity_json=?,process_generation=?,rebuild_token=?,failure_case_json=?,attempts=?,retry_after=?,updated_at=?
      WHERE session_id=? AND scope_key=? AND session_generation=? AND status=? AND process_generation IS ? AND rebuild_token IS ?`)
    const updateResult = update.run(
      next.status,next.historyWatermarkJson,next.messageRevision,next.payloadGeneration,next.payloadDigest,next.validatedRangeJson,
      next.sourceIdentityJson,next.processGeneration,next.rebuildToken,next.failureCaseJson,next.attempts,next.retryAfter,next.updatedAt,
      current.sessionId,current.scopeKey,current.sessionGeneration,current.status,current.processGeneration,current.rebuildToken
    )
    if (changesToNumber(updateResult.changes) !== 1) return null

    if (next.status === 'valid') {
      const cache = input.cache
      if (!cache || cache.sourceIdentityJson !== next.sourceIdentityJson || cache.payloadGeneration !== next.payloadGeneration ||
        cache.payloadDigest !== next.payloadDigest || cache.validatedRangeJson !== next.validatedRangeJson ||
        (cache.inlinePayload === undefined) === (cache.blobLocator === undefined) ||
        (cache.blobLocator !== undefined && (!Number.isSafeInteger(cache.blobByteLength) || cache.blobByteLength! <= 0))) {
        throw new Error('PROJECTION_CACHE_MANIFEST_MISMATCH')
      }
      conn().prepare(`INSERT INTO session_projection_cache(
        session_id,scope_key,payload_generation,source_identity_json,payload_digest,validated_range_json,inline_payload,blob_locator,blob_byte_length,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id,scope_key) DO UPDATE SET
        payload_generation=excluded.payload_generation,source_identity_json=excluded.source_identity_json,
        payload_digest=excluded.payload_digest,validated_range_json=excluded.validated_range_json,
        inline_payload=excluded.inline_payload,blob_locator=excluded.blob_locator,blob_byte_length=excluded.blob_byte_length,updated_at=excluded.updated_at`)
        .run(next.sessionId,next.scopeKey,cache.payloadGeneration,cache.sourceIdentityJson,cache.payloadDigest,cache.validatedRangeJson,
          cache.inlinePayload ?? null,cache.blobLocator ?? null,cache.blobByteLength ?? null,next.updatedAt)
    } else {
      conn().prepare('DELETE FROM session_projection_cache WHERE session_id=? AND scope_key=?').run(next.sessionId, next.scopeKey)
    }
    return next
  })

  const invalidateInTransaction = (input: Readonly<{ sessionId: string; scopeKey: string; sessionGeneration: string; now: number }>): ProjectionStateRecord | null =>
    transition({ ...input, command: { type: 'invalidate', sessionGeneration: input.sessionGeneration, now: input.now } })

  return Object.freeze({ get, listDueWork, nextRetryAt, readCheckpoint, saveCheckpoint, releaseLease, ensureInvalid, readSourceIdentity, transition, invalidateInTransaction })
}

/** Read and CAS-invalidate a final cache publication against a fresh source identity. */
export function createSqliteProjectionChatBodyCacheStore(db: AppDatabase): ProjectionChatBodyCacheReadStore {
  // Resolve the live connection for each operation because AppDatabase may be
  // reopened in place while these stores remain owned by long-lived services.
  const conn = () => getDbConnection(db)
  const readSnapshot = (sessionId: string, scopeKey: string): ProjectionChatBodyCacheSnapshot | null => runInTransaction(conn(), () => {
    const session = conn().prepare('SELECT generation FROM sessions WHERE id=?').get(sessionId) as { generation: string } | undefined
    const state = conn().prepare('SELECT session_generation,status,payload_generation,payload_digest,validated_range_json,source_identity_json FROM session_projection_state WHERE session_id=? AND scope_key=?')
      .get(sessionId, scopeKey) as { session_generation: string; status: ProjectionStateRecord['status']; payload_generation: string | null;
        payload_digest: string | null; validated_range_json: string | null; source_identity_json: string | null } | undefined
    if (!session || !state) return null
    const cache = conn().prepare('SELECT payload_generation,source_identity_json,payload_digest,validated_range_json,inline_payload,blob_locator,blob_byte_length FROM session_projection_cache WHERE session_id=? AND scope_key=?')
      .get(sessionId, scopeKey) as { payload_generation: string; source_identity_json: string; payload_digest: string; validated_range_json: string;
        inline_payload: string | null; blob_locator: string | null; blob_byte_length: number | null } | undefined
    const specVersion = projectionScopeSpecVersion(scopeKey)
    if (specVersion === null) return null
    const currentSourceIdentityJson = readProjectionSourceIdentity(conn(), sessionId, session.generation)
    return Object.freeze({ sessionId, sessionGeneration: state.session_generation, currentSessionGeneration: session.generation, scopeKey, specVersion, status: state.status, cachePresent: !!cache,
      sourceIdentityJson: cache?.source_identity_json ?? null, stateSourceIdentityJson: state.source_identity_json, currentSourceIdentityJson,
      payloadGeneration: cache?.payload_generation ?? null,
      payloadDigest: cache?.payload_digest ?? null,
      validatedRangeJson: cache?.validated_range_json ?? null,
      statePayloadGeneration: state.payload_generation, statePayloadDigest: state.payload_digest,
      stateValidatedRangeJson: state.validated_range_json,
      ...(cache?.inline_payload === null || cache?.inline_payload === undefined ? {} : { inlinePayload: cache.inline_payload }),
      ...(cache?.blob_locator === null || cache?.blob_locator === undefined ? {} : { blobLocator: cache.blob_locator }),
      ...(cache?.blob_byte_length === null || cache?.blob_byte_length === undefined ? {} : { blobByteLength: cache.blob_byte_length }) })
  })
  const invalidateObserved = (input: Parameters<ProjectionChatBodyCacheReadStore['invalidateObserved']>[0]): boolean => runInTransaction(conn(), () => {
    const result = conn().prepare(`UPDATE session_projection_state SET status='invalid',history_watermark_json=NULL,message_revision=NULL,
      payload_generation=NULL,payload_digest=NULL,validated_range_json=NULL,source_identity_json=NULL,process_generation=NULL,rebuild_token=NULL,
      failure_case_json=NULL,attempts=0,retry_after=NULL,updated_at=? WHERE session_id=? AND scope_key=? AND session_generation=?
      AND status='valid' AND source_identity_json=? AND payload_generation=? AND payload_digest=? AND validated_range_json=?
      AND EXISTS(SELECT 1 FROM sessions WHERE id=? AND generation=?)
      AND ((?=1 AND EXISTS(SELECT 1 FROM session_projection_cache WHERE session_id=? AND scope_key=? AND payload_generation=? AND source_identity_json=? AND payload_digest=? AND validated_range_json=?))
        OR (?=0 AND NOT EXISTS(SELECT 1 FROM session_projection_cache WHERE session_id=? AND scope_key=?)))`)
      .run(Date.now(), input.sessionId, input.scopeKey, input.sessionGeneration, input.stateSourceIdentityJson, input.statePayloadGeneration,
        input.statePayloadDigest, input.stateValidatedRangeJson, input.sessionId, input.sessionGeneration,
        input.cachePresent ? 1 : 0, input.sessionId, input.scopeKey, input.payloadGeneration, input.sourceIdentityJson, input.payloadDigest,
        input.validatedRangeJson, input.cachePresent ? 0 : 1, input.sessionId, input.scopeKey)
    if (changesToNumber(result.changes) !== 1) return false
    if (input.cachePresent) conn().prepare(`DELETE FROM session_projection_cache WHERE session_id=? AND scope_key=? AND payload_generation=?
      AND source_identity_json=? AND payload_digest=? AND validated_range_json=?`)
      .run(input.sessionId, input.scopeKey, input.payloadGeneration, input.sourceIdentityJson, input.payloadDigest, input.validatedRangeJson)
    return true
  })
  return Object.freeze({ readSnapshot, invalidateObserved })
}
